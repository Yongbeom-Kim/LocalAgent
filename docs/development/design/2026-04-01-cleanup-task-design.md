# Design: /end Command and Cleanup Task Type

**Date:** 2026-04-01
**Status:** Draft
**Depends on:** Session ID Enrichment (implemented), Thread Context Enrichment (implemented), Session Workspace (implemented)

## Problem

Session workspaces under `/var/tmp/local-agent/session/<session_id>/` persist indefinitely after task execution. There is no user-facing mechanism to clean up a session's workspace when the user is done with it. Over time, these directories accumulate and consume disk space.

## Goal

Allow users to type `/end` in a Lark thread to clean up the session workspace associated with that thread. This introduces a new built-in task type `cleanup` that flows through the full pipeline and removes the session directory via `rm -rf`.

## Approach

**Approach 1 (chosen): Minimal — cleanup as a special-cased built-in task type.**

Follow the existing pipeline pattern end-to-end:

1. **Detect**: Lark-listener detects `/end` command, submits task with `task_type: 'cleanup'`
2. **Enrich**: Enrichment poller inherits `session_id` from thread context, skips thread context prepending for cleanup, enriches with `builtin` executor
3. **Execute**: Task daemon skips env setup for cleanup, routes to `CleanupExecutor` which runs `rm -rf` on the session directory
4. **Report**: Lark-result daemon replies with cleanup status (removed, not found, or error)

### Why full pipeline?

- Consistent with all other task types — no special plumbing
- Session ID inheritance from thread context is already implemented in enrichment
- Result reporting via lark-result daemon works automatically
- Audit trail: cleanup tasks appear in results like any other task

### Alternatives considered

- **Built-in task registry**: Centralized registry for skip-behavior config. Over-engineering for one built-in type (YAGNI).
- **Enrichment short-circuit**: Handle cleanup entirely in enrichment poller. Violates pipeline uniformity, mixes concerns.

## Design

### 1. New Executor Type: `builtin`

**File:** `packages/shared/src/types.ts`

Add `'builtin'` to the executor type union and `'none'` as its model:

```typescript
export const TASK_EXECUTORS = ['claude_code', 'ttadk', 'builtin'] as const;

export const EXECUTOR_MODELS = {
  claude_code: ['opus', 'sonnet', 'haiku'],
  ttadk: ['glm-5-ttadk', 'kimi-k2.5', 'glm-4.7-ttadk', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.2-codex'],
  builtin: ['none'],
} as const satisfies Record<TaskExecutorType, readonly string[]>;
```

### 2. Enrichment Config: `builtin.yaml`

**File:** `packages/daemon/task-enrichment/config/builtin.yaml`

```yaml
rules:
  cleanup:
    executors:
      - executor: builtin
        executor_model: none
```

No `system_prompt`, `marketplaces`, or `setup_hook` are specified. Note: the enrichment service will still set `system_prompt` to the global system prompt (this is its default behavior for all rules), but the cleanup executor ignores it.

### 3. Lark-Listener: Detect `/end` Command

**File:** `packages/daemon/lark-listener/src/message-handler.ts`

Extend `parseCommand()` to detect `/end` and return `task_type: 'cleanup'`:

```typescript
private parseCommand(payload: string): { taskType: string | null; taskPayload: string; isCommand: boolean } {
  // Detect /end command — must be exactly "/end" (no arguments)
  if (payload === '/end' || payload === '/end\n') {
    return { taskType: 'cleanup', taskPayload: '', isCommand: true };
  }

  // Reject /end with arguments
  if (payload.startsWith('/end ') || payload.startsWith('/end\n')) {
    return { taskType: null, taskPayload: '', isCommand: true };
    // isCommand: true + taskType: null triggers usage hint reply
  }

  // Existing /task logic...
  if (!payload.startsWith('/task ') && !payload.startsWith('/task\n') && payload !== '/task') {
    return { taskType: null, taskPayload: payload, isCommand: false };
  }
  // ...rest of existing /task parsing
}
```

Update the usage hint in `handle()` to cover both commands:

```typescript
if (isCommand && taskType === null) {
  await this.replier.reply(message_id, 'Usage: /task <type> <payload> or /end (in a thread)');
  return;
}
```

### 4. Enrichment Poller: Skip Thread Context for Cleanup

**File:** `packages/daemon/task-enrichment/src/enrichment-poller.ts`

When the task type is `cleanup`, the enrichment poller should:
1. Skip the task type mismatch check (cleanup is always valid regardless of the thread's inherited task type)
2. Still fetch thread context to inherit `session_id` (essential)
3. Skip prepending thread context to the payload (cleanup doesn't need it)
4. Reject the task if no `session_id` can be inherited (no session to clean up)

**Why skip the task type mismatch check:** The existing enrichment poller rejects tasks whose `task_type` differs from the thread's `inheritedTaskType`. Since cleanup is submitted as `task_type: 'cleanup'` but the thread's inherited type is the original task type (e.g., `code_review`), cleanup would be incorrectly rejected as a "task type change" without this exemption.

```typescript
// Inside the thread context block, BEFORE the task type inheritance/mismatch logic:

if (task.task_type === 'cleanup') {
  // Cleanup bypasses task type inheritance — it's always valid in any thread.
  // We only need the session_id from threadResult.
} else if (threadResult.inheritedTaskType) {
  // ... existing task type inheritance / mismatch logic (unchanged) ...
}

// Replace the existing thread context prepending with a cleanup-aware version:
if (task.task_type !== 'cleanup' && threadResult?.threadContext) {
  task.payload = `--- Thread Context ---\n${threadResult.threadContext}\n--- Current Message ---\n${task.payload}`;
  logger.info({ task_id: task.task_id }, 'Prepended thread context to payload');
}
```

After the thread context block, add the session_id rejection check:

```typescript
const sessionId = threadResult?.inheritedSessionId ?? generateSessionId();

// For cleanup tasks: reject if no inherited session_id
if (task.task_type === 'cleanup' && !threadResult?.inheritedSessionId) {
  const reason = 'No session found in this thread. Nothing to clean up.';
  logger.warn({ task_id: task.task_id }, reason);
  await this.publishRejection(task, reason);
  await this.ackTask(task.task_id);
  return;
}
```

### 5. Task Orchestrator: Skip Env Setup for Cleanup

**File:** `packages/daemon/task/src/core/task-orchestrator.ts`

The orchestrator should skip `jobEnv.setup()` for cleanup tasks. The cleanup executor only needs the `session_id` to derive the session directory path.

```typescript
async handle(job: Job): Promise<TaskResultSubmission> {
  // ... existing empty-executors check ...

  let env: ExecutionEnvironment;

  if (job.task_type === 'cleanup') {
    // Cleanup doesn't need environment setup — it removes the session directory
    env = { workDir: '', pluginDirs: [] };
  } else {
    try {
      env = await this.jobEnv.setup(job);
    } catch (error) {
      // ... existing error handling ...
    }
  }

  // ... rest of executor loop (unchanged) ...
}
```

### 6. CleanupExecutor

**File:** `packages/daemon/task/src/adapters/cleanup-executor.ts` (new file)

Implements `TaskExecutor` interface. Performs `rm -rf` on the session directory.

```typescript
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TaskResultSubmission, createLogger } from '@local-agent/shared';
import type { JobAttempt } from '@local-agent/shared';
import type { TaskExecutor } from '../ports/task-executor';
import type { ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:cleanup-executor');

const SESSION_BASE_DIR = '/var/tmp/local-agent/session';

export class CleanupExecutor implements TaskExecutor {
  async execute(attempt: JobAttempt, _env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    const sessionDir = join(SESSION_BASE_DIR, attempt.session_id);

    if (!existsSync(sessionDir)) {
      logger.info({ session_id: attempt.session_id, sessionDir }, 'Session directory not found');
      return {
        job_id: attempt.job_id,
        task_id: attempt.task_id,
        task_type: attempt.task_type,
        session_id: attempt.session_id,
        status: 'success',
        exit_code: 0,
        stdout: `Session directory not found (already cleaned or never created).\nPath: ${sessionDir}`,
        stderr: '',
      };
    }

    try {
      rmSync(sessionDir, { recursive: true, force: true });
      logger.info({ session_id: attempt.session_id, sessionDir }, 'Session directory removed');
      return {
        job_id: attempt.job_id,
        task_id: attempt.task_id,
        task_type: attempt.task_type,
        session_id: attempt.session_id,
        status: 'success',
        exit_code: 0,
        stdout: `Session cleaned up.\nRemoved: ${sessionDir}`,
        stderr: '',
      };
    } catch (error) {
      logger.error({ session_id: attempt.session_id, sessionDir, err: error }, 'Failed to remove session directory');
      return {
        job_id: attempt.job_id,
        task_id: attempt.task_id,
        task_type: attempt.task_type,
        session_id: attempt.session_id,
        status: 'failure',
        exit_code: 1,
        stdout: '',
        stderr: `Failed to remove session directory: ${error instanceof Error ? error.message : String(error)}\nPath: ${sessionDir}`,
      };
    }
  }
}
```

### 7. Register CleanupExecutor in Orchestrator

**File:** `packages/daemon/task/src/core/task-orchestrator.ts`

Add `'builtin'` to the executor resolver:

```typescript
import { CleanupExecutor } from '../adapters/cleanup-executor';

private resolveExecutor(executor: TaskExecutorType): TaskExecutor {
  if (executor === 'claude_code') return new ClaudeCliExecutor();
  if (executor === 'ttadk') return new TTADKExecutor();
  if (executor === 'builtin') return new CleanupExecutor();
  throw new Error(`Unknown executor: ${executor}`);
}
```

Note: The `'builtin'` executor always resolves to `CleanupExecutor` because the only built-in task type is `cleanup`. If future built-in types are added (e.g., `status`), this resolver would need to be refactored to dispatch based on `task_type`. For now, YAGNI.

## Data Flow

### Happy path: `/end` in a thread with an active session

```
[User sends "/end" in Lark thread]
         |
         v
[lark-listener]
  parseCommand("/end") → { taskType: 'cleanup', taskPayload: '', isCommand: true }
  submit('cleanup', '', { source: 'lark', message_id })
         |
         v
POST /tasks { task_type: 'cleanup', payload: '', task_source: { source: 'lark', message_id } }
         |
         v
[enrichment-poller]
  1. Fetch thread messages via Lark API
  2. Extract session_id from bot reply → e.g., '019...'
  3. Bypass task type mismatch check (cleanup is always valid)
  4. Skip thread context prepending (task_type === 'cleanup')
  5. enrich(task, '019...') → JobSubmission with executor: builtin, model: none
         |
         v
POST /jobs { task_type: 'cleanup', session_id: '019...', executors: [{ executor: 'builtin', executor_model: 'none' }], ... }
         |
         v
[task-daemon]
  1. Detect task_type === 'cleanup' → skip jobEnv.setup()
  2. Resolve executor 'builtin' → CleanupExecutor
  3. CleanupExecutor.execute():
     - sessionDir = '/var/tmp/local-agent/session/019...'
     - rmSync(sessionDir, { recursive: true, force: true })
  4. Return TaskResultSubmission { status: 'success', stdout: 'Session cleaned up.\nRemoved: /var/tmp/...' }
         |
         v
[lark-result daemon]
  Reply in thread:
    Task ID: ...
    Job ID: ...
    task_type: cleanup
    session_id: 019...
    status: success
    Exit code: 0
    Output:
    Session cleaned up.
    Removed: /var/tmp/local-agent/session/019...
```

### Error path: `/end` in a thread with no session

```
[User sends "/end" in Lark thread with no prior bot reply]
         |
         v
[enrichment-poller]
  1. Fetch thread messages — no bot message with session_id tag
  2. No inherited session_id
  3. task_type === 'cleanup' + no inherited session_id → REJECT
  4. Publish rejection: "No session found in this thread. Nothing to clean up."
         |
         v
[lark-result daemon]
  Reply in thread:
    Task ID: ...
    task_type: cleanup
    status: failure
    Output:
    No session found in this thread. Nothing to clean up.
```

### After cleanup: thread remains usable

```
[User sends new message in same thread after /end]
         |
         v
[enrichment-poller]
  1. Fetch thread messages — finds old bot reply with session_id tag
  2. Inherits old session_id '019...'
  3. Enrich as normal
         |
         v
[task-daemon]
  1. jobEnv.setup() → directory doesn't exist → creates fresh
  2. Execute normally with new workspace
```

## Files Changed

| File | Change |
|------|--------|
| `packages/shared/src/types.ts` | Add `'builtin'` to `TASK_EXECUTORS`, add `builtin: ['none']` to `EXECUTOR_MODELS` |
| `packages/daemon/task-enrichment/config/builtin.yaml` | New file: cleanup enrichment rule |
| `packages/daemon/lark-listener/src/message-handler.ts` | Detect `/end` command in `parseCommand()`, update usage hint |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Bypass task type mismatch check for cleanup, skip thread context prepending, reject cleanup without inherited session_id |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Skip env setup for cleanup, register `CleanupExecutor` for `'builtin'` executor |
| `packages/daemon/task/src/adapters/cleanup-executor.ts` | New file: `CleanupExecutor` implementing `TaskExecutor` |

## Test Plan

1. **Unit: `parseCommand()`** — verify `/end` returns `{ taskType: 'cleanup', taskPayload: '', isCommand: true }`; `/end foo` returns usage hint; `/ending` is not matched
2. **Unit: `CleanupExecutor`** — verify rm -rf on existing directory returns success with path; missing directory returns success with "not found" note; permission error returns failure
3. **Unit: `EnrichmentPoller` cleanup rejection** — verify cleanup task without inherited session_id is rejected with correct message
4. **Unit: `EnrichmentPoller` cleanup skip context** — verify thread context is not prepended for cleanup tasks
5. **Unit: `EnrichmentPoller` cleanup bypasses task type mismatch** — verify cleanup task in a thread with a different `inheritedTaskType` (e.g., `code_review`) is NOT rejected as a task type mismatch
6. **Unit: `TaskOrchestrator` cleanup skip setup** — verify `jobEnv.setup()` is not called for cleanup tasks
7. **Unit: `EnrichmentService`** — verify `cleanup` rule enriches correctly with `builtin` executor and `none` model

## Edge Cases

- **`/end` in a standalone message (not a thread)**: No thread context available → no inherited session_id → enrichment rejects with "No session found"
- **`/end` in a thread before any task ran**: No bot reply with session_id → enrichment rejects with "No session found"
- **`/end` twice in same thread**: First call removes directory. Second call succeeds with "not found" note (idempotent)
- **Session directory has open file handles**: `rmSync` with `force: true` handles most cases on Linux/macOS. If a process is actively writing, the delete succeeds but the process may get errors. This is acceptable — cleanup is an explicit user action
- **`/end` with arguments** (e.g., `/end now`): Returns usage hint — bare `/end` only
- **New message in thread after `/end`**: Thread remains usable. Old session_id is inherited, but directory is gone → `jobEnv.setup()` creates a fresh workspace
