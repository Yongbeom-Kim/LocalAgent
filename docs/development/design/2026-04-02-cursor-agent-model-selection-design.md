# Design: Cursor Agent Model Selection in Enrichment Config

> **Naming note:** The Cursor executor is named `cursor` in the live contract. See `docs/development/design/2026-04-02-executor-rename-claude-and-cursor-design.md` and `docs/development/plans/2026-04-02-executor-rename-claude-and-cursor.md`.

**Date:** 2026-04-02
**Status:** Ready for implementation planning
**Type:** Feature enhancement
**Packages:** `@local-agent/shared`, `@local-agent/task-enrichment-daemon`, `@local-agent/api`

## Problem

`cursor_agent` is executable today, but its model-selection behavior is inconsistent with the rest of the system:

- Enrichment rules already choose executor models through ordered `executors` arrays of `{ executor, executor_model }`.
- `claude_code`, `claude-w`, and `builtin` validate `executor_model` against static allowlists in `packages/shared/src/types.ts`.
- `cursor_agent` is the exception: it accepts any regex-shaped string and exposes only a few example values.

That inconsistency means operators cannot reliably know which Cursor model ids are officially supported in enrichment config, and the system contract differs by executor even though the config shape is the same.

## Goal

Make `cursor_agent` model selection behave like the other executors when configured in task enrichment rules:

1. Define a static shared allowlist of supported Cursor model ids.
2. Validate `cursor_agent` models by exact membership in that allowlist.
3. Let every existing consumer of shared executor-model validation inherit the same stricter behavior.
4. Sweep adjacent API and documentation surfaces so they stay aligned with the new contract.

## Non-goals

- No runtime discovery of Cursor models.
- No dynamic refresh of the allowlist from `agent models`.
- No migration tooling for existing enrichment configs.
- No change to the default shipped enrichment rules.
- No change to `agent` execution flags or `CursorAgentExecutor` runtime behavior.
- No task-submission CLI feature to pick executor models directly; enrichment remains the place where executor/model selection happens.

## User Decisions Captured

- The feature is specifically about **task enrichment config**.
- Cursor should use a **static allowlist**, not regex/freeform validation.
- The behavior should **copy the existing executor-model pattern** used by other executors.
- The allowlist should live in **`packages/shared/src/types.ts`**.
- Out-of-date allowlists are **not in scope** for this work.
- Keep the current default enrichment examples unchanged.
- Include a broader **API/CLI/docs sweep** so related surfaces remain consistent, even if some surfaces end up requiring only documentation clarification.

## Context

### Current config flow

The model-selection path for enriched jobs is already established:

1. `packages/daemon/task-enrichment/config/*.yaml` defines rules with ordered `executors`.
2. `EnrichmentService` validates each `{ executor, executor_model }` pair using:
   - `isTaskExecutorType()`
   - `isValidExecutorModel()`
3. The enriched `JobSubmission` is POSTed to `/jobs`.
4. `packages/api/src/routes/jobs.ts` validates the full `executors` array using `isValidExecutorPreferences()`.
5. The task daemon executes the chosen executor and passes `executor_model` to the underlying tool.

This means the correct place to change Cursor selection semantics is the shared validation layer, not the enrichment parser alone.

### Current `cursor_agent` behavior

`packages/shared/src/types.ts` currently treats Cursor differently:

- `EXECUTOR_MODELS.cursor_agent` contains a short example tuple.
- `ExecutorModelType<'cursor_agent'>` is widened to `string`.
- `isValidExecutorModel('cursor_agent', value)` accepts any non-empty model id matching a regex and max length.
- `getExecutorModelOptions('cursor_agent')` returns an examples-plus-freeform message rather than a true allowlist.

That behavior was appropriate for initial executor bring-up, but it conflicts with the desired operator experience for enrichment config.

## Approaches Considered

### Approach A — Shared static allowlist only

Replace Cursor regex validation in `packages/shared/src/types.ts` with a real static array of supported model ids, and let enrichment/API/job validation inherit that automatically.

**Pros**
- Smallest possible behavioral change.
- Single source of truth.
- Matches the architecture used by other executors.

**Cons**
- Leaves operator-facing docs underexplained.
- Leaves prior design docs describing freeform validation stale.

### Approach B — Shared static allowlist plus API/CLI/docs sweep (recommended)

Do Approach A, then update adjacent docs and any validation/help surfaces that describe executor models so the public contract is consistent.

**Pros**
- Keeps implementation centralized in shared types.
- Reduces confusion for operators editing enrichment YAML.
- Matches the requested broader sweep without inventing new submission features.

**Cons**
- Slightly larger scope than a pure validation change.

### Approach C — Enrichment-only allowlist

Add a Cursor allowlist only inside `task-enrichment`, while keeping shared validation permissive.

**Pros**
- Minimizes compatibility impact outside enrichment.

**Cons**
- Violates the “copy other executors” requirement.
- Makes `/jobs` and shared helpers disagree with enrichment.
- Creates two sources of truth.

## Recommendation

Adopt **Approach B**.

The shared package should become the authoritative source for Cursor model ids, exactly as it already is for the other executors. The surrounding sweep should primarily clarify the contract and update tests; it should not invent a new end-user task submission flow.

## Proposed Design

### 1. Replace Cursor freeform validation with a static allowlist

**File:** `packages/shared/src/types.ts`

Change Cursor handling so it matches the other executors:

- Remove Cursor-specific regex validation constants and branching.
- Replace the example tuple with a real allowlist snapshot.
- Make `ExecutorModelType` tuple-derived for all executors, including `cursor_agent`.
- Make `getExecutorModelOptions('cursor_agent')` return a comma-separated exhaustive list, like the others.

Conceptually:

```ts
export const EXECUTOR_MODELS = {
  claude_code: ['opus', 'sonnet', 'haiku'],
  'claude-w': [/* existing values */],
  builtin: ['none'],
  cursor_agent: [
    'auto',
    'composer-2-fast',
    'composer-2',
    // ... full static snapshot
  ],
} as const satisfies Record<TaskExecutorType, readonly string[]>;

export type ExecutorModelType<T extends TaskExecutorType = TaskExecutorType> =
  (typeof EXECUTOR_MODELS)[T][number];

export function isValidExecutorModel(
  executor: TaskExecutorType,
  model: unknown,
): model is ExecutorModelType {
  return (
    typeof model === 'string' &&
    (EXECUTOR_MODELS[executor] as readonly string[]).includes(model)
  );
}

export function getExecutorModelOptions(executor: TaskExecutorType): string {
  return EXECUTOR_MODELS[executor].join(', ');
}
```

### 2. Enrichment behavior stays structurally the same

**File:** `packages/daemon/task-enrichment/src/enrichment-service.ts`

No config-shape change is needed. Enrichment rules already express model choice in the right place:

```yaml
rules:
  code_review:
    executors:
      - executor: cursor_agent
        executor_model: gpt-5.4-medium-fast
```

`EnrichmentService` should continue to validate via shared helpers, but its effective behavior changes because Cursor validation becomes exact-allowlist instead of regex/freeform.

### 3. API validation behavior changes through shared helpers

**File:** `packages/api/src/routes/jobs.ts`

`POST /jobs` already validates `executors` through `isValidExecutorPreferences()`. No new field or route shape is required. The behavior change is:

- a Cursor model previously accepted by regex alone may now be rejected if it is not in the static allowlist.

The existing generic error is acceptable for this feature:

```ts
error: 'executors must be a non-empty array of valid {executor, executor_model} pairs'
```

No model-specific API error redesign is required in scope.

### 4. CLI task submission remains unchanged

**File:** `packages/cli/src/commands/submit.ts`

The CLI submits tasks to `/tasks`, not enriched jobs to `/jobs`. Since executor/model choice belongs to enrichment config, there is no new CLI option to add here.

The CLI/doc sweep for this feature is therefore limited to ensuring there is no misleading documentation implying Cursor models are still freeform or picked at task submission time.

### 5. Docs/config sweep

Update internal docs so they no longer describe Cursor models as freeform:

- supersede or amend `docs/development/design/2026-04-02-cursor-agent-executor-design.md`, which recommends regex-based validation
- update or annotate `docs/development/plans/2026-04-02-cursor-agent-executor.md` so its steps and snippets are not mistaken for the current contract (that plan describes the earlier pattern-validation approach)
- document that Cursor models are now a static shared allowlist snapshot
- avoid changing the shipped default enrichment config values

The existing config examples under `packages/daemon/task-enrichment/config/` should remain functionally unchanged unless a specific Cursor example is added as non-default documentation.

## Cursor Allowlist Snapshot

The static allowlist should be seeded from the live `agent models` output captured during planning on 2026-04-02.

### Exact ids to include

```text
auto
composer-2-fast
composer-2
composer-1.5
gpt-5.3-codex-low
gpt-5.3-codex-low-fast
gpt-5.3-codex
gpt-5.3-codex-fast
gpt-5.3-codex-high
gpt-5.3-codex-high-fast
gpt-5.3-codex-xhigh
gpt-5.3-codex-xhigh-fast
gpt-5.2
gpt-5.3-codex-spark-preview-low
gpt-5.3-codex-spark-preview
gpt-5.3-codex-spark-preview-high
gpt-5.3-codex-spark-preview-xhigh
gpt-5.2-codex-low
gpt-5.2-codex-low-fast
gpt-5.2-codex
gpt-5.2-codex-fast
gpt-5.2-codex-high
gpt-5.2-codex-high-fast
gpt-5.2-codex-xhigh
gpt-5.2-codex-xhigh-fast
gpt-5.1-codex-max-low
gpt-5.1-codex-max-low-fast
gpt-5.1-codex-max-medium
gpt-5.1-codex-max-medium-fast
gpt-5.1-codex-max-high
gpt-5.1-codex-max-high-fast
gpt-5.1-codex-max-xhigh
gpt-5.1-codex-max-xhigh-fast
gpt-5.4-high
gpt-5.4-high-fast
gpt-5.4-xhigh-fast
claude-4.6-opus-high-thinking
gpt-5.4-low
gpt-5.4-medium
gpt-5.4-medium-fast
gpt-5.4-xhigh
claude-4.6-sonnet-medium
claude-4.6-sonnet-medium-thinking
claude-4.6-opus-high
claude-4.6-opus-max
claude-4.6-opus-max-thinking
claude-4.5-opus-high
claude-4.5-opus-high-thinking
gpt-5.2-low
gpt-5.2-low-fast
gpt-5.2-fast
gpt-5.2-high
gpt-5.2-high-fast
gpt-5.2-xhigh
gpt-5.2-xhigh-fast
gemini-3.1-pro
gpt-5.4-mini-none
gpt-5.4-mini-low
gpt-5.4-mini-medium
gpt-5.4-mini-high
gpt-5.4-mini-xhigh
gpt-5.4-nano-none
gpt-5.4-nano-low
gpt-5.4-nano-medium
gpt-5.4-nano-high
gpt-5.4-nano-xhigh
grok-4-20
grok-4-20-thinking
claude-4.5-sonnet
claude-4.5-sonnet-thinking
gpt-5.1-low
gpt-5.1
gpt-5.1-high
gemini-3-flash
gpt-5.1-codex-mini-low
gpt-5.1-codex-mini
gpt-5.1-codex-mini-high
claude-4-sonnet
claude-4-sonnet-1m
claude-4-sonnet-thinking
claude-4-sonnet-1m-thinking
gpt-5-mini
kimi-k2.5
```

### Source note

This snapshot is intentionally static for implementation. Re-running `agent models` during implementation is acceptable if the implementer wants to confirm the list, but the design does not require any runtime discovery mechanism.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/types.ts` | Modify | Replace Cursor regex/freeform model validation with a static allowlist and uniform tuple-based typing |
| `packages/shared/src/__tests__/types.test.ts` | Modify | Replace pattern-validation tests with exact allowlist tests for Cursor |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Add/adjust tests showing Cursor enrichment rules accept listed ids and reject unlisted ids |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Modify | Verify `/jobs` rejects unlisted Cursor model ids inside `executors` |
| `docs/development/design/2026-04-02-cursor-agent-executor-design.md` | Modify | Remove or supersede the freeform-validation guidance |
| `docs/development/plans/2026-04-02-cursor-agent-executor.md` | Modify | Align or annotate so regex/pattern-validation instructions are not taken as current requirements |

## Testing Strategy

### Shared

- `EXECUTOR_MODELS.cursor_agent` equals the approved static snapshot.
- `isValidExecutorModel('cursor_agent', 'auto')` returns true.
- `isValidExecutorModel('cursor_agent', 'gpt-5.4-medium-fast')` returns true.
- `isValidExecutorModel('cursor_agent', 'not-a-real-model')` returns false.
- `isValidExecutorModel('cursor_agent', 'bad id with spaces')` returns false because it is not in the allowlist, not because of regex handling.
- `getExecutorModelOptions('cursor_agent')` returns the full comma-separated allowlist string.
- `isValidExecutorPreferences([{ executor: 'cursor_agent', executor_model: '<listed id>' }])` returns true.
- `isValidExecutorPreferences([{ executor: 'cursor_agent', executor_model: '<unlisted id>' }])` returns false.

### Enrichment

- A rule using `cursor_agent` with a listed model enriches successfully.
- A rule using `cursor_agent` with an unlisted model is rejected.
- Mixed executor arrays still preserve order and validate per pair.

### API

- `POST /jobs` accepts Cursor jobs whose `executors` array uses listed model ids.
- `POST /jobs` rejects Cursor jobs whose `executors` array uses unlisted model ids.

### Docs

- No internal design doc still claims Cursor models are validated as freeform regex ids.
- Completed implementation plans that describe the old `cursor_agent` pattern-validation approach are updated or clearly marked historical so they are not used as the active spec.
- No doc implies task-submission CLI is where Cursor model selection happens.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Existing configs use previously regex-valid but now unlisted Cursor ids | Accept as intentional contract tightening; no migration tooling in scope |
| Cursor model catalog changes after implementation | Out of scope; future updates are explicit code changes to the shared allowlist |
| Full allowlist is long and noisy in tests/docs | Keep the source of truth in `shared/types.ts`; use focused assertions plus one snapshot-style test |
| Engineers may assume CLI submit should gain model flags | Call out explicitly that enrichment config owns executor/model choice |

## Acceptance Criteria

1. `cursor_agent` model validation in `packages/shared/src/types.ts` uses the same static-array membership pattern as the other executors.
2. Cursor-specific regex/freeform validation logic is removed from shared model validation.
3. `EXECUTOR_MODELS.cursor_agent` contains the approved static snapshot of Cursor model ids.
4. Enrichment config accepts only listed Cursor ids.
5. `POST /jobs` accepts/rejects Cursor executor preferences consistently with enrichment because both use shared validation.
6. The task-submission CLI remains unchanged, and documentation makes clear that model choice lives in enrichment config.
7. Tests are updated from “pattern-valid Cursor model” semantics to “listed Cursor model” semantics.
8. Internal design docs and completed implementation plans that described the old `cursor_agent` regex/pattern-validation approach are updated or clearly marked historical so they are not mistaken for the current contract.
