# Session Workspace & Thread Task Type Enforcement

**Date:** 2026-04-01
**Status:** Draft

## Overview

Two related changes to strengthen session semantics:

1. **Session-based workspace**: Tasks sharing the same `session_id` execute in a deterministic, persistent directory (`/var/tmp/local-agent/session/<session_id>`) instead of ephemeral per-job temp dirs. The directory persists across jobs — setup (marketplace cloning + setup hook) runs only on first use.

2. **Thread task type enforcement**: Messages in a Lark thread always inherit the task type from the thread root's bot reply. Using `/task <different_type>` in a thread is rejected with an error. This makes thread behavior deterministic and prevents accidental task type changes mid-conversation.

## Motivation

### Session Workspace

Currently, each job creates a fresh temp directory (`/tmp/localagent-job-<job_id>`), clones marketplaces, runs the setup hook, executes the task, and tears down the directory. This means:

- Every follow-up message in a thread re-clones repos and re-runs setup — wasteful when the session is the same.
- No state persists between jobs in the same session (e.g., files the executor created, git checkouts).
- Setup time adds latency to every job.

With session-based workspaces, the first job in a session pays the setup cost, and subsequent jobs in the same session reuse the environment instantly.

### Thread Task Type Enforcement

Currently, a user can send `/task deploy` as the first message in a thread, then follow up with `/task review` in the same thread. The enrichment poller only overrides `task_type` when it's `'generic'`, so the second message would be processed as `review` — breaking session consistency. By enforcing inheritance and rejecting conflicting `/task` commands, threads become fully deterministic.

## Design

### Sub-feature 1: Session-Based Workspace

#### Path Convention

```
/var/tmp/local-agent/session/<session_id>/
├── marketplaces/
│   └── <repo-name>/
│       └── <plugin-dir>/
└── (executor workspace — files persist across jobs)
```

The path is deterministic: given a `session_id`, the workspace is always `/var/tmp/local-agent/session/<session_id>`.

#### Directory Lifecycle

```
Job arrives with session_id
       │
       ▼
  Does /var/tmp/local-agent/session/<session_id> exist?
       │
  ┌────┴────┐
  │ YES     │ NO
  │         │
  │         ▼
  │    Create directory
  │    Clone marketplaces
  │    Run setup hook
  │         │
  └────┬────┘
       │
       ▼
  Return ExecutionEnvironment { workDir, pluginDirs }
       │
       ▼
  Execute job (all executor retries share this env)
       │
       ▼
  No teardown — directory persists
```

**Key rules:**
- If the directory exists, skip ALL setup (marketplace cloning + setup hook). Assume previous run completed successfully.
- If the directory does not exist, create it and run full setup.
- No cleanup/teardown. Directories remain permanently. Cleanup will be introduced in a future feature.
- Partial setup failure: if setup fails mid-way (e.g., clone error), the error handler removes the directory so the next attempt starts fresh.

#### Changes to `JobEnvironment`

**File:** `packages/daemon/task/src/services/job-environment.ts`

Current:
```typescript
async setup(job: Job): Promise<ExecutionEnvironment> {
  const workDir = join(tmpdir(), `localagent-job-${job.job_id}`);
  mkdirSync(workDir, { recursive: true });
  // ... clone + hook ...
}

async teardown(env: ExecutionEnvironment): Promise<void> {
  rmSync(env.workDir, { recursive: true, force: true });
}
```

New:
```typescript
private static readonly SESSION_BASE = '/var/tmp/local-agent/session';

async setup(job: Job): Promise<ExecutionEnvironment> {
  const workDir = join(JobEnvironment.SESSION_BASE, job.session_id);

  if (existsSync(workDir)) {
    logger.info({ job_id: job.job_id, session_id: job.session_id, workDir }, 'Reusing existing session workspace');
    const pluginDirs = this.collectPluginDirs(job, workDir);
    return { workDir, pluginDirs };
  }

  mkdirSync(workDir, { recursive: true });

  try {
    // Clone marketplaces + run setup hook (existing logic, unchanged)
    // ...
  } catch (error) {
    if (!this.debug) {
      rmSync(workDir, { recursive: true, force: true });
    }
    throw error;
  }

  return { workDir, pluginDirs };
}

async teardown(_env: ExecutionEnvironment): Promise<void> {
  // No-op: session directories persist for reuse (debug flag no longer relevant for teardown)
  logger.debug({ workDir: _env.workDir }, 'Teardown skipped — session workspace persists');
}
```

**`collectPluginDirs` helper:** Extract the existing marketplace iteration logic (lines 28-49 of current `setup()`) into a new private method `collectPluginDirs(job: Job, workDir: string): string[]` that walks `job.marketplaces`, builds `join(workDir, 'marketplaces', repoName, plugin)` for each plugin, and validates the paths exist. This is used both in the fresh-setup path and the reuse path.

**`debug` flag:** The existing `debug` flag is preserved for the setup-failure cleanup path (matching current behavior). It is no longer relevant for `teardown()` since teardown is always a no-op.

#### Changes to `SetupHookRunner`

**File:** `packages/daemon/task/src/services/setup-hook-runner.ts`

Add `LOCALAGENT_SESSION_ID` to the environment variables passed to the setup hook:

```typescript
const env = {
  ...process.env,
  LOCALAGENT_JOB_ID: jobContext.job_id,
  LOCALAGENT_TASK_ID: jobContext.task_id,
  LOCALAGENT_TASK_TYPE: jobContext.task_type,
  LOCALAGENT_PAYLOAD: jobContext.payload,
  LOCALAGENT_SESSION_ID: jobContext.session_id, // NEW
};
```

The `JobContext` interface must be extended to include `session_id: string`.

#### Changes to `TaskOrchestrator`

**File:** `packages/daemon/task/src/core/task-orchestrator.ts`

Refactor to call `setup()` once before the executor retry loop and remove per-attempt `teardown()`:

Current:
```typescript
for (let i = 0; i < job.executors.length; i++) {
  let env = await this.jobEnv.setup(job);
  try {
    // execute
  } finally {
    await this.jobEnv.teardown(env);
  }
}
```

New:
```typescript
let env: ExecutionEnvironment;
try {
  env = await this.jobEnv.setup(job);
} catch (error) {
  // return failure
}

for (let i = 0; i < job.executors.length; i++) {
  // execute using shared env
}
// No teardown call
```

### Sub-feature 2: Thread Task Type Enforcement

#### Inheritance Logic

In the enrichment poller, after fetching thread context:

```
Thread context fetched?
       │
  ┌────┴────┐
  │ NO      │ YES (inheritedTaskType exists)
  │         │
  │         ▼
  │    Is task.task_type == 'generic'?
  │    ┌────┴────┐
  │    │ YES     │ NO
  │    │         │
  │    │         ▼
  │    │    task.task_type == inheritedTaskType?
  │    │    ┌────┴────┐
  │    │    │ YES     │ NO
  │    │    │         │
  │    │    │         ▼
  │    │    │    REJECT: "Cannot change task type in a thread.
  │    │    │     This thread uses task_type '{inherited}'.
  │    │    │     Remove the /task prefix or start a new conversation."
  │    │    │
  │    └────┴────┘
  │         │
  │         ▼
  │    task.task_type = inheritedTaskType
  │         │
  └────┬────┘
       │
       ▼
  Continue enrichment
```

**Rules:**
1. If in a thread with `inheritedTaskType` and `task.task_type` is `'generic'` → accept, use inherited type.
2. If in a thread with `inheritedTaskType` and `task.task_type` matches inherited → accept, use inherited type.
3. If in a thread with `inheritedTaskType` and `task.task_type` differs → reject with descriptive error.
4. If not in a thread or no `inheritedTaskType` → keep current behavior.

#### Changes to `EnrichmentPoller`

**File:** `packages/daemon/task-enrichment/src/enrichment-poller.ts`

Replace the existing inheritance block (lines 40-43 of current code) that only handles `task_type === 'generic'`:

Current:
```typescript
if (task.task_type === 'generic' && threadResult.inheritedTaskType) {
  task.task_type = threadResult.inheritedTaskType;
  logger.info({ task_id: task.task_id, inherited_task_type: threadResult.inheritedTaskType }, 'Inherited task_type from thread root');
}
```

New (same location, before the `threadContext` prepend and before `enrichmentService.enrich()`):
```typescript
if (threadResult.inheritedTaskType) {
  if (task.task_type !== 'generic' && task.task_type !== threadResult.inheritedTaskType) {
    // Reject: /task used with a different type in a thread
    const reason = `Cannot change task type in a thread. This thread uses task_type '${threadResult.inheritedTaskType}'. Remove the /task prefix or start a new conversation.`;
    logger.warn({ task_id: task.task_id, submitted_type: task.task_type, inherited_type: threadResult.inheritedTaskType }, reason);
    await this.publishRejection(task, reason);
    await this.ackTask(task.task_id);
    return;
  }
  task.task_type = threadResult.inheritedTaskType;
  logger.info({ task_id: task.task_id, inherited_task_type: threadResult.inheritedTaskType }, 'Inherited task_type from thread');
}
```

This uses the existing `publishRejection()` and `ackTask()` methods already present in `EnrichmentPoller`. The rejection short-circuits before reaching `enrichmentService.enrich()`.

#### Rejection Flow

The rejection reuses the existing `publishRejection()` mechanism in the enrichment poller, which posts a result with `status: 'failure'`. The `lark-result` daemon picks up this result and replies in the Lark thread, so the user sees the error message.

## Affected Components

| Component | Change | File |
|-----------|--------|------|
| `JobEnvironment` | Session-based path, skip setup if exists, no-op teardown | `packages/daemon/task/src/services/job-environment.ts` |
| `SetupHookRunner` | Add `LOCALAGENT_SESSION_ID` env var, extend `JobContext` | `packages/daemon/task/src/services/setup-hook-runner.ts` |
| `TaskOrchestrator` | Setup once before retry loop, remove teardown | `packages/daemon/task/src/core/task-orchestrator.ts` |
| `EnrichmentPoller` | Thread task_type enforcement with rejection | `packages/daemon/task-enrichment/src/enrichment-poller.ts` |

## Out of Scope

- **Session directory cleanup/expiration** — deferred to a future feature.
- **Stale directory detection** — if a directory exists from a previous run that crashed mid-setup (e.g., process killed during clone), we assume it's valid and skip setup. A future cleanup feature can detect and handle stale/incomplete directories.
- **Concurrent job execution in the same session** — not addressed. If two jobs with the same session_id run concurrently, they share the directory. This is acceptable for the current single-worker architecture.

## Testing Strategy

### Unit Tests

1. **JobEnvironment.setup()**
   - New session: creates dir, clones, runs hook, returns env
   - Existing session: skips clone + hook, returns env with correct pluginDirs
   - Setup failure: removes directory, throws

2. **JobEnvironment.teardown()**
   - Verify it's a no-op (directory still exists after call)

3. **TaskOrchestrator.handle()**
   - Setup called once, not per executor attempt
   - Teardown not called

4. **EnrichmentPoller — thread task_type enforcement**
   - Generic message in thread → inherits type
   - `/task same_type` in thread → inherits type (accepted)
   - `/task different_type` in thread → rejected with error message
   - Non-thread message → no change to behavior
   - Thread with no inherited type → no change to behavior

### Integration Tests

- End-to-end: first message creates session dir, second message in thread reuses it
- Rejection message appears in Lark thread when /task conflicts
