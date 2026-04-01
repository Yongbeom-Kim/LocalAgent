# Design Spec: Concurrent Session Execution

## Overview

Enable the task daemon to process multiple jobs concurrently across different sessions, while serializing jobs within the same session. This improves both throughput and fairness — long-running sessions no longer block unrelated work.

## Architecture

### Current State
The `TaskPoller` processes jobs **sequentially**: poll → execute → publish result → ACK → poll. One job at a time, no parallelism.

### Target State
A **single poll loop** fires off jobs as async tasks, tracks in-flight count, and keeps polling as long as `in_flight < MAX_CONCURRENT_SESSIONS`. Jobs for the same session are serialized via file-based locking; conflicting jobs are NACKed with a daemon-side delay and requeued.

## Design Decisions (from Q&A)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Deployment model | Single daemon, internal concurrency | Simplest path; no distributed coordination |
| Same-session handling | Serialize (queue/wait via NACK+requeue) | Preserves `--continue` semantics and session state |
| Cross-session handling | Concurrent up to configurable limit | Throughput + fairness |
| Requeue mechanism | Daemon-side delay (hold 5s in memory, then NACK with `requeue: true`) | Simple; avoids RabbitMQ DLX infrastructure |
| Requeue delay | Hardcoded 5 seconds; make configurable later if needed | Keep it simple |
| Retry limit on requeue | None — rely on RabbitMQ message TTL or manual intervention | Simpler; avoids tracking requeue counts |
| Polling strategy | Keep polling `/jobs/next` one-by-one | No change to API; daemon manages concurrency internally |
| Job fetching | Poll returns one job; daemon decides to execute or NACK+requeue | Daemon-side decision based on lock state |
| `--continue` behavior | No change | Serialization within session preserves ordering |
| Session locking | File-based lock with PID at `<session_dir>/.lock` | Survives restarts; PID enables stale lock detection |
| Lock file format | JSON: `{ "pid": number, "job_id": string, "locked_at": string }` | Rich enough for debugging |
| Stale lock detection | On conflict only (not on startup, no periodic sweep) | Lazy detection is sufficient; Node.js single-threaded guarantees prevent race conditions |
| Lock lifecycle | Acquire before env setup, release after execution (before result publish) in a `finally` block | Always released regardless of success/failure |
| GC safety | Check for valid (non-stale) lock files before deleting session dirs | Safety net even though timing makes conflicts unlikely |
| Graceful shutdown | Stop polling immediately; let in-flight jobs finish (no timeout) | Clean drain without forced kills |
| Poll back-off at capacity | Simple doubling: 5s → 10s → 20s → cap 30s; reset when slot frees | Reduces unnecessary API calls when saturated |
| No-jobs back-off | No change — fixed interval | Keep it simple |
| ACK timing | After completion (no change) | Safe; unACKed jobs redelivered on crash |
| Concurrency config | `MAX_CONCURRENT_SESSIONS` env var, default `5` | Operator-tunable |
| Head-of-line blocking | Accepted — 5s delay makes re-fetching same job unlikely | Pragmatic trade-off |
| Out-of-order requeue | Documented trade-off — multiple queued messages for same session may arrive out-of-order after NACK+requeue | Acceptable for this use case |

## Detailed Design

### 1. Session Lock Manager

**New file:** `packages/daemon/task/src/services/session-lock.ts`

```typescript
interface LockInfo {
  pid: number;
  job_id: string;
  locked_at: string;
}

class SessionLockManager {
  acquire(sessionId: string, jobId: string): boolean
  release(sessionId: string): void
  isLocked(sessionId: string): boolean
}
```

**Lock file path:** `<SESSION_BASE_DIR>/<session_id>/.lock`

**Acquire logic:**
1. Check if `.lock` file exists
2. If exists, read and parse JSON
3. Compare `pid` with `process.pid` — if same PID, lock is ours (shouldn't happen in normal flow, but safe)
4. Check if PID is alive (`process.kill(pid, 0)`) — if dead, log warning, break stale lock
5. If PID is alive and different from ours, return `false` (session is busy)
6. If no lock file or stale lock broken, write new lock file atomically
7. Return `true`

**Release logic:**
1. Delete `.lock` file if it exists
2. Log release

**Edge case — session dir doesn't exist:** If the session directory doesn't exist yet (first job for a new session), there's no lock file, so `isLocked()` returns false. The job proceeds, environment setup creates the directory, and the lock is acquired. Since Node.js is single-threaded, the first job is guaranteed to create the directory and lock before a second job for the same session is polled.

### 2. Concurrent Task Poller

**Modified file:** `packages/daemon/task/src/task-poller.ts`

**New state:**
```typescript
class TaskPoller {
  private inFlightJobs: Map<string, Promise<void>>  // jobId → execution promise
  private activeSessions: Set<string>                // session IDs currently executing
  private maxConcurrency: number                     // from MAX_CONCURRENT_SESSIONS
  private currentPollInterval: number                // for back-off
  private basePollInterval: number                   // original interval
}
```

**Modified `pollOnce()` flow:**
1. Check if `inFlightJobs.size >= maxConcurrency` → if yes, skip this poll cycle
2. Call `GET /jobs/next` → if 204, return (no jobs)
3. Check `SessionLockManager.acquire(job.session_id, job.job_id)`
   - If acquired: spawn async task, add to `inFlightJobs` and `activeSessions`
   - If not acquired (session busy): hold for 5 seconds (daemon-side delay), then call `POST /jobs/{id}/nack`, log the requeue
4. When async task completes (in `.finally()`):
   - Release session lock
   - Remove from `inFlightJobs` and `activeSessions`
   - Publish result and ACK job

**Back-off at capacity:**
- When `inFlightJobs.size >= maxConcurrency`: double poll interval (5s → 10s → 20s → cap 30s)
- When a slot frees (job completes): reset to base interval

**Async task execution:**
```typescript
async executeJob(job: Job): Promise<void> {
  try {
    const result = await this.orchestrator.handle(job);
    await this.apiClient.publishResult(result);
    await this.apiClient.ackJob(job.job_id);
  } catch (error) {
    // Log error, still ACK to prevent infinite redelivery
    // Or NACK if we want retry — TBD based on error type
  } finally {
    this.sessionLock.release(job.session_id);
    this.inFlightJobs.delete(job.job_id);
    this.activeSessions.delete(job.session_id);
  }
}
```

### 3. NACK API Endpoint

**Modified file:** `packages/api/src/routes/jobs.ts`

**New endpoint:** `POST /jobs/:id/nack`

**Logic:**
1. Look up delivery tag from `jobsDeliveryMap`
2. Call `channel.nack(msg, false, true)` — single message, requeue
3. Remove from `jobsDeliveryMap`
4. Return 200

### 4. GC Safety Check

**Modified file:** `packages/daemon/task/src/services/gc-executor.ts`

**Change:** Before deleting a session directory, check for a valid `.lock` file:
1. If `.lock` exists and PID is alive → skip this directory
2. If `.lock` exists and PID is dead → stale lock, safe to delete
3. If no `.lock` → proceed with normal age-based deletion

### 5. Graceful Shutdown

**Modified file:** `packages/daemon/task/src/task-daemon.ts`

**Change:** On SIGINT/SIGTERM:
1. Stop the poll loop immediately (no new jobs picked up)
2. Wait for all `inFlightJobs` promises to resolve
3. Exit cleanly

### 6. Configuration

**New constant in `shared/constants.ts`:**
```typescript
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 5;
```

**Environment variable:** `MAX_CONCURRENT_SESSIONS`

Read in `task-daemon.ts` and passed to `TaskPoller` constructor.

## Known Trade-offs & Documented Behaviors

1. **Out-of-order execution within a session:** When multiple jobs for the same session are NACKed and requeued, they may arrive in a different order than originally submitted. This is accepted because:
   - Each job carries its own context (history + payload)
   - `--continue` mode picks up from the last session state regardless of job order
   - The alternative (ordered delivery guarantees) adds significant complexity

2. **Head-of-line blocking after NACK:** A NACKed job goes to the head of the RabbitMQ queue. The 5-second daemon-side delay before NACK makes it unlikely the same daemon re-fetches it immediately, but it's not impossible. This is accepted as a rare edge case.

3. **No retry limit on requeues:** A job for a long-running session could be requeued many times. RabbitMQ message TTL provides a safety net. Operators should configure appropriate TTL values.

## Implementation Plan

See [concurrent-sessions-implementation.md](./concurrent-sessions-implementation.md).
