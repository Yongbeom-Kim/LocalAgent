# Claude-w Executor Rewrite Implementation Plan

**Goal:** Replace the old `ttadk` executor with a first-class `claude-w` executor everywhere, preserving Claude-style execution semantics while requiring the new `claude-w` model set.

**Architecture:** The rewrite is a clean break. Shared validation removes `ttadk` and introduces `claude-w` as the only non-Claude external executor. The task daemon swaps the TTADK adapter for a new `ClaudeWExecutor` that mirrors `ClaudeCliExecutor` subprocess behavior (`spawn`, `--model`, `-p -`, stdin piping, `--continue` fallback), while enrichment configs, fixtures, and current source-of-truth docs are updated to the new executor name.

**Tech Stack:** TypeScript, Vitest, Node.js child_process, js-yaml

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Replace `ttadk` with `claude-w` in `TASK_EXECUTORS` and `EXECUTOR_MODELS` |
| `packages/shared/src/__tests__/types.test.ts` | Modify | Update shared executor/model validation coverage for `claude-w` and rejection of old TTADK values |
| `packages/daemon/task/src/adapters/ttadk-executor.ts` | Remove | Retire the TTADK-specific adapter |
| `packages/daemon/task/src/adapters/claude-w-executor.ts` | Create | Implement the new `claude-w` adapter with Claude-style subprocess flow |
| `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts` | Remove | Retire TTADK-specific adapter tests |
| `packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts` | Create | Verify `claude-w` spawn args, stdin handling, continue fallback, and failure cases |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Modify | Route executor preference `claude-w` to `ClaudeWExecutor` while preserving the current shared-environment fallback lifecycle |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Modify | Update routing and fallback expectations from `ttadk` to `claude-w`, including shared-environment behavior |
| `packages/daemon/task-enrichment/config/local-agent.yaml` | Modify | Replace checked-in `ttadk` executor usage with `claude-w` |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Update config-validation fixtures from `ttadk` to `claude-w` |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Modify | Update queued executor fixtures from `ttadk` to `claude-w` |
| `docs/development/design/2026-04-02-claude-w-executor-rewrite-design.md` | Reference only | Source design for implementation |
| Current source-of-truth docs/examples under `docs/development/design/` and `docs/development/plans/` that still present `ttadk` as current behavior | Modify | Keep active documentation aligned with runtime naming |

---

### Task 1: Shared executor constants and model validation

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing shared validation assertions**

In `packages/shared/src/__tests__/types.test.ts`, replace TTADK-focused assertions with `claude-w` assertions:

```ts
it('defines claude-w models', () => {
  expect(EXECUTOR_MODELS['claude-w']).toEqual([
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.2-codex',
    'gpt-5.2',
    'glm-5',
    'glm-4.7',
    'kimi-k2.5',
    'minimax-2.5',
    'minimax-2.7',
  ]);
});

it('returns true for valid claude-w model', () => {
  expect(isValidExecutorModel('claude-w', 'gpt-5.4')).toBe(true);
  expect(isValidExecutorModel('claude-w', 'glm-5')).toBe(true);
});

it('returns false for removed ttadk executor and model names', () => {
  expect(isValidExecutorPreferences([
    { executor: 'ttadk', executor_model: 'gpt-5.4' },
  ])).toBe(false);
  expect(isValidExecutorModel('claude-w', 'glm-5-ttadk')).toBe(false);
});
```

Also update any existing `getExecutorModelOptions('ttadk')` expectation to `getExecutorModelOptions('claude-w')` with:

```ts
'gpt-5.4, gpt-5.3-codex, gpt-5.2-codex, gpt-5.2, glm-5, glm-4.7, kimi-k2.5, minimax-2.5, minimax-2.7'
```

- [ ] **Step 2: Run the shared test to verify it fails**

Run: `pnpm --filter @local-agent/shared vitest run src/__tests__/types.test.ts`
Expected: FAIL because `claude-w` is not yet a valid executor/model key.

- [ ] **Step 3: Replace executor constants and model list**

In `packages/shared/src/types.ts`, change the executor set and model map:

```ts
export const TASK_EXECUTORS = ['claude_code', 'claude-w', 'builtin'] as const;

export const EXECUTOR_MODELS = {
  claude_code: ['opus', 'sonnet', 'haiku'],
  'claude-w': [
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.2-codex',
    'gpt-5.2',
    'glm-5',
    'glm-4.7',
    'kimi-k2.5',
    'minimax-2.5',
    'minimax-2.7',
  ],
  builtin: ['none'],
} as const satisfies Record<TaskExecutorType, readonly string[]>;
```

Do not add alias handling or compatibility logic.

- [ ] **Step 4: Update remaining shared test expectations**

In `packages/shared/src/__tests__/types.test.ts`, replace every remaining `ttadk` expectation with `claude-w`, and add one direct rejection assertion for the removed executor name:

```ts
expect(isValidExecutorPreferences([
  { executor: 'ttadk', executor_model: 'gpt-5.4' },
])).toBe(false);
```

- [ ] **Step 5: Run shared tests to verify they pass**

Run: `pnpm --filter @local-agent/shared vitest run src/__tests__/types.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): replace ttadk executor with claude-w"
```

---

### Task 2: Add the new `ClaudeWExecutor` adapter

**Files:**
- Create: `packages/daemon/task/src/adapters/claude-w-executor.ts`
- Create: `packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts`
- Reference: `packages/daemon/task/src/adapters/claude-cli-executor.ts`

- [ ] **Step 1: Write the failing adapter tests**

Create `packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts` by copying the structure of `claude-cli-executor.test.ts`, then adapt the expectations to `claude-w`.

Use this fixture and first test body:

```ts
function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-456',
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'claude-w',
    executor_model: 'gpt-5.4',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    session_id: 'session-1',
    ...overrides,
  };
}

it('spawns claude-w with correct args and pipes payload via stdin', async () => {
  const child = createMockChild();
  mockSpawn.mockReturnValue(child as any);

  const resultPromise = executor.execute(createJobAttempt(), createEnv());
  emitOutput(child, '', '', 0);
  await resultPromise;

  expect(mockSpawn).toHaveBeenCalledWith(
    'claude-w',
    ['--dangerously-skip-permissions', '--model', 'gpt-5.4', '-p', '-'],
    { cwd: '/tmp/localagent-job-test' },
  );
  expect(child.stdinData).toBe('What is 2+2?');
});
```

Also add tests covering:
- repeated `--plugin-dir` flags
- `--append-system-prompt`
- empty payload failure
- spawn error failure
- non-zero close failure
- existing-workspace `--continue`
- continue failure then fresh fallback using thread-context input
- output truncation parity with `ClaudeCliExecutor`

- [ ] **Step 2: Run the new adapter test to verify it fails**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/claude-w-executor.test.ts`
Expected: FAIL because `claude-w-executor.ts` does not exist yet.

- [ ] **Step 3: Implement `ClaudeWExecutor` by mirroring `ClaudeCliExecutor`**

Create `packages/daemon/task/src/adapters/claude-w-executor.ts` with the same structure as `claude-cli-executor.ts`, but with `claude-w` naming and logger namespace.

Core implementation shape:

```ts
const args = [
  '--dangerously-skip-permissions',
  '--model', job.executor_model,
  ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
  ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
  ...(options.mode === 'continue' ? ['--continue'] : []),
  '-p', '-',
];

const child = spawn('claude-w', args, { cwd: env.workDir });
child.stdin.write(options.input);
child.stdin.end();
```

Preserve the existing helper shape from `ClaudeCliExecutor`:
- `execute()` checks empty payload
- `buildFreshInput()` prepends history when present
- `spawnClaudeW()` handles `continue` and fresh modes
- stdout/stderr are concatenated and truncated
- success is `code === 0`
- `error` event returns `{ status: 'failure', exit_code: null }`

- [ ] **Step 4: Run the adapter tests to verify they pass**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/claude-w-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/adapters/claude-w-executor.ts packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts
git commit -m "feat(task-daemon): add claude-w executor adapter"
```

---

### Task 3: Rewire task orchestrator from `ttadk` to `claude-w`

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
- Modify: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Rewrite the failing orchestrator test expectations**

In `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`:

1. Change the mock import from `../../adapters/ttadk-executor` to `../../adapters/claude-w-executor`.
2. Rename `mockTTADKExecute` to `mockClaudeWExecute`.
3. Replace the routing test with:

```ts
it('returns TaskResultSubmission from ClaudeWExecutor for claude-w jobs', async () => {
  const job = createJob({
    executors: [{ executor: 'claude-w', executor_model: 'gpt-5.4' }],
  });
  const result = await orchestrator.handle(job);

  expect(ClaudeWExecutor).toHaveBeenCalledTimes(1);
  expect(ClaudeCliExecutor).not.toHaveBeenCalled();
  expect(CleanupExecutor).not.toHaveBeenCalled();
  expect(mockClaudeWExecute).toHaveBeenCalledWith(
    expect.objectContaining({
      executor: 'claude-w',
      executor_model: 'gpt-5.4',
    }),
    mockEnv,
  );
  expect(result).toEqual(mockResultSubmission);
});
```

Also update any fallback fixtures or invalid-executor examples that still use `ttadk` as a valid value.
Preserve the orchestrator's current shared-environment lifecycle in these tests: setup should still happen once for non-cleanup jobs, teardown should remain unchanged, and fallback should reuse the same prepared environment rather than expecting a new setup per preference.

- [ ] **Step 2: Run orchestrator tests to verify they fail**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: FAIL because orchestrator still imports/resolves `TTADKExecutor`.

- [ ] **Step 3: Update the orchestrator import and resolver**

In `packages/daemon/task/src/core/task-orchestrator.ts`:

```ts
import { ClaudeWExecutor } from '../adapters/claude-w-executor';
```

Then replace the resolver branch:

```ts
if (executor === 'claude-w') return new ClaudeWExecutor();
```

Remove the `TTADKExecutor` import and branch entirely.
Do not redesign the fallback lifecycle here: keep the existing non-cleanup environment setup path, shared env reuse across executor preferences, cleanup/gc special cases, and current teardown behavior unchanged.

- [ ] **Step 4: Run orchestrator tests to verify they pass**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts
git commit -m "refactor(task-daemon): route external executor through claude-w"
```

---

### Task 4: Update config-validation fixtures and queue fixtures

**Files:**
- Modify: `packages/daemon/task-enrichment/config/local-agent.yaml`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`
- Modify: `packages/api/src/__tests__/services/rabbitmq.test.ts`

- [ ] **Step 1: Change checked-in config to the new executor value**

Update `packages/daemon/task-enrichment/config/local-agent.yaml`:

```yaml
rules:
  localagent-exec:
    executors:
      - executor: claude-w
        executor_model: gpt-5.4
```
```

Leave `localagent-plan` and builtin configs unchanged.

- [ ] **Step 2: Update enrichment-service fixtures to stop using `ttadk`**

In `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`, replace the default-rule fallback entry:

```ts
{ executor: 'ttadk', executor_model: 'gpt-5.4' }
```

with:

```ts
{ executor: 'claude-w', executor_model: 'gpt-5.4' }
```

Also add one rejection assertion that confirms old values fail normal validation:

```ts
const service = EnrichmentService.fromObject({
  rules: {
    bad_rule: {
      executors: [{ executor: 'ttadk', executor_model: 'gpt-5.4' }],
    },
  },
});
expect(service.enrich(createTask({ task_type: 'bad_rule' }), TEST_SESSION_ID).type).toBe('rejected');
```

- [ ] **Step 3: Update RabbitMQ queue fixtures**

In `packages/api/src/__tests__/services/rabbitmq.test.ts`, replace every queue payload containing:

```ts
executors: [{ executor: 'ttadk', executor_model: 'gpt-5.4' }]
```

with:

```ts
executors: [{ executor: 'claude-w', executor_model: 'gpt-5.4' }]
```

Update duplicate-ID assertions the same way.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `pnpm --filter @local-agent/task-enrichment-daemon vitest run src/__tests__/enrichment-service.test.ts`
Expected: PASS

Run: `pnpm --filter @local-agent/api vitest run src/__tests__/services/rabbitmq.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/config/local-agent.yaml packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts packages/api/src/__tests__/services/rabbitmq.test.ts
git commit -m "chore(config): replace ttadk fixtures with claude-w"
```

---

### Task 5: Replace active documentation/examples and remove TTADK adapter files

**Files:**
- Remove: `packages/daemon/task/src/adapters/ttadk-executor.ts`
- Remove: `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts`
- Modify: current source-of-truth docs/examples that still present `ttadk` as current behavior

- [ ] **Step 1: Remove retired adapter files after replacement is wired in**

Delete:
- `packages/daemon/task/src/adapters/ttadk-executor.ts`
- `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts`

Verify no remaining source imports reference them.

- [ ] **Step 2: Update active design/plan docs that still present TTADK as current architecture**

At minimum, revise these docs so they no longer instruct an implementer to use TTADK as the current executor:
- `docs/development/design/2026-03-27-executor-model-selection-design.md`
- `docs/development/design/2026-03-30-executor-preference-array-design.md`
- `docs/development/plans/2026-03-27-executor-model-selection.md`
- `docs/development/plans/2026-03-30-executor-preference-array.md`

Keep edits narrow:
- replace active executor examples from `ttadk` to `claude-w`
- replace TTADK-specific model names with the new `claude-w` list where the docs are describing current behavior
- preserve intentionally historical docs that describe past TTADK work unless they present copy-pasteable current-state guidance
- do not rewrite unrelated historical context sections beyond what is needed to prevent misleading copy-paste guidance

- [ ] **Step 3: Search for remaining live TTADK references**

Run: `rg -n "ttadk|TTADK|glm-5-ttadk|glm-4.7-ttadk" packages docs/development`
Expected: only intentionally historical/archive references remain, or no matches in active source/config/tests.

- [ ] **Step 4: Run final focused verification**

Run: `pnpm --filter @local-agent/shared vitest run src/__tests__/types.test.ts && pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/claude-w-executor.test.ts src/core/__tests__/task-orchestrator.test.ts && pnpm --filter @local-agent/task-enrichment-daemon vitest run src/__tests__/enrichment-service.test.ts && pnpm --filter @local-agent/api vitest run src/__tests__/services/rabbitmq.test.ts`
Expected: PASS across all touched packages.

- [ ] **Step 5: Commit**

```bash
git add docs/development/design/2026-03-27-executor-model-selection-design.md docs/development/design/2026-03-30-executor-preference-array-design.md docs/development/plans/2026-03-27-executor-model-selection.md docs/development/plans/2026-03-30-executor-preference-array.md
git add -u packages/daemon/task/src/adapters/ttadk-executor.ts packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts
git commit -m "refactor(docs): remove ttadk as active executor"
```
