# Terminal Setup Hook Failures Implementation Plan

**Goal:** When a setup hook exits nonzero or times out, return a terminal failure result (`exit_code: 1`, raw hook `stdout`/`stderr`) and do not run any executor, fallback, or `new_instance` retry.

**Architecture:** Add a typed hook failure (`SetupHookExecutionError`) thrown by `SetupHookRunner` that carries normalized result fields. `TaskOrchestrator` catches that type from `JobEnvironment.setup()` and returns the final failure result (no executor metadata). Other setup errors keep current behavior.

**Tech Stack:** TypeScript, Node.js `child_process.execFile`, Vitest.

---

## File Structure

- Modify: `packages/daemon/task/src/services/setup-hook-runner.ts`
  - Add `SetupHookExecutionError` type
  - Capture stdout/stderr on failure and timeout
  - Normalize `exit_code` to `1` for hook nonzero exit and timeouts
  - Truncate hook output to `MAX_RESULT_OUTPUT_BYTES`

- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
  - Catch `SetupHookExecutionError` from `jobEnv.setup(job)`
  - Return terminal failure result (`exit_code: 1`, raw/truncated stdout/stderr)
  - Ensure it short-circuits `new_instance` retry path

- Tests:
  - Modify: `packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts`
  - Modify: `packages/daemon/task/src/services/__tests__/job-environment.test.ts` (minimal: ensure rethrow / cleanup behavior still holds)
  - Modify: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`

---

### Task 1: Add Typed Setup Hook Failure and Output Capture

**Files:**
- Modify: `packages/daemon/task/src/services/setup-hook-runner.ts`
- Test: `packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts`

- [ ] **Step 1: Write failing tests for typed hook failure**

In `setup-hook-runner.test.ts`, add tests that expect a typed error with fields:

- Nonzero exit captures stderr and sets `exit_code: 1`.
- Nonzero exit captures stdout and stderr separately.
- Timeout throws typed error with `exit_code: 1` and `timedOut: true`.
- Timeout populates `stderr` with something actionable if empty.
- Large stdout/stderr are truncated to `MAX_RESULT_OUTPUT_BYTES`.

Example assertions (adapt to repo style):

```ts
await expect(runner.run('echo out; echo err >&2; exit 2', workDir, ctx, 10_000))
  .rejects.toMatchObject({
    exit_code: 1,
    timedOut: false,
    stdout: expect.stringContaining('out'),
    stderr: expect.stringContaining('err'),
  });
```

For timeout, keep existing `sleep` test but assert typed error shape.

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm -C packages/daemon/task test -- src/services/__tests__/setup-hook-runner.test.ts
```
Expected: FAIL because `SetupHookExecutionError` does not exist and runner does not surface stdout/stderr on failure.

- [ ] **Step 3: Implement `SetupHookExecutionError` and throw it**

In `setup-hook-runner.ts`:

- Create `export class SetupHookExecutionError extends Error` with:
  - `exit_code = 1`
  - `stdout`, `stderr`, `timedOut`
- Update the `catch` block to:
  - Read `err.stdout` and `err.stderr` (default `''`)
  - Detect timeout (e.g. `err.killed === true` and/or `err.signal` when `timeout` is hit)
  - For non-timeout, treat as hook failure when the process exits nonzero (i.e. `err.code` is a number and nonzero).
  - If the error is neither a timeout nor a numeric nonzero exit, preserve the existing generic behavior by rethrowing a normal `Error` instead of wrapping it in `SetupHookExecutionError`.
  - Normalize `exit_code` to `1` for both timeout and nonzero exit.
  - Set `stderr`:
    - Prefer raw `err.stderr` if non-empty
    - Otherwise use `err.message` (trimmed)
    - If timeout and still empty, synthesize `Setup hook timed out after <timeoutMs>ms`
  - Truncate `stdout` and `stderr` to `MAX_RESULT_OUTPUT_BYTES` using `truncate`.

Notes:
- Keep current structured logging (stdout info, stderr warn) for the success case.
- For failure case, ensure logs remain useful but the error thrown carries raw outputs.

- [ ] **Step 4: Run tests**

Run the same test command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/services/setup-hook-runner.ts packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts
git commit -m "feat(task): typed terminal setup-hook failures with raw output"
```

---

### Task 2: Short-Circuit Orchestrator on Setup Hook Failure

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
- Test: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Add failing orchestrator tests**

In `task-orchestrator.test.ts`, add tests that:

- When `jobEnv.setup` rejects with `SetupHookExecutionError`, `orchestrator.handle(job)` returns:
  - `status: 'failure'`
  - `exit_code: 1`
  - `stdout`/`stderr` forwarded
  - no `executor` or `executor_model` fields
- Assert no executor adapter is invoked.

Also add a test for `new_instance`:
- A job with `task_type: 'new_instance'` and `jobEnv.setup` rejecting with `SetupHookExecutionError` should return immediately with failure (no retries).

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm -C packages/daemon/task test -- src/core/__tests__/task-orchestrator.test.ts
```
Expected: FAIL until orchestrator catches the typed error.

- [ ] **Step 3: Implement typed catch and terminal result**

In `task-orchestrator.ts`:

- Import `SetupHookExecutionError`.
- Wrap the `jobEnv.setup(job)` call in a `try/catch` that checks `instanceof SetupHookExecutionError`.
- On match, return terminal failure result:

```ts
return {
  job_id: job.job_id,
  task_id: job.task_id,
  task_type: job.task_type,
  status: 'failure',
  exit_code: hookErr.exit_code,
  stdout: hookErr.stdout,
  stderr: hookErr.stderr,
};
```

Note: `SetupHookExecutionError.exit_code` is always `1` by contract.

- Ensure this return happens before any `isNewInstance` retry loop and before `runExecutors`.

- [ ] **Step 4: Run tests**

Re-run the command from Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts
git commit -m "feat(task): short-circuit on setup-hook failure before executor dispatch"
```

---

### Task 3: Verify JobEnvironment Cleanup Contract Still Holds

**Files:**
- Test: `packages/daemon/task/src/services/__tests__/job-environment.test.ts`

- [ ] **Step 1: Update existing job-environment tests (if needed)**

Current tests mock `SetupHookRunner.run` to reject with `new Error('Setup hook failed: ...')`. Update expectations (or add a new test) so that when runner rejects with `SetupHookExecutionError`, cleanup behavior remains:

- debug false: workspace removed
- debug true: workspace preserved
- lock-file present: lock preserved, other contents cleared

This can be done by making the mocked runner reject with a `SetupHookExecutionError` instance.

- [ ] **Step 2: Run tests**

```bash
pnpm -C packages/daemon/task test -- src/services/__tests__/job-environment.test.ts
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/task/src/services/__tests__/job-environment.test.ts
git commit -m "test(task): job-environment cleanup on typed setup-hook failures"
```

---

### Task 4: End-to-End-ish Verification via Poller Contract (Optional)

**Files:**
- (Likely none; rely on unit tests)

- [ ] **Step 1: Confirm result publishing tolerates missing executor metadata**

The API route already treats `executor`/`executor_model` as optional but coupled. Ensure the result posted from poller for setup-hook failure omits both. No code changes expected.

- [ ] **Step 2: Run full daemon task package tests**

```bash
cd LocalAgent
pnpm -C packages/daemon/task test
```
Expected: PASS.

---

## Rollout Notes

- This is a behavior change: hook failures will now publish `exit_code: 1` (previously often `null`) and forward raw output.
- `.workspace-ready` behavior remains unchanged (hooks skipped for existing workspaces).
