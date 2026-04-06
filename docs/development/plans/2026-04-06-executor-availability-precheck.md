# Executor Availability Precheck Implementation Plan

**Goal:** Add a port-level executor precheck so the task orchestrator fails fast when an executor's required binaries are missing from `PATH`, while preserving the existing executor fallback behavior.

**Architecture:** Extend the task executor port with a structured `precheck(env)` method, implement executor-owned `command -v` checks inside each adapter, and have `TaskOrchestrator` call precheck before every executor preference attempt. Precheck failures are converted into the existing `TaskResultSubmission` failure shape and logged explicitly, but they follow the same fallback path as ordinary executor failures.

**Tech Stack:** TypeScript, Node.js child-process APIs, Vitest, existing LocalAgent task-daemon packages.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/daemon/task/src/ports/task-executor.ts` | Extend the executor port with the structured precheck contract |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Run precheck before execute and translate failed prechecks into standard failure results |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Verify precheck ordering, fallback, and no-execute-on-precheck-failure behavior |
| `packages/daemon/task/src/adapters/claude-executor.ts` | Add executor-owned `command -v` precheck for `claude` |
| `packages/daemon/task/src/adapters/claude-w-executor.ts` | Add executor-owned `command -v` precheck for `claude-w` |
| `packages/daemon/task/src/adapters/cursor-executor.ts` | Add executor-owned `command -v` precheck for `agent` |
| `packages/daemon/task/src/adapters/ttcodex-executor.ts` | Add executor-owned `command -v` precheck for `ttadk` |
| `packages/daemon/task/src/adapters/cleanup-executor.ts` | Add no-op success precheck |
| `packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts` | Cover `ClaudeExecutor.precheck()` success/failure |
| `packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts` | Cover `ClaudeWExecutor.precheck()` success/failure |
| `packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts` | Cover `CursorExecutor.precheck()` success/failure |
| `packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts` | Cover `TTCodexExecutor.precheck()` success/failure |
| `packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts` | Cover `CleanupExecutor.precheck()` no-op success |

### Task 1: Extend the executor port with the precheck contract

**Files:**
- Modify: `packages/daemon/task/src/ports/task-executor.ts`
- Modify: `packages/daemon/task/src/adapters/claude-executor.ts`
- Modify: `packages/daemon/task/src/adapters/claude-w-executor.ts`
- Modify: `packages/daemon/task/src/adapters/cursor-executor.ts`
- Modify: `packages/daemon/task/src/adapters/ttcodex-executor.ts`
- Modify: `packages/daemon/task/src/adapters/cleanup-executor.ts`

- [ ] **Step 1: Add the structured precheck types to the port**

In `packages/daemon/task/src/ports/task-executor.ts`, add:

```ts
export type ExecutorPrecheckResult =
  | { ok: true }
  | { ok: false; stderr: string };

export interface TaskExecutor {
  precheck(env: ExecutionEnvironment): Promise<ExecutorPrecheckResult>;
  execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission>;
}
```

Keep the type in this port file. Do not create a shared helper module or a separate precheck utility file.

- [ ] **Step 2: Implement a temporary no-op `precheck(...)` on every `TaskExecutor` implementation**

Because changing the port interface will break compilation until all implementations add `precheck(...)`, add a minimal placeholder implementation to each executor:

- `ClaudeExecutor.precheck(...)` -> `return { ok: true }`
- `ClaudeWExecutor.precheck(...)` -> `return { ok: true }`
- `CursorExecutor.precheck(...)` -> `return { ok: true }`
- `TTCodexExecutor.precheck(...)` -> `return { ok: true }`
- `CleanupExecutor.precheck(...)` -> `return { ok: true }` (this behavior is final; it stays no-op in V1)

Do not add `command -v` logic yet in this task; that is covered in Tasks 3-6.

- [ ] **Step 3: Run the task-daemon unit tests to verify everything still passes**

Run: `pnpm --filter @local-agent/task-daemon vitest run`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/task/src/ports/task-executor.ts \
  packages/daemon/task/src/adapters/claude-executor.ts \
  packages/daemon/task/src/adapters/claude-w-executor.ts \
  packages/daemon/task/src/adapters/cursor-executor.ts \
  packages/daemon/task/src/adapters/ttcodex-executor.ts \
  packages/daemon/task/src/adapters/cleanup-executor.ts
git commit -m "refactor(task-daemon): add executor precheck port contract"
```

### Task 2: Make the orchestrator invoke precheck and preserve fallback semantics

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
- Modify: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Add failing orchestrator tests for precheck failure behavior**

In `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`, add these cases:

Implementation note: the existing test file currently mocks each executor class instance with only an `execute` method. Update those mocks to also include `precheck` and define the following test helpers:

- `const mockClaudePrecheck = vi.fn().mockResolvedValue({ ok: true });`
- `const mockClaudeWPrecheck = vi.fn().mockResolvedValue({ ok: true });`
- `const mockCursorPrecheck = vi.fn().mockResolvedValue({ ok: true });`
- `const mockTTCodexPrecheck = vi.fn().mockResolvedValue({ ok: true });`
- `const mockCleanupPrecheck = vi.fn().mockResolvedValue({ ok: true });`

```ts
it('calls precheck before execute for the selected executor', async () => {
  const job = createJob();
  await orchestrator.handle(job);

  expect(mockClaudePrecheck).toHaveBeenCalledWith(mockEnv);
  expect(mockClaudeExecute).toHaveBeenCalled();
  expect(mockClaudePrecheck.mock.invocationCallOrder[0]).toBeLessThan(
    mockClaudeExecute.mock.invocationCallOrder[0],
  );
});

it('skips execute and falls through to the next executor when precheck fails', async () => {
  mockClaudePrecheck.mockResolvedValueOnce({
    ok: false,
    stderr: 'Executor "claude" unavailable: missing required binaries in PATH: claude',
  });
  mockClaudeWPrecheck.mockResolvedValueOnce({ ok: true });

  await orchestrator.handle(createJob({
    executors: [
      { executor: 'claude', executor_model: 'opus' },
      { executor: 'claude-w', executor_model: 'gpt-5.4' },
    ],
  }));

  expect(mockClaudeExecute).not.toHaveBeenCalled();
  expect(mockClaudeWExecute).toHaveBeenCalled();
});

it('returns a standard failure result when the last executor precheck fails', async () => {
  mockClaudePrecheck.mockResolvedValueOnce({
    ok: false,
    stderr: 'Executor "claude" unavailable: missing required binaries in PATH: claude',
  });

  const result = await orchestrator.handle(createJob());

  expect(result).toEqual({
    job_id: 'job-456',
    task_id: 'test-123',
    session_id: 'session-789',
    task_type: 'generic',
    status: 'failure',
    exit_code: null,
    stdout: '',
    stderr: 'Executor "claude" unavailable: missing required binaries in PATH: claude',
    executor: 'claude',
    executor_model: 'opus',
  });
});

it('treats a thrown precheck error as a failed precheck and falls back', async () => {
  mockClaudePrecheck.mockRejectedValueOnce(new Error('boom'));
  mockClaudeWPrecheck.mockResolvedValueOnce({ ok: true });

  await orchestrator.handle(createJob({
    executors: [
      { executor: 'claude', executor_model: 'opus' },
      { executor: 'claude-w', executor_model: 'gpt-5.4' },
    ],
  }));

  expect(mockClaudeExecute).not.toHaveBeenCalled();
  expect(mockClaudeWExecute).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the orchestrator tests to verify failure**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: FAIL because `TaskOrchestrator` does not yet call `precheck` or synthesize precheck failures.

- [ ] **Step 3: Update `TaskOrchestrator` to run precheck before execute**

In `packages/daemon/task/src/core/task-orchestrator.ts`:

1. Resolve the executor as today.
2. Call `await executor.precheck(env)` before calling `execute(...)`.
3. If the result is `{ ok: false }`, build a normal failure `TaskResultSubmission` using that `stderr` string (and include `session_id`).
4. If `precheck(...)` throws, catch the error and treat it as a failed precheck with a simple message: `Executor "<executor>" precheck threw: <message>`.
5. Log an explicit warning for precheck failure with executor/model context.
6. Preserve the existing fallback path and executor metadata annotation.

Do not:

- add a new result status;
- throw from the orchestrator for precheck failure;
- move precheck logic into `execute()`.

- [ ] **Step 4: Run the orchestrator tests to verify they pass**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: PASS with precheck ordering and fallback coverage.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts
git commit -m "feat(task-daemon): fail fast on executor precheck"
```

### Task 3: Implement `ClaudeExecutor.precheck()`

**Files:**
- Modify: `packages/daemon/task/src/adapters/claude-executor.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts`

- [ ] **Step 1: Add failing Claude precheck tests**

In `packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts`, add focused `precheck()` tests separate from the existing `execute()` coverage.

Add at least:

```ts
it('returns success when the claude binary is available in PATH', async () => {
  // mock command -v subprocess success
});

it('returns failure when the claude binary is missing from PATH', async () => {
  // mock command -v subprocess failure and assert the simple stderr message
});
```

Keep the existing `execute()` tests intact; they should not be rewritten to call precheck themselves.

Testing detail: these executors already mock `node:child_process.spawn`. If you implement `precheck()` using `spawnSync`, update the test's `vi.mock('node:child_process', ...)` to include a `spawnSync: vi.fn()` export and assert calls/return values via `vi.mocked(spawnSync)`.

- [ ] **Step 2: Run the Claude adapter tests to verify failure**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/claude-executor.test.ts`
Expected: FAIL because `ClaudeExecutor` does not yet implement `precheck()`.

- [ ] **Step 3: Implement executor-owned `command -v` checking in `ClaudeExecutor`**

In `packages/daemon/task/src/adapters/claude-executor.ts`:

1. Add `precheck(_env)` to the class.
2. Keep a tiny local required-binaries array: `['claude']`.
3. Run `command -v` against each required binary via a shell (POSIX), for example using `spawnSync('sh', ['-lc', 'command -v claude >/dev/null 2>&1'])`.
4. Return `{ ok: true }` if all checks pass.
5. Return:

```ts
{
  ok: false,
  stderr: 'Executor "claude" unavailable: missing required binaries in PATH: claude',
}
```

if the binary is missing.

If you choose to implement the check with `spawnSync(...)`, use a detached shell invocation that does not produce output. The precheck contract should remain `{ ok: true }` or `{ ok: false; stderr: string }` and should never throw.

Implementation note: even though current executors only have one required binary, keep the code structured to gather *all* missing binaries (to match the spec and leave room for future additions).

Implementation constraint: keep any helper private and local to this file. Do not extract a shared utility.

- [ ] **Step 4: Run the Claude adapter tests to verify they pass**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/claude-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/adapters/claude-executor.ts packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts
git commit -m "feat(task-daemon): add claude executor precheck"
```

### Task 4: Implement `ClaudeWExecutor.precheck()`

**Files:**
- Modify: `packages/daemon/task/src/adapters/claude-w-executor.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts`

- [ ] **Step 1: Add failing Claude W precheck tests**

Add tests that mirror the Claude adapter coverage but target `claude-w` and the exact expected message:

```ts
'Executor "claude-w" unavailable: missing required binaries in PATH: claude-w'
```

- [ ] **Step 2: Run the Claude W adapter tests to verify failure**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/claude-w-executor.test.ts`
Expected: FAIL because `precheck()` does not exist yet.

- [ ] **Step 3: Implement the executor-owned `claude-w` precheck**

Use the same local pattern as Task 3, but with required binaries `['claude-w']` and executor name `claude-w` in the message text.

- [ ] **Step 4: Run the Claude W adapter tests to verify they pass**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/claude-w-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/adapters/claude-w-executor.ts packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts
git commit -m "feat(task-daemon): add claude-w executor precheck"
```

### Task 5: Implement `CursorExecutor.precheck()`

**Files:**
- Modify: `packages/daemon/task/src/adapters/cursor-executor.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts`

- [ ] **Step 1: Add failing Cursor precheck tests**

Add tests that assert `CursorExecutor.precheck()`:

1. succeeds when `agent` is found;
2. fails with:

```ts
'Executor "cursor" unavailable: missing required binaries in PATH: agent'
```

when `agent` is not found.

- [ ] **Step 2: Run the Cursor adapter tests to verify failure**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/cursor-executor.test.ts`
Expected: FAIL because `precheck()` is not implemented.

- [ ] **Step 3: Implement the executor-owned `agent` precheck**

Add the same private `command -v` pattern used in Tasks 3 and 4, but with required binaries `['agent']` and executor name `cursor`.

- [ ] **Step 4: Run the Cursor adapter tests to verify they pass**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/cursor-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/adapters/cursor-executor.ts packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts
git commit -m "feat(task-daemon): add cursor executor precheck"
```

### Task 6: Implement `TTCodexExecutor.precheck()`

**Files:**
- Modify: `packages/daemon/task/src/adapters/ttcodex-executor.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts`

- [ ] **Step 1: Add failing TTCodex precheck tests**

Add tests that assert `TTCodexExecutor.precheck()`:

1. succeeds when `ttadk` is found;
2. fails with:

```ts
'Executor "ttcodex" unavailable: missing required binaries in PATH: ttadk'
```

when `ttadk` is not found.

- [ ] **Step 2: Run the TTCodex adapter tests to verify failure**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/ttcodex-executor.test.ts`
Expected: FAIL because `precheck()` is not implemented.

- [ ] **Step 3: Implement the executor-owned `ttadk` precheck**

Use the same local `command -v` pattern, with required binaries `['ttadk']` and executor name `ttcodex`.

- [ ] **Step 4: Run the TTCodex adapter tests to verify they pass**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/ttcodex-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/adapters/ttcodex-executor.ts packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts
git commit -m "feat(task-daemon): add ttcodex executor precheck"
```

### Task 7: Implement the builtin no-op precheck

**Files:**
- Modify: `packages/daemon/task/src/adapters/cleanup-executor.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts`

- [ ] **Step 1: Add a failing cleanup precheck test**

In `packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts`, add:

```ts
it('returns success from precheck without inspecting PATH', async () => {
  const executor = new CleanupExecutor(tempBaseDir);
  await expect(executor.precheck(createEnv())).resolves.toEqual({ ok: true });
});
```

- [ ] **Step 2: Run the cleanup adapter tests to verify failure**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/cleanup-executor.test.ts`
Expected: FAIL because `CleanupExecutor` does not yet implement `precheck()`.

- [ ] **Step 3: Implement the no-op success precheck**

Add `precheck(_env)` to `CleanupExecutor` returning `{ ok: true }`.

Do not add any DB env validation in this feature.

- [ ] **Step 4: Run the cleanup adapter tests to verify they pass**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/cleanup-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/adapters/cleanup-executor.ts packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts
git commit -m "refactor(task-daemon): add builtin executor precheck"
```

### Task 8: Run the focused task-daemon verification suite

**Files:**
- Modify: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts`

- [ ] **Step 1: Run the focused suite**

Run:

```bash
pnpm --filter @local-agent/task-daemon vitest run \
  src/core/__tests__/task-orchestrator.test.ts \
  src/adapters/__tests__/claude-executor.test.ts \
  src/adapters/__tests__/claude-w-executor.test.ts \
  src/adapters/__tests__/cursor-executor.test.ts \
  src/adapters/__tests__/ttcodex-executor.test.ts \
  src/adapters/__tests__/cleanup-executor.test.ts
```

Expected: PASS.

- [ ] **Step 2: If any suite fails, fix only the contract mismatch or test assumptions it exposes**

Common likely fixes:

- orchestrator tests still mocking executors without `precheck`;
- adapter tests accidentally assuming `execute()` itself calls precheck;
- message assertions not matching the final simple error copy.

- [ ] **Step 3: Run the focused suite again**

Run the same command as Step 1.
Expected: PASS.

- [ ] **Step 4: No-op unless you had to fix something**

Do not commit here unless you made additional fixes while stabilizing the focused suite.

### Task 9: Run one broader task-daemon regression pass

**Files:**
- Reference only: `packages/daemon/task/src/task-poller.ts`
- Reference only: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Reference only: `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`

- [ ] **Step 1: Run the broader task-daemon tests most likely to catch integration regressions**

Run:

```bash
pnpm --filter @local-agent/task-daemon vitest run \
  src/__tests__/task-poller.test.ts \
  src/__tests__/task-poller-concurrent.test.ts \
  src/core/__tests__/task-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 2: If regressions appear, fix only the orchestration contract breakage they expose**

Likely areas:

- executor mocks used by poller-related tests;
- assumptions about executor instance construction;
- unexpected result-shape changes in orchestrator tests.

- [ ] **Step 3: Re-run the broader regression pass**

Run the same command as Step 1.
Expected: PASS.

- [ ] **Step 4: No-op unless you had to fix something**

Do not commit here unless you made additional fixes while running the broader regression pass.
