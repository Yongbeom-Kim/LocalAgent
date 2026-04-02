# Cursor Agent CLI executor — implementation plan

**Goal:** Add `cursor_agent` to `TaskExecutorType`, validate dynamic Cursor model ids in `@local-agent/shared`, and implement `CursorAgentExecutor` in the task daemon with orchestrator routing and tests, per `docs/development/design/2026-04-02-cursor-agent-executor-design.md`.

**Architecture:** A thin `spawn('agent', ...)` adapter mirroring `ClaudeCliExecutor` (continue vs fresh, payload/history, truncation, logging). Shared package uses a regex-bounded model id for `cursor_agent` plus a conditional `ExecutorModelType` so typing stays sound.

**Tech stack:** Node `child_process.spawn`, Vitest, existing `@local-agent/shared` types.

**Design doc:** `docs/development/design/2026-04-02-cursor-agent-executor-design.md`

---

## File map

| File | Action |
|------|--------|
| `packages/shared/src/types.ts` | Add `cursor_agent` to `TASK_EXECUTORS`; add `EXECUTOR_MODELS.cursor_agent` example tuple; add `CURSOR_AGENT_MODEL_ID` regex + max length; branch in `isValidExecutorModel`; conditional `ExecutorModelType`; update `getExecutorModelOptions` |
| `packages/shared/src/index.ts` | Export any new constants if needed (only if consumed externally) |
| `packages/shared/src/__tests__/types.test.ts` | Tests for `cursor_agent` models and `EXECUTOR_MODELS` entry |
| `packages/daemon/task/src/adapters/cursor-agent-executor.ts` | **Create** — executor class |
| `packages/daemon/task/src/adapters/__tests__/cursor-agent-executor.test.ts` | **Create** — spawn mock tests |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Import + `resolveExecutor` branch |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Mock `CursorAgentExecutor`, add routing test |

---

### Task 1: Shared types — `ExecutorModelType` and validation

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `types.test.ts`:

```ts
  it('defines cursor_agent example models', () => {
    expect(EXECUTOR_MODELS.cursor_agent).toEqual([
      'auto',
      'composer-2-fast',
      'gpt-5.4-medium',
    ]);
  });

  it('validates cursor_agent model ids by pattern', () => {
    expect(isValidExecutorModel('cursor_agent', 'auto')).toBe(true);
    expect(isValidExecutorModel('cursor_agent', 'gpt-5.3-codex-high-fast')).toBe(true);
    expect(isValidExecutorModel('cursor_agent', 'claude-4.6-sonnet-medium-thinking')).toBe(true);
    expect(isValidExecutorModel('cursor_agent', '')).toBe(false);
    expect(isValidExecutorModel('cursor_agent', 'bad id')).toBe(false);
    expect(isValidExecutorModel('cursor_agent', 'x'.repeat(200))).toBe(false);
  });

  it('returns descriptive options string for cursor_agent', () => {
    expect(getExecutorModelOptions('cursor_agent')).toContain('auto');
    expect(getExecutorModelOptions('cursor_agent')).toMatch(/agent models/i);
  });
```

Adjust expected example tuple and regex behavior to match implementation in Step 3.

- [ ] **Step 2: Run tests — expect failures**

Run: `pnpm --filter @local-agent/shared vitest run src/__tests__/types.test.ts`  
Expected: FAIL (unknown executor / missing export / assertion mismatch).

- [ ] **Step 3: Implement in `types.ts`**

1. Append `'cursor_agent'` to `TASK_EXECUTORS` after existing entries (`claude_code`, `claude-w`, `builtin`) to minimize churn.

2. Add constants, e.g.:

```ts
export const CURSOR_AGENT_MODEL_MAX_LEN = 128;
export const CURSOR_AGENT_MODEL_ID = /^[a-zA-Z0-9._-]+$/;
```

3. Add `EXECUTOR_MODELS.cursor_agent` as `['auto', 'composer-2-fast', 'gpt-5.4-medium'] as const` (examples only).

4. Replace `ExecutorModelType` with:

```ts
export type ExecutorModelType<T extends TaskExecutorType = TaskExecutorType> =
  T extends 'cursor_agent' ? string : (typeof EXECUTOR_MODELS)[T][number];
```

5. Extend `isValidExecutorModel` (keep return type `model is ExecutorModelType` to match the rest of the file):

```ts
export function isValidExecutorModel(
  executor: TaskExecutorType,
  model: unknown,
): model is ExecutorModelType {
  if (typeof model !== 'string') return false;
  if (executor === 'cursor_agent') {
    return (
      model.length > 0 &&
      model.length <= CURSOR_AGENT_MODEL_MAX_LEN &&
      CURSOR_AGENT_MODEL_ID.test(model)
    );
  }
  return (EXECUTOR_MODELS[executor] as readonly string[]).includes(model);
}
```

6. Extend `getExecutorModelOptions` for `cursor_agent` with a string like:  
   `auto, composer-2-fast, gpt-5.4-medium, … (use any id from \`agent models\`; pattern-validated)`  
   using the example tuple to build the prefix:  
   `${EXECUTOR_MODELS.cursor_agent.join(', ')}, … (any id from agent models; pattern-validated)`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @local-agent/shared vitest run src/__tests__/types.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): add cursor_agent executor type and model validation"
```

---

### Task 2: CursorAgentExecutor adapter

**Files:**
- Create: `packages/daemon/task/src/adapters/cursor-agent-executor.ts`
- Create: `packages/daemon/task/src/adapters/__tests__/cursor-agent-executor.test.ts`

Pattern source: `packages/daemon/task/src/adapters/claude-cli-executor.ts` (structure, logging, truncate, close/error handling). **Do not use stdin** — append **one** prompt argv after `--`.

- [ ] **Step 1: Write failing test** (minimal: one success case mocking `spawn`)

In `cursor-agent-executor.test.ts`, copy mock helpers from `claude-cli-executor.test.ts` but assert:

- `spawn` called with `'agent'` as command
- `args` includes `--print`, `--trust`, `--force`, `--workspace`, `env.workDir`, `--model`, `job.executor_model`, `--output-format`, `text`, `--`, `expectedPrompt`
- options: `{ cwd: env.workDir }` (plus `shell: false` if you add it)
- Without `isExistingWorkspace`, no `--continue`

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/cursor-agent-executor.test.ts`  
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `CursorAgentExecutor`**

Copy **control flow** from `claude-cli-executor.ts` `execute()` / `spawnClaude()`:

- `execute`: if no payload → failure object; if `env.isExistingWorkspace` → `spawnAgent(..., { mode: 'continue', input: job.payload })`; on non-success log warn and fall back; else `spawnAgent(..., { mode: 'fresh', input: buildFreshInput(job) })`.
- `buildFreshInput`: identical to Claude — history wraps payload when present.
- Before spawning, turn `input` into the final argv prompt string: if `job.system_prompt`, use  
  `` `--- System ---\n${job.system_prompt}\n--- User ---\n${input}` `` (or equivalent delimiters).

Implement spawning with **`child_process.spawn` + `new Promise`** like `spawnClaude` (there is no shared `spawnPromise` helper). Example argv:

```ts
const args = [
  '--print', '--trust', '--force',
  '--workspace', env.workDir,
  '--model', job.executor_model,
  '--output-format', 'text',
  ...(mode === 'continue' ? ['--continue'] : []),
  '--',
  promptString,
];
// spawn('agent', args, { cwd: env.workDir, shell: false })
```

**Do not** wrap history into the prompt when `mode === 'continue'`; only `job.payload` is used (same as Claude).

If `env.pluginDirs.length > 0`, `logger.debug` once that plugin dirs are ignored for `cursor_agent`.

- [ ] **Step 4: Expand tests** (failure exit code, spawn error, empty payload, continue + fallback)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/cursor-agent-executor.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task/src/adapters/cursor-agent-executor.ts packages/daemon/task/src/adapters/__tests__/cursor-agent-executor.test.ts
git commit -m "feat(task-daemon): add CursorAgentExecutor"
```

---

### Task 3: Orchestrator wiring

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
- Modify: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Add mock + test first**

In `task-orchestrator.test.ts` (mirror `ClaudeWExecutor`):

- `vi.mock('../../adapters/cursor-agent-executor', ...)` with `mockCursorAgentExecute`
- Import `CursorAgentExecutor`; in `beforeEach` call `mockCursorAgentExecute.mockClear()`, `vi.mocked(CursorAgentExecutor).mockClear()`, and assert `ClaudeCliExecutor` / `ClaudeWExecutor` **not** called for the `cursor_agent`-only job (same style as existing tests around lines 155–176)
- New test: job with `executors: [{ executor: 'cursor_agent', executor_model: 'auto' }]` → `CursorAgentExecutor` constructed once, `execute` receives `JobAttempt` with `executor: 'cursor_agent'`

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/core/__tests__/task-orchestrator.test.ts`  
Expected: FAIL (unknown executor throw path or mock not wired).

- [ ] **Step 3: Implement**

In `task-orchestrator.ts`: import `CursorAgentExecutor`; in `resolveExecutor`:  
`if (executor === 'cursor_agent') return new CursorAgentExecutor();`

- [ ] **Step 4: Run full task-daemon core + adapter tests**

Run:  
`pnpm --filter @local-agent/task-daemon vitest run src/core/__tests__/task-orchestrator.test.ts src/adapters/__tests__/cursor-agent-executor.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts
git commit -m "feat(task-daemon): route cursor_agent jobs to CursorAgentExecutor"
```

---

### Task 4: Regression sweep

- [ ] **Step 1: Run shared + task-daemon unit suites touched**

```bash
pnpm --filter @local-agent/shared vitest run && pnpm --filter @local-agent/task-daemon vitest run
```

Expected: all PASS.

- [ ] **Step 2: Optional manual smoke** (on a logged-in host)

Run a one-off job or local script invoking `agent --print ...` from the design doc; not required for CI if CI lacks Cursor auth.

- [ ] **Step 3: Final commit** (if only doc tweaks)

None unless fixing drift.

---

## Notes for implementer

- Re-read `claude-cli-executor.ts` for edge cases (missing payload, stdout/stderr truncation constants).
- Reconcile `CURSOR_AGENT_MODEL_ID` with live `agent models` output before release if any id falls outside `[a-zA-Z0-9._-]`.
- Any **new** exports from `types.ts` meant for other packages must be re-exported from `packages/shared/src/index.ts` (barrel). Internal-only constants can stay unexported from the barrel.
- Adapter test file imports the SUT via `../cursor-agent-executor` from `adapters/__tests__/`.
- After implementation, if `executor` appears in API fixtures elsewhere (e.g. RabbitMQ tests), extend only if those tests enumerate executor literals; grep for `'claude_code'`, `'claude-w'` when adding cross-package consistency checks.
