# Implementation Plan: Concurrent Session Execution

> Design spec: [concurrent-sessions.md](./concurrent-sessions.md)

## Phase 1: Session Lock Manager

### Task 1.1: Add `DEFAULT_MAX_CONCURRENT_SESSIONS` constant

**File:** `packages/shared/src/constants.ts`

Add after line 13 (`SESSION_DIR_TTL_DAYS`):

```typescript
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 5;
export const DEFAULT_REQUEUE_DELAY_MS = 5000;
```

Export from the shared package barrel if needed.

### Task 1.2: Create `SessionLockManager`

**New file:** `packages/daemon/task/src/services/session-lock.ts`

```typescript
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_BASE_DIR, createLogger } from '@local-agent/shared';

const logger = createLogger('task-daemon:session-lock');

interface LockInfo {
  pid: number;
  job_id: string;
  locked_at: string;
}

export class SessionLockManager {
  private lockFileName = '.lock';

  private lockPath(sessionId: string): string {
    return join(SESSION_BASE_DIR, sessionId, this.lockFileName);
  }

  /**
   * Acquire a lock for the given session.
   * Returns true if the lock was acquired, false if the session is busy.
   * Breaks stale locks (PID no longer alive).
   */
  acquire(sessionId: string, jobId: string): boolean {
    const filePath = this.lockPath(sessionId);
    const sessionDir = join(SESSION_BASE_DIR, sessionId);

    // If session dir doesn't exist, no lock file → unlocked.
    // Create the dir so we can place the lock file.
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    if (existsSync(filePath)) {
      try {
        const existing: LockInfo = JSON.parse(readFileSync(filePath, 'utf-8'));

        // Same PID — lock is ours (shouldn't happen, but safe)
        if (existing.pid === process.pid) {
          logger.warn({ sessionId, jobId, existing }, 'Re-acquiring own lock');
        } else if (this.isPidAlive(existing.pid)) {
          // Different PID and alive → session is busy
          logger.debug({ sessionId, jobId, lockedBy: existing }, 'Session locked by another job');
          return false;
        } else {
          // PID is dead → stale lock, break it
          logger.warn({ sessionId, jobId, staleLock: existing }, 'Breaking stale lock (PID dead)');
        }
      } catch (err) {
        logger.warn({ sessionId, jobId, err }, 'Corrupt lock file, overwriting');
      }
    }

    const lockInfo: LockInfo = {
      pid: process.pid,
      job_id: jobId,
      locked_at: new Date().toISOString(),
    };

    writeFileSync(filePath, JSON.stringify(lockInfo, null, 2));
    logger.info({ sessionId, jobId }, 'Session lock acquired');
    return true;
  }

  /**
   * Release the lock for the given session.
   */
  release(sessionId: string): void {
    const filePath = this.lockPath(sessionId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      logger.info({ sessionId }, 'Session lock released');
    }
  }

  /**
   * Check if a session is locked by a live process.
   * Used by GC to skip actively-locked sessions.
   */
  isLockedByLiveProcess(sessionId: string): boolean {
    const filePath = this.lockPath(sessionId);
    if (!existsSync(filePath)) return false;

    try {
      const info: LockInfo = JSON.parse(readFileSync(filePath, 'utf-8'));
      return this.isPidAlive(info.pid);
    } catch {
      return false;
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
```

### Task 1.3: Unit tests for `SessionLockManager`

**New file:** `packages/daemon/task/src/services/__tests__/session-lock.test.ts`

Test cases:
1. `acquire()` succeeds when no lock exists → returns `true`, lock file created with correct JSON
2. `acquire()` returns `false` when session is locked by a live PID (mock `process.kill` to not throw)
3. `acquire()` breaks stale lock when PID is dead → returns `true`, new lock file written
4. `release()` removes the lock file
5. `release()` is a no-op when no lock file exists
6. `isLockedByLiveProcess()` returns `true` for live PID, `false` for dead PID, `false` when no file
7. `acquire()` creates session dir if it doesn't exist

---

## Phase 2: NACK API Endpoint

### Task 2.1: Add `nackJob` method to `RabbitMQService`

**File:** `packages/api/src/services/rabbitmq.ts`

Add after the `ackJob` method (after line 96):

```typescript
nackJob(jobId: string): boolean {
  if (!this.channel) return false;
  const delivery = this.jobsDeliveryMap.get(jobId);
  if (!delivery) return false;
  this.channel.nack(delivery as any, false, true); // allUpTo=false, requeue=true
  this.jobsDeliveryMap.delete(jobId);
  return true;
}
```

### Task 2.2: Add `POST /jobs/:id/nack` route

**File:** `packages/api/src/routes/jobs.ts`

Add after the `POST /:id/ack` route (after line 93), before `return router`:

```typescript
router.post('/:id/nack', (req: Request, res: Response, next: NextFunction) => {
  try {
    const nacked = rabbitmq.nackJob(req.params.id);
    if (!nacked) {
      res.status(404).json({ error: 'Job not found or already acknowledged' });
      return;
    }
    res.status(200).json({ requeued: true });
  } catch (err) {
    next(err);
  }
});
```

### Task 2.3: Tests for NACK endpoint

Test cases:
1. `nackJob()` calls `channel.nack()` with `requeue: true` and removes from delivery map
2. `nackJob()` returns `false` for unknown job ID
3. `POST /jobs/:id/nack` returns 200 with `{ requeued: true }` on success
4. `POST /jobs/:id/nack` returns 404 for unknown job

---

## Phase 3: Concurrent Poll Loop

### Task 3.1: Refactor `TaskPoller` for concurrency

**File:** `packages/daemon/task/src/task-poller.ts`

Replace the entire class. Key changes from the current implementation:

**Constructor** — accept new dependencies:
```typescript
constructor(
  private readonly apiUrl: string,
  private readonly orchestrator: TaskOrchestrator,
  private readonly sessionLock: SessionLockManager,
  private readonly maxConcurrency: number = DEFAULT_MAX_CONCURRENT_SESSIONS,
)
```

**New state fields:**
```typescript
private inFlightJobs = new Map<string, Promise<void>>();  // jobId → execution promise
private activeSessions = new Set<string>();                 // session IDs currently executing
private basePollInterval = 0;
private currentPollInterval = 0;
```

**Modified `pollOnce()` logic:**
1. If `inFlightJobs.size >= maxConcurrency`:
   - Increase `currentPollInterval` (double, cap at 30s)
   - Log and return early
2. Fetch job via `GET /jobs/next` — if 204, return
3. Try `sessionLock.acquire(job.session_id, job.job_id)`:
   - **If acquired:** fire `executeJob(job)` as a detached async task (don't await it). Store the promise in `inFlightJobs`, add session to `activeSessions`.
   - **If not acquired:** log requeue, wait 5s (`setTimeout` promise), then call `POST /jobs/{id}/nack`.
4. `pollOnce()` itself returns after dispatching (does NOT wait for job completion).

**New `executeJob(job)` method** — runs asynchronously:
```typescript
private async executeJob(job: Job): Promise<void> {
  try {
    const result = await this.orchestrator.handle(job);

    // Truncate stdout
    if (result.stdout.length > MAX_SNIPPET_CHARS) {
      result.stdout = result.stdout.substring(0, MAX_SNIPPET_CHARS);
    }

    // Attach routing fields
    const resultWithSource: TaskResultSubmission = {
      ...result,
      task_type: job.task_type,
      session_id: job.session_id,
      ...(job.task_source ? { task_source: job.task_source } : {}),
    };

    // Publish result (best-effort)
    try {
      const resultRes = await fetch(`${this.apiUrl}/results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resultWithSource),
      });
      if (resultRes.status !== 201) {
        logger.warn({ job_id: job.job_id, status: resultRes.status }, 'Result publish failed');
      }
    } catch (resultErr) {
      logger.error({ job_id: job.job_id, err: resultErr }, 'Result publish request failed');
    }

    // ACK the job
    try {
      const ackRes = await fetch(`${this.apiUrl}/jobs/${job.job_id}/ack`, { method: 'POST' });
      if (ackRes.status !== 200) {
        logger.warn({ job_id: job.job_id, status: ackRes.status }, 'ACK failed');
      } else {
        logger.info({ job_id: job.job_id }, 'Job acknowledged');
      }
    } catch (ackErr) {
      logger.error({ job_id: job.job_id, err: ackErr }, 'ACK request failed');
    }
  } catch (err) {
    logger.error({ job_id: job.job_id, err }, 'Orchestrator error — not acking');
  } finally {
    this.sessionLock.release(job.session_id);
    this.inFlightJobs.delete(job.job_id);
    this.activeSessions.delete(job.session_id);
    this.resetPollInterval();
    logger.info(
      { job_id: job.job_id, inFlight: this.inFlightJobs.size },
      'Job completed, slot freed',
    );
  }
}
```

**Back-off helpers:**
```typescript
private increasePollInterval(): void {
  this.currentPollInterval = Math.min(this.currentPollInterval * 2, 30_000);
}

private resetPollInterval(): void {
  this.currentPollInterval = this.basePollInterval;
}
```

**Modified `start(intervalMs)`:**
```typescript
start(intervalMs: number): void {
  this.basePollInterval = intervalMs;
  this.currentPollInterval = intervalMs;
  this.running = true;

  const loop = async () => {
    await this.pollOnce();
    if (this.running) {
      this.timer = setTimeout(loop, this.currentPollInterval);
    }
  };
  loop();
}
```

**New `drain()` method** — for graceful shutdown:
```typescript
async drain(): Promise<void> {
  this.stop();
  if (this.inFlightJobs.size > 0) {
    logger.info({ count: this.inFlightJobs.size }, 'Waiting for in-flight jobs to complete');
    await Promise.all(this.inFlightJobs.values());
    logger.info('All in-flight jobs completed');
  }
}
```

### Task 3.2: Update `task-daemon.ts`

**File:** `packages/daemon/task/src/task-daemon.ts`

Changes:
1. Import `SessionLockManager` and `DEFAULT_MAX_CONCURRENT_SESSIONS`
2. Read `MAX_CONCURRENT_SESSIONS` from `process.env` (parse int, fallback to default)
3. Instantiate `SessionLockManager`
4. Pass `sessionLock` and `maxConcurrency` to `TaskPoller` constructor
5. Update shutdown handler to call `poller.drain()` instead of `poller.stop()`:

```typescript
const sessionLock = new SessionLockManager();
const maxConcurrency = parseInt(process.env.MAX_CONCURRENT_SESSIONS ?? '', 10) || DEFAULT_MAX_CONCURRENT_SESSIONS;

logger.info({ maxConcurrency }, 'Concurrency limit');

const poller = new TaskPoller(config.apiUrl, orchestrator, sessionLock, maxConcurrency);
poller.start(config.pollIntervalMs);

const shutdown = async () => {
  logger.info('Shutting down task-daemon...');
  await poller.drain();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

### Task 3.3: Integration test for concurrent poll loop

**New file:** `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`

Test cases:
1. **Concurrent dispatch:** Mock API to return jobs for different sessions. Verify multiple `orchestrator.handle()` calls are in-flight simultaneously (not awaited sequentially).
2. **Same-session serialization:** Mock API to return two jobs with the same `session_id`. First acquires lock and executes. Second fails to acquire lock, waits 5s, calls NACK endpoint.
3. **Capacity limit:** Set `maxConcurrency=2`. Feed 3 jobs for different sessions. Verify only 2 are dispatched; poll skips when at capacity.
4. **Back-off:** Verify `currentPollInterval` doubles when at capacity and resets when a slot frees.
5. **Drain:** Start 2 jobs, call `drain()`, verify it waits for both to complete before resolving.

---

## Phase 4: GC Safety & Graceful Shutdown

### Task 4.1: Add lock check to GC

**File:** `packages/daemon/task/src/services/gc-executor.ts`

Import `SessionLockManager`:
```typescript
import { SessionLockManager } from './session-lock';
```

Add a `sessionLock` instance (can be a class field or instantiated in `execute()`):
```typescript
private readonly sessionLock = new SessionLockManager();
```

In the `for` loop (around line 37), after the `stats.isDirectory()` check and before the age check, add:

```typescript
// Skip actively-locked sessions (safety net)
if (this.sessionLock.isLockedByLiveProcess(entry)) {
  logger.info({ dirPath }, 'Skipping locked session directory');
  retained += 1;
  continue;
}
```

### Task 4.2: Tests for GC lock check

Test cases:
1. GC skips a session directory that has a valid lock file with a live PID
2. GC deletes a session directory with a stale lock file (dead PID)
3. GC deletes a session directory with no lock file (normal age-based behavior unchanged)

---

## File Change Summary

| File | Action | Phase |
|------|--------|-------|
| `packages/shared/src/constants.ts` | Add `DEFAULT_MAX_CONCURRENT_SESSIONS`, `DEFAULT_REQUEUE_DELAY_MS` | 1 |
| `packages/daemon/task/src/services/session-lock.ts` | **New** — `SessionLockManager` class | 1 |
| `packages/daemon/task/src/services/__tests__/session-lock.test.ts` | **New** — unit tests | 1 |
| `packages/api/src/services/rabbitmq.ts` | Add `nackJob()` method | 2 |
| `packages/api/src/routes/jobs.ts` | Add `POST /jobs/:id/nack` route | 2 |
| `packages/daemon/task/src/task-poller.ts` | Major refactor — concurrent dispatch, back-off, drain | 3 |
| `packages/daemon/task/src/task-daemon.ts` | Add lock manager, concurrency config, async shutdown | 3 |
| `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` | **New** — integration tests | 3 |
| `packages/daemon/task/src/services/gc-executor.ts` | Add lock file check before deletion | 4 |

## Dependency Order

```
Phase 1 (Lock Manager) ← no dependencies
Phase 2 (NACK Endpoint) ← no dependencies
Phase 3 (Concurrent Poller) ← depends on Phase 1 + Phase 2
Phase 4 (GC Safety) ← depends on Phase 1
```

Phases 1 and 2 can be implemented in parallel. Phase 3 requires both. Phase 4 requires only Phase 1.
