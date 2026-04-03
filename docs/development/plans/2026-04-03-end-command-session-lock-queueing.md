# `/end` Same-Session Lock Requeueing Implementation Plan

**Goal:** Make `/end` cleanup jobs obey the same same-session lock and NACK/requeue behavior as other jobs by fixing in-process session lock ownership semantics.

**Architecture:** Keep the existing pipeline unchanged: `/end` remains a normal `cleanup` job and the task poller remains the enforcement point for same-session serialization. The implementation is a narrow correctness fix in `SessionLockManager.acquire()`, plus regression tests that prove cleanup jobs for a busy session are requeued instead of executing immediately, and a small `COMMANDS.md` note so the external contract does not imply immediate cleanup.

**Tech Stack:** TypeScript, Vitest, Markdown

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/daemon/task/src/services/session-lock.ts` | Modify | Make same-PID lock handling job-aware instead of process-reentrant |
| `packages/daemon/task/src/services/__tests__/session-lock.test.ts` | Modify | Add lock-manager regressions for same-process contention |
| `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` | Modify | Add cleanup-job requeue regression at the poller layer |
| `COMMANDS.md` | Modify | Clarify that accepted `/end` cleanup may run after pending same-session work |

---

### Task 1: Fix Session Lock Ownership Semantics

**Files:**
- Modify: `packages/daemon/task/src/services/session-lock.ts`
- Test: `packages/daemon/task/src/services/__tests__/session-lock.test.ts`

- [ ] **Step 1: Read the current lock acquisition branch that handles `existing.pid === process.pid`**

Run: `sed -n '1,220p' packages/daemon/task/src/services/session-lock.ts`
Expected: the current code warns on same-PID reacquisition and then falls through to overwrite the lock.

- [ ] **Step 2: Write a failing regression test for same PID with a different `job_id`**

Add a test in `packages/daemon/task/src/services/__tests__/session-lock.test.ts` that:

```ts
it('returns false and preserves the lock when the same process tries to acquire with a different job_id', () => {
  manager.acquire('sess-same-pid', 'job-1');

  const second = manager.acquire('sess-same-pid', 'job-2');

  expect(second).toBe(false);

  const lockInfo = JSON.parse(readFileSync(join(TEST_SESSION_BASE_DIR, 'sess-same-pid', '.lock'), 'utf-8'));
  expect(lockInfo.job_id).toBe('job-1');
  expect(lockInfo.pid).toBe(process.pid);
});
```

- [ ] **Step 3: Write a failing regression test for same PID with the same `job_id`**

Add a second test in `packages/daemon/task/src/services/__tests__/session-lock.test.ts` that verifies idempotent reacquisition:

```ts
it('returns true for idempotent reacquisition by the same process and same job_id', () => {
  expect(manager.acquire('sess-idempotent', 'job-1')).toBe(true);
  expect(manager.acquire('sess-idempotent', 'job-1')).toBe(true);

  const lockInfo = JSON.parse(readFileSync(join(TEST_SESSION_BASE_DIR, 'sess-idempotent', '.lock'), 'utf-8'));
  expect(lockInfo.job_id).toBe('job-1');
  expect(lockInfo.pid).toBe(process.pid);
});
```

- [ ] **Step 4: Run the session-lock test file and confirm the new tests fail against current behavior**

Run: `pnpm vitest run packages/daemon/task/src/services/__tests__/session-lock.test.ts`
Expected: the new same-PID/different-`job_id` regression fails because the current implementation overwrites the lock.

- [ ] **Step 5: Update `SessionLockManager.acquire()` to branch on both `pid` and `job_id`**

Implement this logic in `packages/daemon/task/src/services/session-lock.ts`:

```ts
if (existing.pid === process.pid) {
  if (existing.job_id === jobId) {
    logger.warn({ sessionId, jobId, existing }, 'Re-acquiring own lock');
    return true;
  }

  logger.debug({ sessionId, jobId, lockedBy: existing }, 'Session locked by another in-process job');
  return false;
}

if (this.isPidAlive(existing.pid)) {
  logger.debug({ sessionId, jobId, lockedBy: existing }, 'Session locked by another job');
  return false;
}
```

Keep the stale-lock and corrupt-lock overwrite behavior unchanged.

- [ ] **Step 6: Re-run the session-lock tests and verify they pass**

Run: `pnpm vitest run packages/daemon/task/src/services/__tests__/session-lock.test.ts`
Expected: PASS for the new regressions and the existing stale/dead PID coverage.

- [ ] **Step 7: Commit the lock-manager slice (optional)**

```bash
git add packages/daemon/task/src/services/session-lock.ts packages/daemon/task/src/services/__tests__/session-lock.test.ts
git commit -m "fix(task): make session locks job-aware within one process"
```

### Task 2: Prove Cleanup Jobs Requeue While a Session Is Busy

**Files:**
- Modify: `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`
- Inspect: `packages/daemon/task/src/task-poller.ts`

- [ ] **Step 1: Read the existing same-session NACK test in the concurrent poller suite**

Run: `sed -n '140,230p' packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`
Expected: there is already a generic same-session serialization test that verifies NACK on lock failure.

- [ ] **Step 2: Add a cleanup-specific integration regression test that reproduces the same-PID/different-job bug**

Append a test in `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` that uses a **real** `SessionLockManager` (not the stubbed `mockSessionLock`). This is important: if the lock is mocked to return `false`, the test will not fail pre-fix, and it will not prove the lock ownership semantics are corrected.

To keep the test hermetic, override `SESSION_BASE_DIR` for this test file to a temp location (similar to the lock-manager unit tests) so the real lock file does not touch developer state.

Important buildability note:

- `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` currently does a runtime import from `@local-agent/shared`. If you add `vi.mock('@local-agent/shared', ...)` in this file, it must be declared **before** any runtime import of `@local-agent/shared` (or any module that itself imports it). The simplest way:
  - change the existing `import { Job, TaskResultSubmission } from '@local-agent/shared';` to `import type { Job, TaskResultSubmission } from '@local-agent/shared';` so it does not load the module at runtime;
  - place the `vi.hoisted(...)` + `vi.mock('@local-agent/shared', ...)` block at the top of the file;
  - only then import `SessionLockManager`, `TaskOrchestrator`, `TaskPoller`, etc.

Implementation outline:

```ts
// Near the top of the test file (before importing SessionLockManager), add:
const { TEST_SESSION_BASE_DIR } = vi.hoisted(() => ({
  TEST_SESSION_BASE_DIR: '/tmp/local-agent-task-poller-session-lock-test/session',
}));

vi.mock('@local-agent/shared', async () => {
  const actual = await vi.importActual<typeof import('@local-agent/shared')>('@local-agent/shared');
  return { ...actual, SESSION_BASE_DIR: TEST_SESSION_BASE_DIR };
});

// Also mock CleanupExecutor in this file so cleanup execution is deterministic:
const mockCleanupExecute = vi.fn();
vi.mock('../adapters/cleanup-executor', () => ({
  CleanupExecutor: vi.fn(function (this: { execute: typeof mockCleanupExecute }) {
    this.execute = mockCleanupExecute;
  }),
}));
```

Then the test itself:

```ts
it('NACKs and requeues a cleanup job when another in-flight job holds the same-session lock (same PID)', async () => {
  const jobEnv = new JobEnvironment(false);
  const realSessionLock = new SessionLockManager();
  poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), realSessionLock, 5);

  // Job 1 hangs, holding the lock file open (until we resolve it)
  let resolveJob1!: (v: TaskResultSubmission) => void;
  const job1Promise = new Promise<TaskResultSubmission>((r) => { resolveJob1 = r; });
  mockClaudeExecute.mockReturnValueOnce(job1Promise);

  // Cleanup job returns quickly
  mockCleanupExecute.mockResolvedValueOnce({
    job_id: 'job-cleanup',
    task_id: 'task-cleanup',
    session_id: 'session-A',
    task_type: 'cleanup',
    status: 'success',
    exit_code: 0,
    stdout: 'cleanup complete',
    stderr: '',
  });

  const activeJob = createJob({ job_id: 'job-active', task_id: 'task-active', session_id: 'session-A', task_type: 'generic' });
  const cleanupJob = createJob({
    job_id: 'job-cleanup',
    task_id: 'task-cleanup',
    session_id: 'session-A',
    task_type: 'cleanup',
    executors: [{ executor: 'builtin', executor_model: 'none' }],
  });

  // 1) First poll returns the active job and starts it (lock acquired by job-active)
  mockFetch.mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(activeJob) });
  await poller.pollOnce();
  await new Promise((r) => setTimeout(r, 10));

  // 2) Second poll returns cleanup job.
  //    Correct behavior (post-fix): lock acquisition fails (same PID, different job_id) and poller NACKs.
  //    Broken behavior (pre-fix): lock acquisition succeeds and cleanup executes immediately.
  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(cleanupJob) })
    .mockResolvedValueOnce({ status: 200 }); // NACK response (only used on correct path)
  await poller.pollOnce();

  const nackCall = mockFetch.mock.calls.find(
    (call) => typeof call[0] === 'string' && call[0].includes('/jobs/job-cleanup/nack'),
  );
  expect(nackCall).toBeDefined();
  expect(mockCleanupExecute).toHaveBeenCalledTimes(0);

  // 3) Finish active job and let it ACK/release the lock
  mockFetch
    .mockResolvedValueOnce({ status: 201 }) // result for job-active
    .mockResolvedValueOnce({ status: 200 }); // ack for job-active
  resolveJob1(createMockResult('job-active', 'session-A'));
  await poller.drain();

  // 4) Next poll returns cleanup job again; now it should execute and ACK
  poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), realSessionLock, 5);
  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(cleanupJob) })
    .mockResolvedValueOnce({ status: 201 }) // result for job-cleanup
    .mockResolvedValueOnce({ status: 200 }); // ack for job-cleanup
  await poller.pollOnce();
  await poller.drain();

  expect(mockCleanupExecute).toHaveBeenCalledTimes(1);
});
```

Notes:

- This test should fail before Task 1 (because `SessionLockManager.acquire()` treats same-PID as re-entrant and will allow cleanup to execute, so `nackCall` will be `undefined`).
- After Task 1, it should pass.
- Add a `rmSync(TEST_SESSION_BASE_DIR, { recursive: true, force: true })` in `beforeEach/afterEach` for this file if needed, to avoid lock-file leftovers.

- Add a `rmSync(TEST_SESSION_BASE_DIR, { recursive: true, force: true })` in `beforeEach/afterEach` for this file so the test does not depend on OS-level PID reuse or leftover lock files.
- Ensure `mockFetch` has enough responses for both paths.
  - Easiest: add a default `mockFetch.mockImplementation(async () => ({ status: 500, json: async () => ({}) }))` in this test case or `beforeEach` and then override the specific calls you care about with `mockResolvedValueOnce(...)`. This prevents flaky failures if the pre-fix path unexpectedly executes cleanup and tries to publish a result/ack.


- [ ] **Step 3: Run the concurrent poller test file and verify the new cleanup regression passes**

Run: `pnpm vitest run packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`
Expected: PASS, including the cleanup requeue regression.

If you want to observe the regression fail pre-fix, add the test first and run it before completing Task 1 Step 5.

- [ ] **Step 4: Commit the poller regression slice (optional)**

```bash
git add packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts
git commit -m "test(task): cover cleanup requeue behind session lock"
```

### Task 3: Update the External Command Contract

**Files:**
- Modify: `COMMANDS.md`

- [ ] **Step 1: Add a brief `/end` note that accepted cleanup may wait for same-session work**

Update the `/end` notes section in `COMMANDS.md` to include wording like:

```md
- `/end` is rejected unless it can be associated with an existing thread session.
- When accepted, cleanup may execute only after earlier same-session work finishes.
```

Do not mention lock files, NACK, RabbitMQ, or internal job semantics.

- [ ] **Step 2: Review the wording for contract-scope discipline**

Run: `sed -n '100,170p' COMMANDS.md`
Expected: the added note is externally observable, brief, and free of internal implementation detail.

- [ ] **Step 3: Commit the doc clarification (optional)**

```bash
git add COMMANDS.md
git commit -m "docs(commands): clarify delayed cleanup execution for /end"
```

### Task 4: Final Verification and Integration

**Files:**
- Verify: `packages/daemon/task/src/services/session-lock.ts`
- Verify: `packages/daemon/task/src/services/__tests__/session-lock.test.ts`
- Verify: `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`
- Verify: `COMMANDS.md`

- [ ] **Step 1: Run the targeted task-daemon test files together**

Run:

```bash
pnpm vitest run \
  packages/daemon/task/src/services/__tests__/session-lock.test.ts \
  packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts
```

Expected: PASS for all tests covering same-session lock contention and cleanup requeueing.

- [ ] **Step 2: Optionally run the broader task package test suite if time allows**

Run: `pnpm vitest run packages/daemon/task/src`
Expected: PASS, or any unrelated pre-existing failures called out explicitly before merge.

- [ ] **Step 3: Inspect the final diff for scope control**

Run: `git diff -- packages/daemon/task/src/services/session-lock.ts packages/daemon/task/src/services/__tests__/session-lock.test.ts packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts COMMANDS.md`
Expected: only the planned lock fix, regressions, and doc note are present.
