# Session Continuation & History/Payload Split

**Date:** 2026-04-01
**Status:** Draft

## Overview

Two related changes to improve session continuity and reduce redundant context injection:

1. **History/Payload split on JobSubmission**: Separate the thread context (conversation history) from the current user message into distinct `history` and `payload` fields. Currently they are concatenated into a single `payload` string in the enrichment poller.

2. **Session continuation via `--continue`**: When a session workspace already exists, executors first attempt to resume the previous Claude session with `--continue`, piping only the current `payload`. If `--continue` fails (non-zero exit), the executor falls back to creating a fresh session with `history + payload` combined. Setup hooks are already skipped for existing workspaces (implemented in session workspace design).

## Motivation

### Why split history from payload?

Currently, the enrichment poller concatenates thread context and current message into one string:
```
--- Thread Context ---
user: message 1
assistant: response 1
--- Current Message ---
message 2
```

This is wasteful when `--continue` succeeds — Claude already has the conversation context from its previous session. Separating `history` from `payload` lets executors:
- Skip history entirely when continuing a session (Claude already knows the context).
- Include history only when starting fresh (first message, or continue-failure fallback).

### Why `--continue`?

Follow-up messages in a Lark thread share a `session_id` and reuse the same workspace directory. But currently, every job spawns a brand-new Claude process that has no memory of previous interactions. With `--continue`, the executor resumes the existing Claude session, preserving the full conversation context, tool state, and working memory — without re-injecting thread history.

## Design

### Approach: Executor-Level Continue-with-Fallback

The executor handles the entire continue-or-fresh logic internally. `ExecutionEnvironment` gains an `isExistingWorkspace` boolean. Executors try `--continue` when the workspace exists, fall back to a fresh session with `history + payload` on failure.

### Sub-feature 1: History/Payload Split

#### Type Changes

**File:** `packages/shared/src/types.ts`

Add optional `history` field to `JobSubmission`, `Job`, and `JobAttempt`:

```typescript
export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  history?: string;           // NEW — thread context, absent for first message
  executors: ExecutorPreference[];
  submitted_at: string;
  session_id: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}

export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  history?: string;           // NEW
  executors: ExecutorPreference[];
  submitted_at: string;
  enriched_at: string;
  session_id: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}

export interface JobAttempt {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  history?: string;           // NEW
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
  enriched_at: string;
  session_id: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
}
```

**`TaskSubmission` and `Task` are unchanged.** The split happens at the Job level only. The enrichment poller is the boundary where thread context is separated into `history`.

#### Enrichment Poller Changes

**File:** `packages/daemon/task-enrichment/src/enrichment-poller.ts`

Currently (lines 59-61):
```typescript
if (threadResult.threadContext) {
  task.payload = `--- Thread Context ---\n${threadResult.threadContext}\n--- Current Message ---\n${task.payload}`;
}
```

New: Stop concatenating thread context into `task.payload`. Instead, pass it separately to the enrichment service:

```typescript
let threadHistory: string | undefined;
if (threadResult?.threadContext) {
  threadHistory = threadResult.threadContext;
  logger.info({ task_id: task.task_id }, 'Extracted thread context as history');
}
```

Then pass `threadHistory` to `enrichmentService.enrich()`:

```typescript
const enrichmentResult = this.enrichmentService.enrich(task, sessionId, threadHistory);
```

#### Enrichment Service Changes

**File:** `packages/daemon/task-enrichment/src/enrichment-service.ts`

Update `enrich()` signature and output:

```typescript
enrich(task: Task, sessionId: string, history?: string): EnrichmentResult {
  // ... existing validation ...
  return {
    type: 'enriched',
    job: {
      // ... existing fields ...
      payload: task.payload,
      ...(history ? { history } : {}),
      // ... rest ...
    },
  };
}
```

#### API Route Changes

**File:** `packages/api/src/routes/jobs.ts`

Extract `history` from request body and pass it through to the Job object:

```typescript
const { task_id, task_type, payload, history, executors, ... } = req.body;

// No validation on history — optional pass-through string

const job: Job = {
  // ... existing fields ...
  payload,
  ...(history ? { history } : {}),
  // ... rest ...
};
```

#### Orchestrator Changes

**File:** `packages/daemon/task/src/core/task-orchestrator.ts`

Pass `history` through to `JobAttempt`:

```typescript
const attempt: JobAttempt = {
  // ... existing fields ...
  payload: job.payload,
  history: job.history,
  // ... rest ...
};
```

### Sub-feature 2: Session Continuation

#### ExecutionEnvironment Changes

**File:** `packages/daemon/task/src/services/job-environment.ts`

Add `isExistingWorkspace` to the interface:

```typescript
export interface ExecutionEnvironment {
  workDir: string;
  pluginDirs: string[];
  isExistingWorkspace: boolean;   // NEW
}
```

Update `setup()` to set this flag:

```typescript
async setup(job: Job): Promise<ExecutionEnvironment> {
  const workDir = join('/var/tmp/local-agent/session', job.session_id);

  if (existsSync(workDir)) {
    const pluginDirs = this.collectPluginDirs(job, workDir);
    logger.info({ ... }, 'Reusing session workspace');
    return { workDir, pluginDirs, isExistingWorkspace: true };
  }

  // ... fresh setup ...
  return { workDir, pluginDirs, isExistingWorkspace: false };
}
```

#### ClaudeCliExecutor Changes

**File:** `packages/daemon/task/src/adapters/claude-cli-executor.ts`

New execution flow:

```
isExistingWorkspace?
    │
┌───┴───┐
│ YES   │ NO
│       │
▼       ▼
Try --continue -p -       Spawn fresh: -p -
pipe payload only         pipe history + payload
    │                         │
    ▼                         │
Non-zero exit?                │
    │                         │
┌───┴───┐                     │
│ YES   │ NO                  │
│       │                     │
▼       ▼                     │
Warn log   Return result      │
Spawn fresh: -p -             │
pipe history + payload        │
    │       │                 │
    └───────┴─────────────────┘
                │
                ▼
          Return result
```

Implementation:

```typescript
async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
  if (!job.payload) {
    // ... existing empty payload handling ...
  }

  if (env.isExistingWorkspace) {
    const continueResult = await this.spawnClaude(job, env, { continue: true, includeHistory: false });
    if (continueResult.status === 'success') {
      return continueResult;
    }
    logger.warn(
      { job_id: job.job_id, session_id: job.session_id, exit_code: continueResult.exit_code },
      'Claude --continue failed, falling back to fresh session',
    );
  }

  return this.spawnClaude(job, env, { continue: false, includeHistory: true });
}
```

The `spawnClaude` helper builds args and pipes input:

```typescript
private spawnClaude(
  job: JobAttempt,
  env: ExecutionEnvironment,
  opts: { continue: boolean; includeHistory: boolean },
): Promise<TaskResultSubmission> {
  const args = [
    '--dangerously-skip-permissions',
    '--model', job.executor_model,
    ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
    ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
    ...(opts.continue ? ['--continue'] : []),
    '-p', '-',
  ];

  const input = opts.includeHistory && job.history
    ? `--- Thread Context ---\n${job.history}\n--- Current Message ---\n${job.payload}`
    : job.payload;

  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: env.workDir });
    // ... existing stdout/stderr collection ...
    child.stdin.write(input);
    child.stdin.end();
    // ... existing close/error handlers ...
  });
}
```

#### TTADKExecutor Changes

**File:** `packages/daemon/task/src/adapters/ttadk-executor.ts`

Same continue-with-fallback pattern, adapted for TTADK's `-a` flag interface:

```typescript
async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
  if (!job.payload) {
    // ... existing empty payload handling ...
  }

  if (env.isExistingWorkspace) {
    const continueResult = await this.spawnTtadk(job, env, { continue: true, includeHistory: false });
    if (continueResult.status === 'success') {
      return continueResult;
    }
    logger.warn(
      { job_id: job.job_id, session_id: job.session_id, exit_code: continueResult.exit_code },
      'TTADK --continue failed, falling back to fresh session',
    );
  }

  return this.spawnTtadk(job, env, { continue: false, includeHistory: true });
}
```

The `spawnTtadk` helper:

```typescript
private spawnTtadk(
  job: JobAttempt,
  env: ExecutionEnvironment,
  opts: { continue: boolean; includeHistory: boolean },
): Promise<TaskResultSubmission> {
  const input = opts.includeHistory && job.history
    ? `--- Thread Context ---\n${job.history}\n--- Current Message ---\n${job.payload}`
    : job.payload;

  const claudeArgs = [
    '--bare',
    '--dangerously-skip-permissions',
    ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
    ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
    ...(opts.continue ? ['--continue'] : []),
    '-p', input,
  ].join(' ');

  const args = ['code', '-t', 'claude', '-m', job.executor_model, '-a', claudeArgs];

  return new Promise((resolve) => {
    execFile('ttadk', args, { maxBuffer: 50 * 1024 * 1024, cwd: env.workDir }, (error, stdout, stderr) => {
      // ... existing result handling ...
    });
  });
}
```

## Affected Components

| Component | Change | File |
|-----------|--------|------|
| Types | Add `history?: string` to `JobSubmission`, `Job`, `JobAttempt` | `packages/shared/src/types.ts` |
| `ExecutionEnvironment` | Add `isExistingWorkspace: boolean` | `packages/daemon/task/src/services/job-environment.ts` |
| `JobEnvironment.setup()` | Set `isExistingWorkspace` flag | `packages/daemon/task/src/services/job-environment.ts` |
| `EnrichmentPoller` | Stop concatenating thread context into payload; pass as separate `history` | `packages/daemon/task-enrichment/src/enrichment-poller.ts` |
| `EnrichmentService.enrich()` | Accept `history` param, include in `JobSubmission` | `packages/daemon/task-enrichment/src/enrichment-service.ts` |
| API route `POST /jobs` | Extract and pass through `history` field | `packages/api/src/routes/jobs.ts` |
| `TaskOrchestrator` | Pass `history` to `JobAttempt` | `packages/daemon/task/src/core/task-orchestrator.ts` |
| `ClaudeCliExecutor` | Continue-with-fallback logic, `spawnClaude` helper | `packages/daemon/task/src/adapters/claude-cli-executor.ts` |
| `TTADKExecutor` | Continue-with-fallback logic, `spawnTtadk` helper | `packages/daemon/task/src/adapters/ttadk-executor.ts` |

## Data Flow

```
Lark thread message arrives
        │
        ▼
EnrichmentPoller.pollOnce()
        │
        ▼
ThreadContextFetcher → threadContext (string), inheritedSessionId
        │
        ▼
EnrichmentService.enrich(task, sessionId, threadContext)
        │
        ▼
JobSubmission { payload: "current msg", history: "user: msg1\nassistant: resp1" }
        │
        ▼
POST /jobs → Job queued to RabbitMQ
        │
        ▼
TaskOrchestrator.handle(job)
        │
        ▼
JobEnvironment.setup(job) → { workDir, pluginDirs, isExistingWorkspace }
        │
        ▼
Executor.execute(attempt, env)
        │
        ├── isExistingWorkspace = true
        │       │
        │       ▼
        │   Try: claude --continue -p - (payload only)
        │       │
        │       ├── success → return result
        │       └── failure → warn log
        │               │
        │               ▼
        │           Fresh: claude -p - (history + payload)
        │               │
        │               └── return result
        │
        └── isExistingWorkspace = false
                │
                ▼
            Fresh: claude -p - (history + payload)
                │
                └── return result
```

## Out of Scope

- **`TaskSubmission` / `Task` type changes** — the history/payload split only exists at the Job level. Tasks keep a single `payload`.
- **History gap detection** — when `--continue` succeeds, we trust Claude has full context. No attempt to detect missed messages.
- **Setup hook changes** — hooks already skip on existing workspace. The `LOCALAGENT_PAYLOAD` env var continues to receive only the payload (not history).
- **Session directory cleanup** — deferred to a future feature (same as session workspace design).

## Testing Strategy

### Unit Tests

1. **EnrichmentPoller**
   - Thread message → `history` populated, `payload` unchanged (not concatenated)
   - Non-thread message → `history` absent, `payload` unchanged
   - Thread with no context → `history` absent

2. **EnrichmentService.enrich()**
   - With history → `JobSubmission.history` set
   - Without history → `JobSubmission.history` absent

3. **JobEnvironment.setup()**
   - Existing workspace → `isExistingWorkspace: true`
   - New workspace → `isExistingWorkspace: false`

4. **ClaudeCliExecutor**
   - `isExistingWorkspace=true` → spawns with `--continue`, pipes payload only
   - `--continue` fails → fallback spawns without `--continue`, pipes history + payload
   - `isExistingWorkspace=false` → spawns without `--continue`, pipes history + payload
   - No history → pipes payload only regardless of mode

5. **TTADKExecutor**
   - Same cases as ClaudeCliExecutor but via `-a` flag

6. **API route POST /jobs**
   - With `history` → included in Job
   - Without `history` → Job has no `history` field

7. **TaskOrchestrator**
   - `history` passed through to `JobAttempt`
