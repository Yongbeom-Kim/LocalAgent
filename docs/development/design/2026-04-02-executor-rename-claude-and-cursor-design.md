# Design: Rename Executor Contracts to `claude` and `cursor`

**Date:** 2026-04-02
**Status:** Approved for implementation planning
**Type:** Breaking change / terminology cleanup
**Packages:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/task-daemon`, `@local-agent/task-enrichment-daemon`, `@local-agent/lark-listener-daemon`, `@local-agent/lark-result-daemon`

## 1. Problem

The executor naming in the current system has drifted away from the terminology the user wants to expose and maintain:

- the primary Claude executor is still named `claude_code`
- the Cursor executor is still named `cursor_agent`
- task-daemon adapter filenames and class names still encode those old names
- logs, tests, fixtures, YAML config, `/new` command examples, and result metadata also repeat the old terms

That creates two kinds of cost:

1. The public contract is harder to understand than it needs to be.
2. Internal implementation names no longer match the product language, which makes future executor work more confusing.

The requested direction is a full hard rename:

- `claude_code` -> `claude`
- `cursor_agent` -> `cursor`
- `claude-w` stays unchanged
- no compatibility aliases
- old thread metadata should simply stop validating once the shared package no longer recognizes the old names

## 2. Goal

Make `claude` and `cursor` the only canonical names for those executors across the active system:

- shared executor enums and validation
- API request and response validation
- enrichment YAML and thread inheritance behavior
- task-daemon routing and adapter names
- `/new <executor> <model>` command usage
- visible result metadata in Lark replies
- logger namespaces and human-readable execution strings
- active source-of-truth documentation

## 3. Non-goals

- No backward compatibility for `claude_code` or `cursor_agent`
- No DB or queue migration work
- No attempt to reinterpret old thread metadata after the rename
- No changes to `claude-w` naming or behavior
- No changes to model allowlists beyond moving them under the renamed executor keys
- No rewrite of append-only historical docs; only add short superseded links where needed

## 4. Scope Assessment

This is one coherent subsystem change, not multiple unrelated projects.

Although the rename crosses several packages, every affected path hangs off the same contract:

- `TaskExecutorType`
- executor/model validation
- executor adapter resolution
- thread-level executor persistence via visible metadata

That means a single design and implementation plan is the right scope.

## 5. User Decisions Captured

- Rename all internal and external references for these executor names, not just payload values.
- `claude_code` becomes `claude`.
- `cursor_agent` becomes `cursor`.
- `claude-w` remains as-is.
- This is a hard breaking rename with no migration window and no aliases.
- Existing thread history that still says `executor: claude_code` or `executor: cursor_agent` may stop inheriting once shared validation rejects it.
- User-facing command/help text should use the new names.
- Internal adapter filenames and class names should also be renamed, for example:
  - `claude-cli-executor.ts` -> `claude-executor.ts`
  - `ClaudeCliExecutor` -> `ClaudeExecutor`
  - `cursor-agent-executor.ts` -> `cursor-executor.ts`
  - `CursorAgentExecutor` -> `CursorExecutor`
- Observability strings should use the new canonical terminology too.
- Historical incremental docs should remain append-only, but relevant older docs should gain short links to the new design/plan.
- Verification should focus on targeted impacted suites, not the whole monorepo.

## 6. Current State

Today the old names are wired through the whole execution path:

- `packages/shared/src/types.ts`
  - `TASK_EXECUTORS` includes `claude_code` and `cursor_agent`
  - `EXECUTOR_MODELS` keys use the old names
- `packages/daemon/task/src/core/task-orchestrator.ts`
  - routes `claude_code` to `ClaudeCliExecutor`
  - routes `cursor_agent` to `CursorAgentExecutor`
- `packages/daemon/task/src/adapters/`
  - files and class names still use `claude-cli` and `cursor-agent`
- `packages/daemon/task-enrichment/`
  - default YAML uses `claude_code`
  - thread-context inheritance validates old executor identifiers
  - `/new` explicit override parsing depends on shared validation
- `packages/daemon/lark-listener/`
  - tests and examples use `/new cursor_agent ...`
- `packages/daemon/lark-result/`
  - visible result metadata includes the executor value from the result contract
- `packages/api/`
  - accepts/rejects executor pairs based on the shared types
- `docs/development/`
  - several active and historical design/plan docs still reference the old names

The current architecture already centralizes semantic validation in `@local-agent/shared`, which is the correct pivot point for the rename.

## 7. Approaches Considered

### Approach A - Clean break rename everywhere (recommended)

Change all active contracts, implementation symbols, and user-facing strings so only `claude` and `cursor` remain valid.

**Pros**

- Smallest long-term maintenance burden
- No ambiguous dual vocabulary
- Matches the requested hard break exactly
- Keeps filenames, symbols, logs, and docs aligned

**Cons**

- Old payloads, fixtures, and thread metadata stop validating immediately
- Touches several packages in one change

### Approach B - Accept old names, emit new names

Allow `claude_code` / `cursor_agent` at inputs, but normalize outputs to `claude` / `cursor`.

**Pros**

- Safer rollout
- Less breakage for stale clients and existing threads

**Cons**

- Directly conflicts with the requested hard break
- Leaves alias logic to remove later
- Makes type and validation code harder to reason about

### Approach C - Rename only public values

Rename shared/API/user-facing contract values, but keep internal filenames and class names unchanged.

**Pros**

- Smaller diff
- Lower immediate churn

**Cons**

- Bakes terminology mismatch into the codebase
- Makes future executor work harder to navigate
- Confuses logs, tests, and architecture docs

## 8. Recommendation

Adopt **Approach A**.

The repository is still small enough that a coherent hard rename is cheaper than carrying compatibility or mixed terminology. The shared package already serves as the contract gate, so once that layer changes, the rest of the implementation can be updated in a straightforward, testable way.

## 9. Proposed Design

### 9.1 Canonical executor contract in `@local-agent/shared`

`packages/shared/src/types.ts` becomes the source of truth for the new names:

- `TASK_EXECUTORS = ['claude', 'claude-w', 'builtin', 'cursor']`
- `TaskExecutorType` derives from those values
- `EXECUTOR_MODELS` moves the old model lists under:
  - `claude`
  - `cursor`
- helpers like `isTaskExecutorType()`, `isValidExecutorModel()`, `getExecutorModelOptions()`, and `isValidExecutorPreferences()` continue to work unchanged in shape, but against the new keys

This makes the rename a contract-level change rather than a string-replacement-only change.

#### Breaking-change behavior

Because there is no compatibility layer:

- `isTaskExecutorType('claude_code')` becomes `false`
- `isTaskExecutorType('cursor_agent')` becomes `false`
- old job submissions, result payloads, and thread metadata lines stop validating automatically

That is desired and should be documented explicitly in both the design and plan.

### 9.2 Rename task-daemon adapter files, classes, and routing

The task daemon should expose names that match the new contract:

- `packages/daemon/task/src/adapters/claude-cli-executor.ts`
  -> `packages/daemon/task/src/adapters/claude-executor.ts`
- `ClaudeCliExecutor` -> `ClaudeExecutor`
- `packages/daemon/task/src/adapters/cursor-agent-executor.ts`
  -> `packages/daemon/task/src/adapters/cursor-executor.ts`
- `CursorAgentExecutor` -> `CursorExecutor`
- matching adapter test filenames and imports rename with them

`TaskOrchestrator.resolveExecutor()` becomes:

```ts
if (executor === 'claude') return new ClaudeExecutor();
if (executor === 'claude-w') return new ClaudeWExecutor();
if (executor === 'builtin') return new CleanupExecutor();
if (executor === 'cursor') return new CursorExecutor();
```

This is not only cosmetic. It keeps code navigation and future refactors aligned with the public contract.

### 9.3 Preserve runtime behavior while renaming terminology

The rename should not alter execution semantics:

- `ClaudeExecutor` still spawns `claude`
- `CursorExecutor` still spawns `agent`
- continue-vs-fresh logic remains unchanged
- `claude-w` executor behavior remains unchanged

The behavioral change is purely in naming and validation:

- job executor values
- class names
- filenames
- logs
- tests
- docs

### 9.4 Update `/new` command and thread inheritance to the new names

The `/new <executor> <model>` feature already treats executor validity as a shared-package concern. After the rename:

- `/new cursor gpt-5.4-medium-fast` is valid
- `/new claude sonnet` is valid
- `/new cursor_agent gpt-5.4-medium-fast` is invalid once enrichment/shared validation runs
- `/new claude_code sonnet` is invalid once enrichment/shared validation runs

No compatibility shim or migration path is added in `MessageHandler`, `EnrichmentPoller`, or `ThreadContextFetcher` for old thread metadata. Implementers must still update any **literals** that submit jobs or echo executor values (for example the GC-task path in `EnrichmentPoller` that posts `executor: 'claude_code'` today must post `claude` after the rename).

The existing separation of responsibilities stays intact:

- listener validates syntax and arity
- shared package validates executor names and model allowlists
- enrichment uses shared validation for explicit overrides and inherited thread metadata

### 9.5 Thread metadata and result metadata remain structurally unchanged

Visible result metadata continues to be the durable thread-state carrier:

- `executor: claude`
- `executor: cursor`
- `model: ...`
- `task_type: ...`
- `session_id: ...`

`ThreadContextFetcher` does not need new logic for the rename itself. It should simply continue to validate metadata lines through shared helpers.

That means old lines like:

```text
executor: claude_code
model: sonnet
```

become non-inheritable because `claude_code` is no longer a valid `TaskExecutorType`.

This is the intended clean-break behavior.

### 9.6 Update observability strings

Logger namespaces and human-readable log messages should use the new terminology where they currently encode old names.

Examples:

- `task-daemon:cursor-agent` -> `task-daemon:cursor`
- `task-daemon:claude-cli` -> `task-daemon:claude`
- log messages like `Spawning Claude Code` -> `Spawning Claude`
- `Cursor agent completed` -> `Cursor completed`

This keeps monitoring output aligned with the new executor language and avoids stale terminology surviving in debugging workflows.

### 9.7 Update default config and fixtures

Any active config or fixtures that provide executor values must use the new names:

- enrichment YAML defaults
- API route fixtures
- RabbitMQ tests
- task poller tests
- notifier tests
- thread-context tests
- `/new` command tests

This is required because the shared validators will reject the old values once the rename lands.

### 9.8 Documentation policy

#### Current source-of-truth docs

Docs that are still current references for executor behavior should be updated to use:

- `claude`
- `cursor`
- `ClaudeExecutor`
- `CursorExecutor`

#### Historical append-only docs

Older incremental docs should stay append-only, but the directly relevant older executor docs should gain a short note near the top such as:

> Superseded in part by `docs/development/design/2026-04-02-executor-rename-claude-and-cursor-design.md` and `docs/development/plans/2026-04-02-executor-rename-claude-and-cursor.md` for the current executor naming contract.

This keeps historical context intact without allowing old executor names to masquerade as current guidance.

### 9.9 No datastore migration

There are no SQL migrations or persistent enum schemas to update in the repository. The plan should explicitly assume:

- in-flight or stored payloads that still contain the old names may fail validation after deployment
- that breakage is acceptable for this change
- no special migration task is required

## 10. File Changes

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Rename executor enum values and model-map keys from `claude_code`/`cursor_agent` to `claude`/`cursor` |
| `packages/shared/src/__tests__/types.test.ts` | Modify | Update allowlist, validation, and helper tests to the new names |
| `packages/api/src/routes/jobs.ts` | Verify | Continue using shared validation with renamed executor values |
| `packages/api/src/routes/results.ts` | Verify | Continue validating result executor metadata through shared helpers |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Modify | Update request fixtures and assertions to `claude`/`cursor` |
| `packages/api/src/__tests__/routes/results.test.ts` | Modify | Update valid/invalid executor assertions to the new names |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Modify | Update job/result fixtures that use executor values |
| `packages/daemon/task/src/adapters/claude-cli-executor.ts` | Rename + modify | Rename file/class/logger strings to `claude-executor.ts` / `ClaudeExecutor` |
| `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts` | Rename + modify | Rename file/imports/describes and keep behavior coverage |
| `packages/daemon/task/src/adapters/cursor-agent-executor.ts` | Rename + modify | Rename file/class/logger strings to `cursor-executor.ts` / `CursorExecutor` |
| `packages/daemon/task/src/adapters/__tests__/cursor-agent-executor.test.ts` | Rename + modify | Rename file/imports/describes and keep behavior coverage |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Modify | Update imports, routing branches, and executor literals |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Modify | Update mocks, imports, strings, and expected executor values |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Modify | Update fixtures/assertions to the new names |
| `packages/daemon/task/src/services/__tests__/gc-executor.test.ts` | Modify | Update executor fixtures |
| `packages/daemon/task-enrichment/config/enrichment.yaml` | Modify | Change default executor from `claude_code` to `claude` |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Modify | Update GC-task `JobSubmission` literal and any other executor strings; shared validation continues to gate explicit `/new` and inherited executor pairs under the new names |
| `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Verify | Shared validation continues to gate inherited executor metadata under the new names |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Modify | Update fixtures and `/new` explicit override expectations |
| `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts` | Modify | Update inherited executor fixtures and expected values |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Update YAML/fixture executor values |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Modify | Update `/new cursor ...` examples and expected payloads |
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Verify | Visible metadata uses renamed executor values automatically via result contract |
| `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts` | Modify | Update expected `executor:` output strings |
| `docs/development/design/2026-04-02-cursor-agent-executor-design.md` | Modify | Add short superseded link to the new rename design/plan |
| `docs/development/plans/2026-04-02-cursor-agent-executor.md` | Modify | Add short superseded link to the new rename design/plan |
| `docs/development/design/2026-04-02-cursor-agent-model-selection-design.md` | Modify | Add short note clarifying current executor name is now `cursor` and point to new rename spec |
| `docs/development/plans/2026-04-02-cursor-agent-model-selection.md` | Modify | Add short note pointing to the new rename spec |
| `docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md` | Modify | Add short note pointing to the new rename spec for current executor naming |
| `docs/development/plans/2026-04-02-new-instance-executor-model-inheritance.md` | Modify | Add short note pointing to the new rename spec for current executor naming |

**Completeness:** The table above is the primary checklist. Before merge, search the repo for remaining active references to legacy identifiers (`claude_code`, `cursor_agent`, `ClaudeCliExecutor`, `CursorAgentExecutor`, old adapter filenames, and hyphenated logger namespaces such as `claude-cli` / `cursor-agent`) and update or drop them so they do not ship in application code or current docs.

## 11. Testing Strategy

### 11.1 Shared contract

- `TaskExecutorType` accepts `claude`, `claude-w`, `builtin`, `cursor`
- `TaskExecutorType` rejects `claude_code` and `cursor_agent`
- `EXECUTOR_MODELS.claude` and `EXECUTOR_MODELS.cursor` preserve the existing model allowlists
- `isValidExecutorModel()` and `getExecutorModelOptions()` work under the new keys

### 11.2 API validation

- jobs API accepts `claude` and `cursor` pairs
- jobs API rejects `claude_code` and `cursor_agent`
- results API accepts `executor: claude` / `executor: cursor`
- results API rejects old names because shared validation rejects them

### 11.3 Task daemon routing and adapters

- orchestrator routes `claude` to `ClaudeExecutor`
- orchestrator routes `cursor` to `CursorExecutor`
- renamed adapter tests still verify argv, continue behavior, and truncation
- logger/message assertions are updated only where tests care about user-observable strings

### 11.4 Thread inheritance and `/new`

- explicit `/new cursor ...` works
- explicit `/new claude ...` works
- explicit `/new cursor_agent ...` is rejected by the existing shared-validation path
- old `executor:` metadata lines in thread history no longer inherit because they do not validate
- current `executor: cursor` and `executor: claude` metadata continues to inherit normally

### 11.5 Lark reply formatting

- notifier shows `executor: claude` or `executor: cursor`
- old names no longer appear in active notifier tests or fixtures

### 11.6 Targeted verification sweep

Run the impacted suites only:

- `packages/shared`
- `packages/api`
- `packages/daemon/task`
- `packages/daemon/task-enrichment`
- `packages/daemon/lark-listener`
- `packages/daemon/lark-result`

Broader monorepo test execution is not required unless targeted suites expose unexpected fallout.

## 12. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Old clients or fixtures still submit `claude_code` / `cursor_agent` | Treat as intentional break; update active call sites and tests in the same change |
| File/class renames break imports or mocks | Rename adapter files and their tests together, then run targeted task-daemon suites |
| Historical docs become misleading | Add short superseded links in the directly relevant older docs |
| Old Lark thread metadata no longer inherits | Document this as expected clean-break behavior and rely on shared validation consistently |
| Observability still leaks old names | Update logger namespaces and human-readable log strings during the same refactor |

## 13. Acceptance Criteria

1. `claude` and `cursor` are the only canonical names for those executors in active code paths.
2. `claude_code` and `cursor_agent` are rejected by shared validation.
3. Task-daemon adapter filenames and classes use `ClaudeExecutor` / `CursorExecutor` naming.
4. `/new <executor> <model>` examples, tests, and user-facing outputs use `claude` / `cursor`.
5. Thread inheritance continues to work for `executor:` lines that validate under the renamed shared contract.
6. Thread inheritance no longer recognizes old metadata lines with `claude_code` or `cursor_agent`.
7. Logs and notifier output no longer encode legacy executor identity via old names: no `claude_code` / `cursor_agent` strings, and logger namespaces or hyphenated tags that referred to the old adapters (for example `claude-cli`, `cursor-agent`) are updated to match the new canonical names.
8. Directly relevant historical docs include short links to this design and its implementation plan.
