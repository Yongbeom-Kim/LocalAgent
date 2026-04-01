# Design: Session Directory Garbage Collection (`/gc`)

**Date:** 2026-04-01
**Status:** Draft
**Depends on:** Session Workspace (implemented), Session ID Enrichment (implemented)

## Problem

Session directories under `/var/tmp/local-agent/session/<session_id>/` persist indefinitely after creation. Over time, stale session directories accumulate disk space. There is no mechanism to clean them up.

## Goal

Add a `/gc` slash command that, when sent as a **base message** (not a thread reply), triggers garbage collection of session directories older than 7 days. The command flows through the existing task pipeline and returns a plain-text summary of the cleanup to the user via Lark.

## Constraints

- **Thread rejection:** `/gc` must be rejected with an error message if sent inside a thread. Detection uses the existing thread context fetcher in the enrichment daemon.
- **No arguments:** `/gc` is always bare — no custom TTL or flags. TTL is hardcoded to 7 days.
- **Staleness check:** A session directory is stale only if **both** `mtime` and `atime` are older than 7 days.
- **No active-session check:** We rely on the time-based check. Active sessions will always have recent mtime/atime.
- **Skip job environment setup:** GC jobs do not need a workspace, marketplace clones, or setup hooks.

## Approach

### Pipeline Flow

```
User sends "/gc" in Lark (base message)
  → lark-listener: parseCommand detects /gc → submits task with task_type='gc'
  → enrichment-daemon: detects task_type='gc'
    → if thread reply → reject with error message
    → else → create minimal JobSubmission (no enrichment, no marketplace, no system prompt)
  → task-daemon: detects task_type='gc'
    → skip JobEnvironment.setup()
    → run GcExecutor: scan, check timestamps, remove stale dirs
    → return TaskResultSubmission with summary
  → lark-result-daemon: sends summary as Lark reply
```

### Why this approach?

- Reuses the existing task pipeline end-to-end. No new infrastructure.
- Respects separation of concerns: enrichment daemon routes, task-daemon executes.
- Thread rejection reuses the existing enrichment daemon pattern (same as task_type mismatch rejection).
- Lark reply works automatically via lark-result-daemon.

## Design

### 1. Shared Constants

Add to `packages/shared/src/constants.ts`:

```typescript
export const SESSION_BASE_DIR = '/var/tmp/local-agent/session';
export const SESSION_DIR_TTL_DAYS = 7;
```

Update `packages/daemon/task/src/services/job-environment.ts` to use `SESSION_BASE_DIR` instead of the hardcoded path string.

### 2. Lark-Listener: Parse `/gc` Command

Extend `MessageHandler.parseCommand()` to detect `/gc`:

```typescript
private parseCommand(payload: string): { taskType: string | null; taskPayload: string; isCommand: boolean } {
  // Check /gc first — must be exactly "/gc" with no arguments
  if (payload === '/gc') {
    return { taskType: 'gc', taskPayload: '', isCommand: true };
  }

  // Existing /task parsing...
  if (!payload.startsWith('/task ') && !payload.startsWith('/task\n') && payload !== '/task') {
    return { taskType: null, taskPayload: payload, isCommand: false };
  }
  // ... rest unchanged
}
```

Key behaviors:
- Only exact `/gc` is recognized (not `/gc foo` or `/gcollect`)
- Returns `task_type: 'gc'` with empty payload
- Flows into the existing submit path

### 3. Enrichment Daemon: Dedicated GC Code Path

In `EnrichmentPoller.pollOnce()`, add a check **before** calling `this.enrichmentService.enrich()`:

```typescript
// After thread context fetching, before enrichment:
if (task.task_type === 'gc') {
  // Reject if in a thread
  if (threadResult?.inheritedTaskType || threadResult?.inheritedSessionId) {
    const reason = 'The /gc command can only be used as a base message, not inside a thread.';
    await this.publishRejection(task, reason);
    await this.ackTask(task.task_id);
    return;
  }

  // Create minimal job — no enrichment needed
  const gcJob: JobSubmission = {
    task_id: task.task_id,
    task_type: 'gc',
    payload: '',
    executors: [{ executor: 'claude_code', executor_model: 'sonnet' }], // placeholder, not used
    submitted_at: task.submitted_at,
    session_id: generateSessionId(),
    ...(task.task_source ? { task_source: task.task_source } : {}),
  };

  // POST to /jobs (same pattern as the existing enrichment path below)
  const jobRes = await fetch(`${this.apiUrl}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gcJob),
  });
  if (jobRes.status !== 201) {
    logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed for GC job — not acking task');
    return;
  }

  await this.ackTask(task.task_id);
  return;
}
```

The `executors` field uses a placeholder value because the `Job` type requires a non-empty array. The task-daemon will never use it — it short-circuits for gc jobs.

**Thread detection logic:** The enrichment daemon already fetches thread context for Lark messages. If `threadResult` contains inherited data, the message is a thread reply. If `threadResult` is null (no root_id) or has no inherited fields, it's a base message.

### 4. Task-Daemon: GC Job Routing

In `TaskOrchestrator.handle()`, add a check **before** environment setup:

```typescript
async handle(job: Job): Promise<TaskResultSubmission> {
  // Short-circuit for GC jobs — no environment setup needed
  if (job.task_type === 'gc') {
    const gcExecutor = new GcExecutor();
    return gcExecutor.execute(job);
  }

  // ... existing executor pipeline
}
```

### 5. GcExecutor Implementation

New file: `packages/daemon/task/src/services/gc-executor.ts`

```typescript
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Job, TaskResultSubmission, SESSION_BASE_DIR, SESSION_DIR_TTL_DAYS, createLogger } from '@local-agent/shared';

const logger = createLogger('task-daemon:gc-executor');

export class GcExecutor {
  execute(job: Job): TaskResultSubmission {
    const baseResult = {
      job_id: job.job_id,
      task_id: job.task_id,
      task_type: job.task_type,
      exit_code: 0,
      stderr: '',
      ...(job.task_source ? { task_source: job.task_source } : {}),
    };

    if (!existsSync(SESSION_BASE_DIR)) {
      return {
        ...baseResult,
        status: 'success',
        stdout: 'GC complete: no session directories found.',
      };
    }

    const cutoffMs = Date.now() - SESSION_DIR_TTL_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    let retained = 0;
    let errors = 0;

    const entries = readdirSync(SESSION_BASE_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = join(SESSION_BASE_DIR, entry.name);
      try {
        const stats = statSync(dirPath);
        const mtimeMs = stats.mtimeMs;
        const atimeMs = stats.atimeMs;

        if (mtimeMs < cutoffMs && atimeMs < cutoffMs) {
          rmSync(dirPath, { recursive: true, force: true });
          logger.info({ session_dir: entry.name }, 'Removed stale session directory');
          removed++;
        } else {
          retained++;
        }
      } catch (err) {
        logger.error({ session_dir: entry.name, err }, 'Failed to process session directory');
        errors++;
      }
    }

    const summary = `GC complete: removed ${removed} session(s), retained ${retained}.${errors > 0 ? ` Errors: ${errors}.` : ''}`;
    logger.info({ removed, retained, errors }, summary);

    return {
      ...baseResult,
      status: 'success',
      stdout: summary,
    };
  }
}
```

### 6. Refactor: Use SESSION_BASE_DIR Constant

Update `job-environment.ts` line 21 to use the shared constant:

```typescript
// Before:
const workDir = join('/var/tmp/local-agent/session', job.session_id);

// After:
import { SESSION_BASE_DIR } from '@local-agent/shared';
const workDir = join(SESSION_BASE_DIR, job.session_id);
```

## Affected Components

| Package | File | Change |
|---------|------|--------|
| `@local-agent/shared` | `src/constants.ts` | Add `SESSION_BASE_DIR`, `SESSION_DIR_TTL_DAYS` |
| `@local-agent/shared` | `src/index.ts` | Re-export new constants |
| `@local-agent/lark-listener` | `src/message-handler.ts` | Detect `/gc` in `parseCommand()` |
| `@local-agent/task-enrichment` | `src/enrichment-poller.ts` | Dedicated GC code path: thread rejection + minimal job creation |
| `@local-agent/task-daemon` | `src/core/task-orchestrator.ts` | Short-circuit GC jobs before environment setup |
| `@local-agent/task-daemon` | `src/services/gc-executor.ts` | New file: GC cleanup logic |
| `@local-agent/task-daemon` | `src/services/job-environment.ts` | Use `SESSION_BASE_DIR` constant |

## Test Plan

1. **Unit: MessageHandler.parseCommand()** — `/gc` returns `{ taskType: 'gc', taskPayload: '', isCommand: true }`. `/gcollect`, `/gc foo` are NOT recognized as gc commands.
2. **Unit: EnrichmentPoller** — gc task in thread → rejected with error. gc task as base message → minimal job published.
3. **Unit: TaskOrchestrator** — gc job → GcExecutor called, no environment setup.
4. **Unit: GcExecutor** — empty base dir → success with zero count. Mix of stale/fresh dirs → only stale removed. Both mtime and atime checked.
5. **Integration:** Send `/gc` in Lark base message → receive summary reply. Send `/gc` in thread → receive rejection error.
