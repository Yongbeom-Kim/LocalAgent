# Design: `/end` Should Respect Same-Session Lock Requeueing

**Date:** 2026-04-03
**Status:** Draft
**Depends on:** Concurrent Session Execution (implemented), `/end` Command and Cleanup Task Type (implemented), Session ID Enrichment (implemented)

## Problem

The intended model for same-session work is already clear in the current system:

- tasks in different sessions may run concurrently;
- tasks in the same session must serialize behind the session lock;
- a blocked job is NACKed and requeued by the task poller until the session becomes free.

`/end` should follow that exact contract because it becomes a normal `cleanup` job after enrichment. In practice, there is a gap in the lock implementation: `SessionLockManager.acquire()` treats any live lock owned by the same daemon PID as effectively re-entrant. With concurrent execution, multiple jobs from the same daemon process and the same `session_id` are common, so a later same-session job can incorrectly acquire the lock while another job in that session is still running.

Note: the lock file already includes a `job_id` field today, but `acquire()` does not use it to distinguish which in-process job owns the session.

That breaks the expected behavior for `/end`: a cleanup job may run immediately instead of waiting for the active same-session job to finish.

## Goal

Make `/end` obey the existing same-session serialization contract without adding any cleanup-specific queueing path.

Concretely:

1. `/end` continues to submit a normal `cleanup` task from the Lark listener.
2. Enrichment continues to inherit the thread `session_id` and produce a normal cleanup job.
3. At execution time, if another job already holds the same session lock, the cleanup job must fail lock acquisition, be NACKed, and be requeued.
4. The cleanup job executes only after the lock is released and the poller later reacquires it.

## Non-Goals

- Introducing a cleanup-only scheduler or queue.
- Moving same-session ordering guarantees into the API or RabbitMQ topology.
- Adding stronger per-session FIFO guarantees than the existing NACK-and-requeue model provides.
- Changing the immediate Lark acknowledgment UX for `/end`.

## Approaches Considered

### Approach 1: Fix session-lock ownership semantics and keep current NACK+requeue flow

Treat a lock as owned by a specific live job, not by the daemon PID alone.

**Why this is the right approach:**

- matches the existing architecture;
- applies uniformly to all same-session jobs, including `cleanup`;
- keeps `/end` as a standard pipeline task;
- fixes a broader correctness issue rather than adding a cleanup-specific patch.

**Recommendation:** Chosen.

### Approach 2: Add cleanup-specific deferral in the task poller

Detect `cleanup` jobs specially and hold or requeue them until the lock disappears.

**Why not chosen:**

- duplicates the existing same-session scheduling rule;
- creates a second behavior path only for `/end`;
- leaves the underlying same-process lock ownership bug in place for other task types.

### Approach 3: Enforce per-session ordering in the API/RabbitMQ layer

Add queue-level session ordering so blocked same-session jobs are never delivered to the task poller early.

**Why not chosen:**

- much larger architectural change;
- unnecessary for the stated requirement;
- contradicts the current design direction where the daemon owns same-session arbitration.

## Design

### 1. Lock ownership must distinguish job identity, not just process identity

**File:** `packages/daemon/task/src/services/session-lock.ts`

Current behavior:

- if the lock file contains a live PID equal to `process.pid`, `acquire()` logs a warning and continues;
- that allows a different in-process job for the same session to overwrite the lock and proceed.

Target behavior:

- if the lock file belongs to the same PID **and the same `job_id`**, acquisition is idempotent and returns `true` (it may refresh `locked_at`, but must not change `pid`/`job_id` ownership);
- if the lock file belongs to the same PID but a **different `job_id`**, acquisition must return `false` because another in-flight same-session job already owns the lock;
- if the lock file belongs to a different live PID, acquisition must still return `false`;
- if the lock file is stale or corrupt, overwrite it as today.

Operationally, the lock file schema stays the same (JSON with `pid`, `job_id`, `locked_at`). The correctness change is purely how `acquire()` interprets an existing lock owned by `process.pid`.

Suggested `acquire()` decision table:

1. If no lock file: write `{ pid: process.pid, job_id: jobId, locked_at: now }` and return `true`.
2. If lock file parses:
   - If `existing.pid === process.pid`:
     - If `existing.job_id === jobId`: return `true` (idempotent).
     - Else: return `false`.
   - Else if `existing.pid` is alive: return `false`.
   - Else: treat as stale and overwrite.
3. If lock file is corrupt/unparseable: overwrite and return `true` (same as today).

This keeps the stale-lock recovery logic intact while restoring real same-session serialization inside a single concurrent daemon process.

### 2. Task-poller behavior stays the enforcement point

**File:** `packages/daemon/task/src/task-poller.ts`

No architectural change is needed in the poller. The existing flow is already the desired one:

1. poll `GET /jobs/next`;
2. try `sessionLock.acquire(job.session_id, job.job_id)`;
3. on success, execute the job;
4. on failure, `POST /jobs/:id/nack` with requeue.

Once the lock manager is corrected, cleanup jobs created by `/end` automatically follow the same path as every other same-session job.

### 3. `/end` remains a normal cleanup job throughout the pipeline

No special handling is added to these layers:

- `packages/daemon/lark-listener/src/message-handler.ts`
- `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- `packages/daemon/task/src/core/task-orchestrator.ts`

The flow remains:

```text
Lark thread reply `/end`
  -> lark-listener submits task_type `cleanup`
  -> enrichment inherits session_id from thread state
  -> API publishes cleanup job
  -> task poller attempts same-session lock
     -> if busy: NACK + requeue
     -> if free: execute CleanupExecutor
```

This is important because the user requirement is not “make `/end` special.” It is “make `/end` obey the same session behavior as everything else.”

### 4. External contract note in `COMMANDS.md`

**File:** `COMMANDS.md`

The external command contract should remain simple:

- `/end` is still valid only in a thread reply;
- accepted `/end` still means “end/clean up the current thread session.”

Add a brief note that accepted cleanup may execute after pending same-session work finishes. The contract should not expose internal lock-file details, but it should not imply immediate execution either.

### 5. Accepted trade-off: no new FIFO guarantee

This change intentionally preserves the current concurrent-session model:

- blocked same-session jobs are requeued;
- requeued jobs may not preserve strict original submission order.

Therefore, this feature guarantees that `/end` will not bypass an active same-session lock. It does **not** introduce a stronger promise that `/end` will always run before or after every other waiting same-session message with strict FIFO precision.

That trade-off is acceptable because the user explicitly wants `/end` to be processed the same way as other session commands, not via a bespoke ordering rule.

## Testing Strategy

### SessionLockManager

Add regression coverage for same-process contention:

- same PID + different `job_id` returns `false` and does not overwrite the existing lock file;
- same PID + same `job_id` returns `true` and does not change ownership;
- stale/dead PID handling remains unchanged.

### TaskPoller

Add a cleanup-specific serialization test:

- job 1 acquires the session lock and remains in flight;
- job 2 is a `cleanup` job for the same `session_id`;
- poller NACKs and requeues job 2 instead of executing it;
- after job 1 completes, a later poll can acquire and execute job 2.

### Command Contract Docs

Add a small documentation assertion by updating `COMMANDS.md` so reviewers can verify the user-facing description matches the corrected behavior.

## Files Changed

| File | Change |
|------|--------|
| `packages/daemon/task/src/services/session-lock.ts` | Fix lock ownership semantics for same-PID/different-job contention |
| `packages/daemon/task/src/services/__tests__/session-lock.test.ts` | Add same-process regression coverage |
| `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` | Add `/end`/cleanup requeue regression test |
| `COMMANDS.md` | Clarify that accepted `/end` cleanup may wait for pending same-session work |

## Rollout / Risk

Risk is low and localized. The change tightens an already intended invariant rather than introducing new execution stages.

The main implementation risk is accidentally breaking stale-lock recovery or making same-job reacquisition impossible if a code path depends on that behavior. The regression suite above should keep that bounded.
