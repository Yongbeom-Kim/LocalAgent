# Design: Enrichment-Owned Routing Error Messages for Lark Tasks

**Date:** 2026-04-02
**Status:** Ready for implementation planning
**Type:** UX improvement / validation-flow adjustment
**Packages:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/task-enrichment-daemon`

## Problem

The explicit `/task` contract now asks users to provide routing directly:

```text
/task <type> <executor> <model> <payload>
```

However, the current behavior does not return the desired error when a Lark user picks an invalid executor or model:

1. `lark-listener` parses `/task localagent cursor xyz test` and submits the task normally.
2. `POST /tasks` currently rejects invalid `{ executor, executor_model }` pairs immediately.
3. `TaskSubmitter` only sees an API failure and retries; it does not publish a user-facing explanation.
4. The Lark user therefore does **not** receive a helpful reply like:

```text
Invalid model "xyz" for executor "cursor". Available models: ...
```

The user asked for the opposite contract:

- invalid executor/model errors for Lark commands should be decided in **enrichment**
- the user should receive a direct error reply
- the reply should list the valid options for the selected executor

## Goal

For Lark-originated `/task` and explicit `/new <executor> <model>` commands, route invalid-executor and invalid-model handling through enrichment, then publish a clear user-facing failure reply:

- invalid `/task` executor:
  - `Invalid executor "foo". Available executors: claude, claude-w, builtin, cursor`
- invalid `/task` model:
  - `Invalid model "xyz" for executor "cursor". Available models: ...`
- invalid explicit `/new` routing:
  - same information content, but with `/new`-specific wording rather than generic `/task` wording

## Non-goals

- No parser changes to `/task`, `/new`, `/gc`, or `/end`
- No change to unknown-task-type behavior; that error still wins first
- No new CLI or API user-facing copy requirements
- No truncation, pagination, or docs-link fallback for long model lists; full inline list is desired
- No change to result publishing or Lark notification transport
- No executor/model discovery at runtime

## Scope Assessment

This is one coherent feature, not multiple independent projects.

The change spans multiple packages because the desired behavior crosses a validation boundary:

- shared option lists and formatting helpers
- `/tasks` API gatekeeping for Lark vs non-Lark producers
- enrichment-owned routing validation and rejection copy

Those need to move together so invalid Lark routing reaches enrichment without weakening unrelated producer flows more than necessary.

## User Decisions Captured

- Invalid executor/model handling for this workflow should happen in **enrichment**
- The available-options list should show **all valid models for that executor**
- The required user-facing surface is **Lark only**
- Invalid executor errors should also be improved, not just invalid model errors
- Invalid model copy for `/task` should be:
  - `Invalid model "xyz" for executor "cursor". Available models: ...`
- Invalid executor copy for `/task` should be:
  - `Invalid executor "foo". Available executors: ...`
- The message should stay focused on executor/model, not mention the task type
- The copy should report only the **first relevant issue**
- Unknown task type should still win over routing-help messages
- Explicit `/new <executor> <model>` should get the same improvement, but with `/new`-specific wording
- Centralizing message/option formatting in shared code is preferred if it stays small and testable
- Treat `task_source.source === 'lark'` as a product-routing signal, not an authentication boundary, for this feature

## Current State

### Lark submission path

`packages/daemon/lark-listener/src/message-handler.ts` parses:

- `/task <type> <executor> <model> <payload>`
- `/new <executor> <model>`

and `TaskSubmitter` forwards those routing fields to `POST /tasks`.

### API validation blocks enrichment today

`packages/api/src/routes/tasks.ts` currently rejects any invalid pair at submission time:

```ts
if (
  executor !== undefined &&
  (!isTaskExecutorType(executor) || !isValidExecutorModel(executor, executor_model))
) {
  res.status(400).json({ error: 'executor and executor_model must be a valid pair' });
  return;
}
```

That means Lark-sourced invalid routing never reaches enrichment.

### Enrichment already owns user-visible rejection publishing

`packages/daemon/task-enrichment/src/enrichment-poller.ts` already converts enrichment rejections into failed task results and publishes them back through `/results`. That is the same path currently used for:

- unknown task type
- invalid threaded `/task`
- invalid `/gc`
- invalid `/new` thread/session usage

So if invalid routing reaches enrichment, the Lark reply path already exists.

### Enrichment copy is too generic

`packages/daemon/task-enrichment/src/enrichment-service.ts` currently returns generic routing errors such as:

- `Task type "<type>" has invalid executor routing.`
- `Task type "new_instance" has invalid executor routing.`

That does not explain whether the executor or model was wrong, and it does not show available options.

## Approaches Considered

### Approach A — Enrichment-only custom strings

Keep all new copy inside `EnrichmentService` and hand-build executor/model option messages there.

**Pros**

- Smallest implementation
- Keeps rejection ownership in enrichment

**Cons**

- Duplicates option formatting concerns already rooted in shared validation data
- Harder to keep `/task` and `/new` wording consistent
- Less reusable and less focused for testing

### Approach B — Shared routing-error helpers plus enrichment-owned rejection (recommended)

Add small shared helpers for executor/model option strings and user-facing routing error formatting, but invoke them only from enrichment. Adjust `/tasks` validation so Lark-sourced tasks with explicit routing can reach enrichment even when the pair is invalid.

**Pros**

- Preserves the desired ownership model: enrichment still decides and publishes the rejection
- Keeps executor/model option data centralized and testable
- Lets `/task` and explicit `/new` share consistent message construction while still differing in wording
- Limits validation deferral to the Lark flow that actually needs the user-facing reply

**Cons**

- Slightly broader than changing strings in one file
- Introduces source-sensitive behavior in `/tasks`

### Approach C — API-owned friendly errors

Keep invalid routing rejection at `POST /tasks`, but improve the API error body and teach Lark submission to surface it.

**Pros**

- Rejects earlier
- Fewer invalid tasks enter the queue

**Cons**

- Conflicts with the explicit decision that this should happen in enrichment
- Moves user-facing ownership away from the existing enrichment rejection path
- Makes `/task` and `/new` routing UX depend on submission transport behavior

## Recommendation

Adopt **Approach B**.

This is the smallest coherent design that satisfies the requested behavior without broadly weakening other producers. The key design move is to **defer semantic executor/model validation for Lark-sourced tasks only**, then let enrichment produce the exact user-facing routing error text that already flows back to Lark through the result pipeline.

## Proposed Design

### 1. Add small shared helpers for routing option strings and error copy

Shared should remain the source of truth for executor/model options.

#### Existing helpers to keep using

- `TASK_EXECUTOR_OPTIONS`
- `getExecutorModelOptions(executor)`
- `isTaskExecutorType()`
- `isValidExecutorModel()`

#### New shared helper surface

Add a small helper module, for example `packages/shared/src/routing-errors.ts`, with helpers along these lines:

```ts
export type RoutingCommandLabel = '/task' | '/new';

export function formatInvalidExecutorMessage(
  command: RoutingCommandLabel,
  executor: string,
): string;

export function formatInvalidModelMessage(
  command: RoutingCommandLabel,
  executor: TaskExecutorType,
  model: string,
): string;
```

Expected copy:

- `/task` invalid executor:
  - `Invalid executor "foo". Available executors: claude, claude-w, builtin, cursor`
- `/task` invalid model:
  - `Invalid model "xyz" for executor "cursor". Available models: ...`
- `/new` invalid executor:
  - `Invalid executor "foo" for /new. Available executors: claude, claude-w, builtin, cursor`
- `/new` invalid model:
  - `Invalid model "xyz" for /new executor "cursor". Available models: ...`

### 2. Defer semantic routing validation for Lark-sourced tasks at `POST /tasks`

`packages/api/src/routes/tasks.ts` should continue enforcing:

- `task_type` shape
- `payload` shape
- `task_source` validity
- `executor` and `executor_model` being present together
- required routing for non-control tasks
- non-empty payload for non-control tasks

But it should **stop rejecting invalid executor/model values for Lark-sourced tasks**.

Recommended rule:

1. If `executor` and `executor_model` are both present and `task_source?.source !== 'lark'`, keep the current pair validation.
2. If `executor` and `executor_model` are both present and `task_source?.source === 'lark'`, accept them structurally and let enrichment validate them semantically.

This preserves current immediate API validation for CLI or other non-Lark producers while allowing the Lark flow to reach the enrichment-owned rejection path the user asked for.

This design explicitly accepts that `task_source` is not an auth guarantee today. If another producer spoofs `source: 'lark'`, it can enqueue an invalid pair that enrichment will later reject. That tradeoff is acceptable in scope because the requested behavior is product-facing Lark UX, not an API hardening project.

### 3. Keep unknown task type as the first enrichment rejection

`EnrichmentService.enrich()` should preserve the current order:

1. unknown task type check
2. routing validation
3. job construction

That means `/task does_not_exist cursor xyz test` should still return the unknown-task-type message rather than a model-options message.

### 4. Make enrichment distinguish invalid executor from invalid model

`packages/daemon/task-enrichment/src/enrichment-service.ts` should stop returning generic routing copy and instead branch explicitly:

#### Normal tasks

For non-control tasks:

1. if executor/model are missing:
   - keep the current explicit-routing rejection
2. else if `executor` is not a valid executor:
   - return `formatInvalidExecutorMessage('/task', task.executor)`
3. else if `executor_model` is not valid for that executor:
   - return `formatInvalidModelMessage('/task', task.executor, task.executor_model)`
4. else proceed normally

Implementation note: this order is required for correctness. Once Lark tasks can bypass API pair validation, enrichment must call `isTaskExecutorType(task.executor)` before any `isValidExecutorModel(...)` check so an unknown executor string cannot reach shared model lookup and cause a runtime crash.

#### Explicit `/new <executor> <model>`

For `task_type === 'new_instance'` when routing fields are present:

1. if executor is invalid:
   - return `formatInvalidExecutorMessage('/new', task.executor)`
2. else if model is invalid for that executor:
   - return `formatInvalidModelMessage('/new', task.executor, task.executor_model)`
3. else proceed normally

Bare `/new` should keep its current fallback behavior and should not use these messages because there is no user-supplied routing pair to validate.

### 5. No change to rejection transport

`packages/daemon/task-enrichment/src/enrichment-poller.ts` already publishes:

```ts
stdout: reason
```

for enrichment rejections. That should remain unchanged. The feature is satisfied by improving the `reason` string produced by enrichment.

### 6. No change to Lark listener parsing

`packages/daemon/lark-listener/src/message-handler.ts` should remain unchanged for this feature:

- parsing stays syntax-only
- `/task` and explicit `/new` continue to submit routing tokens without local semantic validation

That keeps responsibility boundaries clean:

- listener: syntax
- API: structural validation
- enrichment: semantic validation + Lark-facing rejection reason

## Data Flow

### Invalid `/task` model from Lark

```text
User sends:
/task localagent cursor xyz test
        |
        v
lark-listener
  -> parses valid command shape
  -> POST /tasks with executor=cursor, executor_model=xyz
        |
        v
API /tasks
  -> accepts pair structurally because task_source is lark
        |
        v
enrichment-poller
  -> enrichment validates executor/model semantics
  -> rejection reason:
     Invalid model "xyz" for executor "cursor". Available models: ...
        |
        v
POST /results
        |
        v
existing Lark result flow replies to user
```

### Invalid explicit `/new` executor from Lark

```text
User sends:
/new foo bar
        |
        v
lark-listener
  -> submits new_instance with executor=foo, executor_model=bar
        |
        v
API /tasks
  -> accepts pair structurally because task_source is lark
        |
        v
enrichment
  -> returns /new-specific invalid-executor message
        |
        v
existing rejection result flow replies to user
```

### Invalid routing from non-Lark producer

```text
CLI or other producer submits invalid executor/model
        |
        v
API /tasks
  -> still rejects immediately with 400
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/routing-errors.ts` | Create | Centralize user-facing routing validation messages for `/task` and `/new` |
| `packages/shared/src/types.ts` | Verify or minimal modify | Continue exporting executor/model option helpers; no contract change expected beyond helper reuse |
| `packages/shared/src/index.ts` | Modify | Re-export new routing-error helpers |
| `packages/shared/src/__tests__/types.test.ts` | Verify or modify | Keep existing option-list coverage if needed by new helpers |
| `packages/shared/src/__tests__/routing-errors.test.ts` | Create | Lock expected invalid-executor and invalid-model copy for `/task` and `/new` |
| `packages/api/src/routes/tasks.ts` | Modify | Defer executor/model semantic validation for Lark-sourced tasks while keeping structural validation |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Cover Lark-vs-non-Lark validation behavior |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Replace generic routing rejection copy with executor/model-specific messages using shared helpers |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Assert exact rejection reasons for invalid executor/model on `/task` and explicit `/new` |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Modify | Confirm rejected enrichment reasons still publish to `/results` for Lark tasks |

## Testing Strategy

### Shared

- `formatInvalidExecutorMessage('/task', 'foo')` returns:
  - `Invalid executor "foo". Available executors: claude, claude-w, builtin, cursor`
- `formatInvalidModelMessage('/task', 'cursor', 'xyz')` returns:
  - `Invalid model "xyz" for executor "cursor". Available models: ...`
- `/new` variants use `/new`-specific wording and preserve the same option lists

### API

- Lark-sourced non-control task with invalid model is accepted by `POST /tasks`
- Lark-sourced explicit `/new` with invalid executor is accepted by `POST /tasks`
- Non-Lark task with invalid model still gets `400`
- Non-Lark task with invalid executor still gets `400`
- Any task still rejects one routing field without the other

### Enrichment

- Unknown task type still rejects before executor/model help
- Non-control task with invalid executor returns the exact `/task` executor message
- Non-control task with valid executor but invalid model returns the exact `/task` model message
- `new_instance` with invalid executor returns:
  - `Invalid executor "<value>" for /new. Available executors: ...`
- `new_instance` with valid executor but invalid model returns:
  - `Invalid model "<value>" for /new executor "<executor>". Available models: ...`
- Bare `/new` still falls back normally and does not use the new messages
- Unknown executor on a Lark task does not crash enrichment; it returns the executor-help message cleanly

### Rejection transport

- A Lark task rejected by enrichment still publishes the rejection string to `/results`
- The published `stdout` equals the exact human-facing message from enrichment

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Deferring pair validation could weaken API guarantees broadly | Defer semantic validation only for `task_source.source === 'lark'`; keep current API behavior for non-Lark producers |
| Another producer can spoof `task_source.source === 'lark'` and enter the deferred-validation path | Accept as in-scope tradeoff for this UX feature; a future auth/hardening pass can tighten producer trust separately |
| Shared helper names/copy become too Lark-specific | Keep helper API scoped to command labels (`/task`, `/new`) but avoid transport-specific wording |
| Long Cursor model lists produce noisy replies | Accept as intentional product choice; full inline list is explicitly desired |
| Future producers may expect the same helpful message path | Keep shared formatting reusable so later flows can opt in without rewriting copy |
| TypeScript types still suggest executor/model are always valid once present | Keep runtime guards in enrichment explicit and validate executor before model lookup so deferred Lark validation cannot cause runtime crashes |

## Acceptance Criteria

1. `/task ...` with an invalid executor submitted from Lark is accepted by `/tasks`, rejected in enrichment, and replies with:
   - `Invalid executor "<value>". Available executors: ...`
2. `/task ...` with a valid executor but invalid model submitted from Lark is accepted by `/tasks`, rejected in enrichment, and replies with:
   - `Invalid model "<value>" for executor "<executor>". Available models: ...`
3. Explicit `/new <executor> <model>` with invalid routing is rejected in enrichment with `/new`-specific wording and full inline options.
4. Unknown task type still takes precedence over routing-help messages.
5. Non-Lark producers with invalid executor/model pairs continue to fail at `POST /tasks`.
6. Routing error copy is centralized in small shared helpers rather than duplicated ad hoc in enrichment.
7. Existing enrichment rejection publishing continues to deliver the exact message to Lark users without transport-layer redesign.
8. Unknown executor strings deferred from the Lark path do not crash enrichment; they deterministically return the invalid-executor message first.
