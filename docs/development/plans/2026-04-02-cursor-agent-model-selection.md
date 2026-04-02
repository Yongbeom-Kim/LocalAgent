# Cursor Agent Model Selection Implementation Plan

**Goal:** Replace `cursor_agent` freeform model validation with a shared static allowlist so enrichment config chooses Cursor models the same way as the other executors.

**Architecture:** The implementation is intentionally centralized in `@local-agent/shared`. `packages/shared/src/types.ts` becomes the sole source of truth for Cursor model ids, and existing consumers in the enrichment daemon and API inherit the stricter behavior without needing new config shapes or route fields. Follow-up work in tests and docs verifies that the new contract is enforced everywhere and that older regex-based design notes are not mistaken for the active spec.

**Tech Stack:** TypeScript, Vitest, Express route tests, YAML-backed enrichment config, local `agent models` snapshot from 2026-04-02

**Design doc:** `docs/development/design/2026-04-02-cursor-agent-model-selection-design.md`

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Replace Cursor regex/freeform validation with static allowlist membership and uniform typing |
| `packages/shared/src/__tests__/types.test.ts` | Modify | Assert the exact Cursor allowlist and the new exact-match validation behavior |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Prove enrichment accepts listed Cursor ids and rejects unlisted ones through shared validation |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Modify | Prove `/jobs` accepts listed Cursor ids and rejects unlisted ones through shared validation |
| `docs/development/design/2026-04-02-cursor-agent-executor-design.md` | Modify | Mark the old freeform-validation guidance as superseded for model validation |
| `docs/development/plans/2026-04-02-cursor-agent-executor.md` | Modify | Mark the old regex/pattern-validation implementation plan as historical or superseded |

### Important non-changes

- `packages/daemon/task-enrichment/src/enrichment-service.ts` should not need production code changes if shared validation is updated correctly.
- `packages/api/src/routes/jobs.ts` should not need production code changes unless the implementer discovers an inconsistency during test execution.
- `packages/cli/src/commands/submit.ts` should remain unchanged because task submission does not choose executors/models.

---

### Task 1: Replace shared Cursor validation with a static allowlist

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/shared/src/__tests__/types.test.ts`, replace the current Cursor-specific assertions that assume “example models + pattern validation” with exact allowlist assertions.

Update the `EXECUTOR_MODELS` test:

```ts
  it('defines cursor_agent models from the approved static snapshot', () => {
    expect(EXECUTOR_MODELS.cursor_agent).toEqual([
      'auto',
      'composer-2-fast',
      'composer-2',
      'composer-1.5',
      'gpt-5.3-codex-low',
      'gpt-5.3-codex-low-fast',
      'gpt-5.3-codex',
      'gpt-5.3-codex-fast',
      'gpt-5.3-codex-high',
      'gpt-5.3-codex-high-fast',
      'gpt-5.3-codex-xhigh',
      'gpt-5.3-codex-xhigh-fast',
      'gpt-5.2',
      'gpt-5.3-codex-spark-preview-low',
      'gpt-5.3-codex-spark-preview',
      'gpt-5.3-codex-spark-preview-high',
      'gpt-5.3-codex-spark-preview-xhigh',
      'gpt-5.2-codex-low',
      'gpt-5.2-codex-low-fast',
      'gpt-5.2-codex',
      'gpt-5.2-codex-fast',
      'gpt-5.2-codex-high',
      'gpt-5.2-codex-high-fast',
      'gpt-5.2-codex-xhigh',
      'gpt-5.2-codex-xhigh-fast',
      'gpt-5.1-codex-max-low',
      'gpt-5.1-codex-max-low-fast',
      'gpt-5.1-codex-max-medium',
      'gpt-5.1-codex-max-medium-fast',
      'gpt-5.1-codex-max-high',
      'gpt-5.1-codex-max-high-fast',
      'gpt-5.1-codex-max-xhigh',
      'gpt-5.1-codex-max-xhigh-fast',
      'gpt-5.4-high',
      'gpt-5.4-high-fast',
      'gpt-5.4-xhigh-fast',
      'claude-4.6-opus-high-thinking',
      'gpt-5.4-low',
      'gpt-5.4-medium',
      'gpt-5.4-medium-fast',
      'gpt-5.4-xhigh',
      'claude-4.6-sonnet-medium',
      'claude-4.6-sonnet-medium-thinking',
      'claude-4.6-opus-high',
      'claude-4.6-opus-max',
      'claude-4.6-opus-max-thinking',
      'claude-4.5-opus-high',
      'claude-4.5-opus-high-thinking',
      'gpt-5.2-low',
      'gpt-5.2-low-fast',
      'gpt-5.2-fast',
      'gpt-5.2-high',
      'gpt-5.2-high-fast',
      'gpt-5.2-xhigh',
      'gpt-5.2-xhigh-fast',
      'gemini-3.1-pro',
      'gpt-5.4-mini-none',
      'gpt-5.4-mini-low',
      'gpt-5.4-mini-medium',
      'gpt-5.4-mini-high',
      'gpt-5.4-mini-xhigh',
      'gpt-5.4-nano-none',
      'gpt-5.4-nano-low',
      'gpt-5.4-nano-medium',
      'gpt-5.4-nano-high',
      'gpt-5.4-nano-xhigh',
      'grok-4-20',
      'grok-4-20-thinking',
      'claude-4.5-sonnet',
      'claude-4.5-sonnet-thinking',
      'gpt-5.1-low',
      'gpt-5.1',
      'gpt-5.1-high',
      'gemini-3-flash',
      'gpt-5.1-codex-mini-low',
      'gpt-5.1-codex-mini',
      'gpt-5.1-codex-mini-high',
      'claude-4-sonnet',
      'claude-4-sonnet-1m',
      'claude-4-sonnet-thinking',
      'claude-4-sonnet-1m-thinking',
      'gpt-5-mini',
      'kimi-k2.5',
    ]);
  });
```

Replace the current Cursor validation test block with exact-match expectations:

```ts
  it('returns true for listed cursor_agent models', () => {
    expect(isValidExecutorModel('cursor_agent', 'auto')).toBe(true);
    expect(isValidExecutorModel('cursor_agent', 'gpt-5.4-medium-fast')).toBe(true);
    expect(isValidExecutorModel('cursor_agent', 'claude-4.6-sonnet-medium-thinking')).toBe(true);
  });

  it('returns false for unlisted cursor_agent models', () => {
    expect(isValidExecutorModel('cursor_agent', 'not-a-real-model')).toBe(false);
    expect(isValidExecutorModel('cursor_agent', 'bad id with spaces')).toBe(false);
    expect(isValidExecutorModel('cursor_agent', 'gpt-5.4-medium-ultra')).toBe(false);
  });
```

Replace the `getExecutorModelOptions` test for `cursor_agent` (currently `returns descriptive options string for cursor_agent` with `toMatch(/agent models/i)`) with a uniform list assertion, for example:

```ts
  it('returns comma-separated list for cursor_agent', () => {
    expect(getExecutorModelOptions('cursor_agent')).toBe(EXECUTOR_MODELS.cursor_agent.join(', '));
  });
```

Also replace the `isValidExecutorPreferences()` Cursor test:

```ts
  it('returns true for cursor_agent with listed model', () => {
    expect(isValidExecutorPreferences([
      { executor: 'cursor_agent', executor_model: 'auto' },
    ])).toBe(true);
  });

  it('returns false for cursor_agent with unlisted model', () => {
    expect(isValidExecutorPreferences([
      { executor: 'cursor_agent', executor_model: 'not-a-real-model' },
    ])).toBe(false);
  });
```

- [ ] **Step 2: Run the shared tests and verify they fail**

Run from the repository root:

```bash
cd packages/shared && npx vitest run src/__tests__/types.test.ts
```

Expected: FAIL because `types.ts` still contains the Cursor regex branch, the short example tuple, and the non-exhaustive options string.

- [ ] **Step 3: Implement the shared allowlist in `types.ts`**

Edit `packages/shared/src/types.ts`:

1. Remove:

```ts
export const CURSOR_AGENT_MODEL_MAX_LEN = 128;
export const CURSOR_AGENT_MODEL_ID = /^[a-zA-Z0-9._-]+$/;
```

2. Replace the current short Cursor tuple inside `EXECUTOR_MODELS` (keep the existing `as const satisfies Record<TaskExecutorType, readonly string[]>` terminator):

```ts
  cursor_agent: ['auto', 'composer-2-fast', 'gpt-5.4-medium'],
```

with the full static snapshot from the design doc. Keep the ids in the same order used in the design doc so docs and tests stay aligned.

3. Replace:

```ts
export type ExecutorModelType<T extends TaskExecutorType = TaskExecutorType> =
  T extends 'cursor_agent' ? string : (typeof EXECUTOR_MODELS)[T][number];
```

with:

```ts
export type ExecutorModelType<T extends TaskExecutorType = TaskExecutorType> =
  (typeof EXECUTOR_MODELS)[T][number];
```

4. Replace the Cursor-specific branch in `isValidExecutorModel()`:

```ts
export function isValidExecutorModel(
  executor: TaskExecutorType,
  model: unknown,
): model is ExecutorModelType {
  return (
    typeof model === 'string' &&
    (EXECUTOR_MODELS[executor] as readonly string[]).includes(model)
  );
}
```

5. Replace the special-case `getExecutorModelOptions()` with the uniform version:

```ts
export function getExecutorModelOptions(executor: TaskExecutorType): string {
  return EXECUTOR_MODELS[executor].join(', ');
}
```

- [ ] **Step 4: Run the shared tests again**

Run from the repository root:

```bash
cd packages/shared && npx vitest run src/__tests__/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): use static allowlist for cursor_agent models"
```

---

### Task 2: Prove enrichment and API inherit the new contract

**Files:**
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`
- Test: `packages/api/src/__tests__/routes/jobs.test.ts`

**Recommended order:** Finish Task 1 first, then add the Task 2 tests. That way Step 3–5 run green without needing enrichment or jobs route changes. If you add Task 2 tests before Task 1, expect Step 3 to fail until the shared allowlist is merged.

- [ ] **Step 1: Add enrichment tests for listed vs unlisted Cursor ids**

In `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`, add to the existing `describe('validation', ...)` block:

```ts
    it('accepts a listed cursor_agent model in enrichment rules', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          cursor_rule: {
            executors: [{ executor: 'cursor_agent', executor_model: 'gpt-5.4-medium-fast' }],
          },
        },
      });

      const result = service.enrich(createTask({ task_type: 'cursor_rule' }), TEST_SESSION_ID);
      expect(result.type).toBe('enriched');
    });

    it('rejects an unlisted cursor_agent model in enrichment rules', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          cursor_rule: {
            executors: [{ executor: 'cursor_agent', executor_model: 'not-a-real-model' }],
          },
        },
      });

      const result = service.enrich(createTask({ task_type: 'cursor_rule' }), TEST_SESSION_ID);
      expect(result.type).toBe('rejected');
    });
```

- [ ] **Step 2: Add `/jobs` tests for listed vs unlisted Cursor ids**

In `packages/api/src/__tests__/routes/jobs.test.ts`, add:

```ts
  it('returns 201 for a listed cursor_agent model', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send({
        ...validJobSubmission(),
        executors: [{ executor: 'cursor_agent', executor_model: 'gpt-5.4-medium-fast' }],
      });

    expect(res.status).toBe(201);
  });

  it('returns 400 for an unlisted cursor_agent model', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send({
        ...validJobSubmission(),
        executors: [{ executor: 'cursor_agent', executor_model: 'not-a-real-model' }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('executors must be a non-empty array');
  });
```

- [ ] **Step 3: Run the targeted tests (sanity check)**

Run from the repository root:

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts
```

and:

```bash
cd packages/api && npx vitest run src/__tests__/routes/jobs.test.ts
```

Expected: **If Task 1 is already complete**, both files PASS (the new assertions validate inherited behavior). **If you intentionally add these tests before Task 1** (TDD), they FAIL until the shared allowlist lands—then re-run after Task 1 and expect PASS.

- [ ] **Step 4: Adjust only tests if needed after the shared change**

No production-code changes should be necessary in:

- `packages/daemon/task-enrichment/src/enrichment-service.ts`
- `packages/api/src/routes/jobs.ts`

If either test still fails after Task 1, investigate for an actual inconsistency before touching production code.

- [ ] **Step 5: Re-run both targeted test files**

Run from the repository root:

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts
```

and:

```bash
cd packages/api && npx vitest run src/__tests__/routes/jobs.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts packages/api/src/__tests__/routes/jobs.test.ts
git commit -m "test: cover cursor_agent allowlist in enrichment and jobs API"
```

---

### Task 3: Align historical docs with the new contract

**Files:**
- Modify: `docs/development/design/2026-04-02-cursor-agent-executor-design.md`
- Modify: `docs/development/plans/2026-04-02-cursor-agent-executor.md`

- [ ] **Step 1: Add a superseded note to the old design doc**

At the top of `docs/development/design/2026-04-02-cursor-agent-executor-design.md`, add a short note under the header clarifying that its Cursor model-validation guidance has been superseded by `docs/development/design/2026-04-02-cursor-agent-model-selection-design.md`.

Suggested text:

```md
> Note: The executor bring-up sections in this document remain historically useful, but the `cursor_agent` model-validation guidance here has been superseded by `docs/development/design/2026-04-02-cursor-agent-model-selection-design.md`, which defines the current static-allowlist contract.
```

- [ ] **Step 2: Add a historical/superseded note to the old implementation plan**

At the top of `docs/development/plans/2026-04-02-cursor-agent-executor.md`, add a note that the plan’s pattern-validation steps were part of the original executor rollout and should not be used as the current model-selection spec.

Suggested text:

```md
> Historical note: This plan reflects the original `cursor_agent` executor rollout. Any steps or snippets here that describe regex/pattern validation for `executor_model` are superseded by `docs/development/design/2026-04-02-cursor-agent-model-selection-design.md` and its implementation plan.
```

- [ ] **Step 3: Verify the notes remove ambiguity**

Read both docs after the edit and confirm:

- neither one can reasonably be mistaken for the active model-selection contract
- both point to the new design/plan pair

- [ ] **Step 3b: Spot-check for misleading CLI vs enrichment wording (acceptance criterion 6)**

Search `README.md`, `docs/`, and `packages/cli/` for any statement that implies `cursor_agent` models are still freeform or that task submission (`submit`) is where executor/model is chosen. If anything is misleading, add a short clarification or link to `docs/development/design/2026-04-02-cursor-agent-model-selection-design.md`. Skip if there is nothing to fix.

- [ ] **Step 4: Commit**

```bash
git add docs/development/design/2026-04-02-cursor-agent-executor-design.md docs/development/plans/2026-04-02-cursor-agent-executor.md
# If Step 3b changed README or other docs, include those paths as well.
git commit -m "docs: mark old cursor_agent model validation notes as superseded"
```

---

### Task 4: Verification sweep

**Files:** None, unless a failing test requires a minimal follow-up fix

Run all commands below from the repository root (return to the root between `cd` invocations if the shell is left inside a package directory).

- [ ] **Step 1: Run the shared package tests**

```bash
cd packages/shared && npm test
```

Expected: PASS.

- [ ] **Step 2: Run the enrichment daemon tests**

```bash
cd packages/daemon/task-enrichment && npm test
```

Expected: PASS.

- [ ] **Step 3: Run the API tests**

```bash
cd packages/api && npm test
```

Expected: PASS.

- [ ] **Step 4: Build the touched packages**

```bash
cd packages/shared && npm run build
```

```bash
cd packages/daemon/task-enrichment && npm run build
```

```bash
cd packages/api && npm run build
```

(Each `cd` assumes the shell started at the repository root; run `cd` back to the root between commands if needed.)

Expected: PASS.

- [ ] **Step 5: Fix only genuine fallout**

If any failures occur outside the planned files, fix them only when they are direct fallout from the shared Cursor allowlist change. Avoid opportunistic cleanup.

- [ ] **Step 6: Commit any required fallout fix**

Only if Step 5 required edits outside the files already committed. Stage **only** those fallout files, then:

```bash
git commit -m "fix: resolve cursor_agent allowlist fallout"
```

If there is no fallout, skip this commit.

---

## Notes for the implementer

- Do not preserve the old regex branch “just in case.” The approved design explicitly switches Cursor to the same exact-membership pattern used by the other executors.
- Keep the allowlist order identical between the design doc and `types.ts` so future diffs are easier to audit.
- Prefer exact, focused assertions in tests over giant duplicated strings, except for the one list-equality test that locks the approved snapshot.
- If you discover a real requirement for route-level or enrichment-service code changes, update the design doc first or annotate the implementation notes so the divergence is explicit.
