# TTCodex Executor Implementation Plan

**Goal:** Add a new `ttcodex` executor that runs Codex through TTADK with explicit resume behavior and TTADK output sanitization.

**Architecture:** Extend the shared executor/model contract with `ttcodex`, add a dedicated `TTCodexExecutor` in the task daemon, and wire existing validation/routing surfaces to accept the new executor. The adapter will build TTADK `-a` commands for fresh and resume modes, ignore marketplace plugin forwarding in v1, and normalize wrapper output before returning results.

**Tech Stack:** TypeScript, Vitest, Node.js child processes, existing LocalAgent monorepo patterns

---

I'm using the writing-plans skill to create the implementation plan.

## File Structure

- `packages/shared/src/types.ts`
  Adds `ttcodex` to the canonical executor enum and model allowlist.
- `packages/shared/src/index.ts`
  Re-exports any shared helpers/types changed by the new executor contract.
- `packages/shared/src/__tests__/types.test.ts`
  Locks the shared `ttcodex` validation contract.
- `packages/daemon/task/src/adapters/ttcodex-executor.ts`
  Implements TTADK Codex execution, prompt building, continue fallback, and stream sanitization.
- `packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts`
  Verifies adapter command construction and result normalization.
- `packages/daemon/task/src/core/task-orchestrator.ts`
  Adds routing for `ttcodex`.
- `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`
  Verifies orchestrator integration.
- `packages/api/src/routes/tasks.ts`
  May only need light touch if executor/model options text is asserted indirectly through shared helpers.
- `packages/api/src/__tests__/routes/tasks.test.ts`
  Validates task submission acceptance/rejection for `ttcodex`.
- `packages/api/src/routes/jobs.ts`
  Validates `executors: ExecutorPreference[]` via `isValidExecutorPreferences()` (this is the task-daemon contract boundary).
- `packages/api/src/__tests__/routes/jobs.test.ts`
  Validates job submission acceptance/rejection for `ttcodex` preferences.
- `packages/daemon/lark-listener/src/message-handler.ts`
  Updates executor lists in user-facing parsing/help if present.
- `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
  Updates any example/help strings or defaults that enumerate executors.
- `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
  Covers listener-facing executor list changes.
- `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`
  Covers submitter-facing executor list changes.
- `packages/daemon/task-enrichment/src/enrichment-service.ts`
  Touch only if the service itself renders executor/model help or fixtures need live updates.
- `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`
  Covers executor/model validation fixtures affected by `ttcodex`.

### Task 1: Extend the shared executor contract

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing shared-type assertions**

Add or update tests in `packages/shared/src/__tests__/types.test.ts` to assert:

```ts
expect(isTaskExecutorType('ttcodex')).toBe(true);
expect(EXECUTOR_MODELS.ttcodex).toEqual(['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex']);
expect(isValidExecutorModel('ttcodex', 'gpt-5.4')).toBe(true);
expect(isValidExecutorModel('ttcodex', 'gpt-5.1')).toBe(false);
expect(getExecutorModelOptions('ttcodex')).toBe('gpt-5.4, gpt-5.3-codex, gpt-5.2-codex');
```

- [ ] **Step 2: Run shared tests to verify the new assertions fail**

Run: `pnpm --filter @local-agent/shared vitest run src/__tests__/types.test.ts`
Expected: FAIL because `ttcodex` is not yet present in the shared contract.

- [ ] **Step 3: Implement the shared `ttcodex` contract**

Update `packages/shared/src/types.ts`:

- Add `'ttcodex'` to `TASK_EXECUTORS`.
- Add `ttcodex` to the `EXECUTOR_MODELS` map.

Concrete edits (leave all existing entries unchanged; only add the new values):

```ts
export const TASK_EXECUTORS = ['claude', 'claude-w', 'builtin', 'cursor', 'ttcodex'] as const;

export const EXECUTOR_MODELS = {
  // ... existing entries unchanged ...
  ttcodex: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'],
} as const satisfies Record<TaskExecutorType, readonly string[]>;
```

Re-export from `packages/shared/src/index.ts` if the file currently enumerates changed exports explicitly.

- [ ] **Step 4: Run shared tests to verify they pass**

Run: `pnpm --filter @local-agent/shared vitest run src/__tests__/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat: add ttcodex shared executor contract"
```

### Task 2: Implement the `TTCodexExecutor` adapter

**Files:**
- Create: `packages/daemon/task/src/adapters/ttcodex-executor.ts`
- Test: `packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts`

- [ ] **Step 1: Write failing adapter tests for fresh, resume, and sanitization flows**

Create `packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts` patterned after the existing executor adapter tests. Cover at least:

```ts
it('spawns ttadk with fresh exec command', ...)
it('spawns ttadk with resume --last for existing workspaces', ...)
it('falls back to fresh when resume fails', ...)
it('prepends system prompt delimiters', ...)
it('wraps history on fresh fallback', ...)
it('ignores pluginDirs and does not forward them', ...)
it('strips known TTADK stdout wrapper lines', ...)
it('promotes sanitized stderr to stdout when stdout is empty after sanitization', ...)
it('includes --skip-git-repo-check in both fresh and resume action args', ...)
it('preserves sanitized stderr (do not blank it when promoting to stdout)', ...)
```

Use representative fixtures such as:

```ts
const ttadkStdout = `TikTok AI-Driven Development Kit\nVersion 0.3.13\n🚀 Launching Codex CLI...\n\n\`HELLO\``;
const codexStderr = `OpenAI Codex v0.118.0\n...\nNot inside a trusted directory and --skip-git-repo-check was not specified.`;
```

- [ ] **Step 2: Run the adapter test file to verify failure**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/ttcodex-executor.test.ts`
Expected: FAIL because the adapter file does not exist yet.

- [ ] **Step 3: Implement the adapter with explicit command builders and sanitizers**

Create `packages/daemon/task/src/adapters/ttcodex-executor.ts` with:

```ts
export class TTCodexExecutor implements TaskExecutor {
  async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    // empty payload guard
    // continue-first for existing workspace unless skipContinue
    // fallback to fresh on continue failure
  }

  private buildFreshInput(job: JobAttempt): string {
    // existing thread-context wrapper pattern
  }

  private buildPrompt(job: JobAttempt, input: string): string {
    // prepend system block when present
  }

  private buildActionArg(mode: 'fresh' | 'continue', prompt: string): string {
    // fresh: exec --skip-git-repo-check "..."
    // continue: exec resume --last --skip-git-repo-check "..."
  }

  private sanitizeOutput(text: string): string {
    // remove only known TTADK wrapper lines
  }
}
```

Implementation requirements:

- use `spawn('ttadk', ['code', '-m', job.executor_model, '-t', 'codex', '-a', actionArg], { cwd: env.workDir, shell: false })`
- do not pass plugin directories; add a code comment explaining the v1 limitation
- sanitize streams before returning
- if sanitized stdout is empty and sanitized stderr is non-empty, set result `stdout` to sanitized stderr
- always return `stderr` as the sanitized stderr stream (do not discard it when promoting stderr to stdout)
- truncate final returned streams with `truncate(..., MAX_RESULT_OUTPUT_BYTES)`

Concrete implementation details to avoid ambiguity:

- Prompt escaping for `-a`:

```ts
const quotedPrompt = JSON.stringify(prompt); // includes surrounding double quotes
if (mode === 'fresh') return `exec --skip-git-repo-check ${quotedPrompt}`;
return `exec resume --last --skip-git-repo-check ${quotedPrompt}`;
```

- Sanitization should be line-based and strictly allowlist-driven (remove only known TTADK wrapper lines). One workable approach:

```ts
function sanitize(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // ASCII-art banner lines
    if (/^[_|/\\ ]{10,}$/.test(trimmed)) continue;

    // Stable TTADK wrapper lines
    if (trimmed === 'TikTok AI-Driven Development Kit') continue;
    if (trimmed.startsWith('Version ')) continue;
    if (trimmed.startsWith('Team: ')) continue;
    if (trimmed.includes('Launching Codex CLI')) continue;
    if (trimmed.includes('Login successful')) continue; // email address varies
    if (/codebase\s+repo/i.test(trimmed)) continue; // avoids relying on Unicode literals

    kept.push(line);
  }

  return kept.join('\n').trim();
}
```

This matches the observed wrapper output without stripping arbitrary Codex transcript or failure text.

Note: promotion rule is intended to make user-facing `stdout` useful when TTADK prints only wrapper noise to stdout. It must not hide actionable errors: keep `stderr` populated with the sanitized stderr content.

- [ ] **Step 4: Run adapter tests to verify they pass**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/ttcodex-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/adapters/ttcodex-executor.ts packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts
git commit -m "feat: add ttcodex task executor"
```

### Task 3: Wire the task orchestrator to the new adapter

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
- Test: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Add a failing orchestrator routing test**

Update `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` so one case asserts that a job preference of `{ executor: 'ttcodex', executor_model: 'gpt-5.4' }` resolves to the new adapter and returns its result.

Concrete test wiring (patterned after existing executor mocks in that file):

- Add a `vi.mock('../../adapters/ttcodex-executor', ...)` block.
- Add `const mockTTCodexExecute = vi.fn().mockResolvedValue(mockResultSubmission);`.
- Import `TTCodexExecutor` and clear the mock in `beforeEach()`.
- Assert `TTCodexExecutor` is instantiated and `mockTTCodexExecute` called with the expected `JobAttempt`.

- [ ] **Step 2: Run the orchestrator test file to verify failure**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: FAIL because `resolveExecutor()` does not yet recognize `ttcodex`.

- [ ] **Step 3: Update routing in `task-orchestrator.ts`**

Add the import and branch:

```ts
import { TTCodexExecutor } from '../adapters/ttcodex-executor';

if (executor === 'ttcodex') return new TTCodexExecutor();
```

- [ ] **Step 4: Run the orchestrator test file again**

Run: `pnpm --filter @local-agent/task-daemon vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts
git commit -m "feat: route jobs to ttcodex executor"
```

### Task 4: Update API validation and user-facing executor surfaces

**Files:**
- Modify: `packages/api/src/routes/tasks.ts`
- Test: `packages/api/src/__tests__/routes/tasks.test.ts`
- Modify: `packages/api/src/routes/jobs.ts`
- Test: `packages/api/src/__tests__/routes/jobs.test.ts`
- Modify: `packages/daemon/lark-listener/src/message-handler.ts`
- Test: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
- Test: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`

- [ ] **Step 1: Add failing API and listener assertions for `ttcodex`**

Update affected tests to assert:

- task submission accepts `executor: 'ttcodex'` with valid models
- invalid `ttcodex` model strings are rejected with the shared options string
- any help/example text or enumerated executor lists now include `ttcodex`

- [ ] **Step 2: Run targeted API and listener tests to confirm failures**

Run: `pnpm --filter @local-agent/api vitest run src/__tests__/routes/tasks.test.ts`
Expected: FAIL if route or tests still assume the old executor set.

Run: `pnpm --filter @local-agent/api vitest run src/__tests__/routes/jobs.test.ts`
Expected: FAIL if `/jobs` validation rejects `ttcodex` executor preferences.

Run: `pnpm --filter @local-agent/lark-listener-daemon vitest run src/__tests__/message-handler.test.ts src/__tests__/task-submitter.test.ts`
Expected: FAIL where executor lists or help text are asserted.

- [ ] **Step 3: Update the affected surfaces**

Adjust code only where live user-facing or validation behavior depends on explicit executor/model lists. Use shared helpers instead of duplicating strings where practical.

Examples of the desired end state:

```ts
executors: [{ executor: 'ttcodex', executor_model: 'gpt-5.4' }]
```

and help text that reflects `ttcodex` as a valid executor.

- [ ] **Step 4: Re-run targeted API and listener tests**

Run: `pnpm --filter @local-agent/api vitest run src/__tests__/routes/tasks.test.ts`
Expected: PASS.

Run: `pnpm --filter @local-agent/api vitest run src/__tests__/routes/jobs.test.ts`
Expected: PASS.

Run: `pnpm --filter @local-agent/lark-listener-daemon vitest run src/__tests__/message-handler.test.ts src/__tests__/task-submitter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/tasks.ts packages/api/src/__tests__/routes/tasks.test.ts packages/api/src/routes/jobs.ts packages/api/src/__tests__/routes/jobs.test.ts packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts packages/daemon/lark-listener/src/adapters/task-submitter.ts packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts
git commit -m "feat: expose ttcodex in task submission surfaces"
```

### Task 5: Update enrichment validation fixtures and run focused verification

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`
- Test: `packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts`
- Test: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`
- Test: `packages/shared/src/__tests__/types.test.ts`
- Test: `packages/api/src/__tests__/routes/tasks.test.ts`
- Test: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Test: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`

- [ ] **Step 1: Add or update enrichment fixtures for the live executor set**

If `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` contains explicit executor/model fixtures, add at least one `ttcodex` case so shared validation behavior is exercised from enrichment too.

- [ ] **Step 2: Run the enrichment tests to verify any fixture mismatch**

Run: `pnpm --filter @local-agent/task-enrichment-daemon vitest run src/__tests__/enrichment-service.test.ts`
Expected: FAIL only if enrichment fixtures or assertions still hard-code the old executor set.

- [ ] **Step 3: Make the minimum enrichment-side updates**

Only change `packages/daemon/task-enrichment/src/enrichment-service.ts` if there is live logic or copy that enumerates valid executors. Otherwise keep the change in tests/fixtures only.

- [ ] **Step 4: Run the focused regression suite**

Run:

```bash
pnpm --filter @local-agent/shared vitest run src/__tests__/types.test.ts
pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/ttcodex-executor.test.ts src/core/__tests__/task-orchestrator.test.ts
pnpm --filter @local-agent/api vitest run src/__tests__/routes/tasks.test.ts
pnpm --filter @local-agent/api vitest run src/__tests__/routes/jobs.test.ts
pnpm --filter @local-agent/lark-listener-daemon vitest run src/__tests__/message-handler.test.ts src/__tests__/task-submitter.test.ts
pnpm --filter @local-agent/task-enrichment-daemon vitest run src/__tests__/enrichment-service.test.ts
```

Expected: PASS across all targeted suites.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "test: cover ttcodex across enrichment and focused suites"
```

### Task 6: Final review and documentation sync

**Files:**
- Modify: `docs/development/design/2026-04-02-ttcodex-executor-design.md`
- Modify: `docs/development/plans/2026-04-02-ttcodex-executor.md`

- [ ] **Step 1: Re-read the design and implementation plan after code work lands**

Check that the implemented command shape, no-plugin limitation, and stdout/stderr sanitization behavior still match the written design.

- [ ] **Step 2: If implementation diverged, update the docs immediately**

Keep the docs as source-of-truth. Do not leave stale command examples or outdated sanitizer rules.

- [ ] **Step 3: Run `git diff --check`**

Run: `git diff --check`
Expected: no whitespace or patch-format issues.

- [ ] **Step 4: Record the final focused verification commands in the PR/summary**

Include the exact Vitest commands from Task 5 so reviewers can replay them.

- [ ] **Step 5: Commit**

```bash
git add docs/development/design/2026-04-02-ttcodex-executor-design.md docs/development/plans/2026-04-02-ttcodex-executor.md
git commit -m "docs: finalize ttcodex design and implementation plan"
```
