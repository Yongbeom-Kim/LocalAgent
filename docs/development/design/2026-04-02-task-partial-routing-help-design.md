# Design: Pipeline Help for Partial `/task` Routing

**Date:** 2026-04-02
**Status:** Ready for implementation planning
**Packages:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/lark-listener-daemon`, `@local-agent/task-enrichment-daemon`

## 1. Problem

The current explicit `/task` contract only helps users after a fully shaped task reaches enrichment:

- unknown `task_type` already returns the valid task types
- invalid `executor` already returns the valid executors
- invalid `executor_model` already returns the valid models

But the Lark listener still rejects partial `/task` inputs locally with a generic usage hint, so users do **not** get option help for the progressive cases they are most likely to hit:

- `/task <invalid>`
- `/task localagent <invalid>`
- `/task localagent cursor <invalid>`
- bare `/task`
- `/task localagent`
- `/task localagent cursor`
- `/task localagent cursor auto` with missing payload

That means the system already knows how to explain valid options, but it only does so after the user has already guessed enough tokens to pass listener parsing.

## 2. Goal

Allow partial `/task` commands to flow through the existing task -> enrichment -> result pipeline so Lark users get stage-specific guidance from the same downstream validation path that already powers invalid-type and invalid-routing replies.

The intended user experience is:

- `/task` returns the canonical `/task` syntax plus valid task types
- `/task foo` returns valid task types if `foo` is not a known type
- `/task localagent` returns valid executors
- `/task localagent cursor` returns valid models for `cursor`
- `/task localagent cursor auto` returns the canonical `/task` syntax plus a payload-required message
- `/task localagent foo bar` stops at executor guidance rather than trying to validate `bar`
- `/task foo cursor auto hello` stops at task-type guidance rather than validating later tokens

All of those replies should still come back through the existing Lark result path rather than as an immediate local reply from `lark-listener`.

## 3. Non-goals

- No change to `/new`, `/gc`, or `/end` semantics
- No new slash-command autocomplete or Lark-native option picker
- No new persisted parse metadata on `Task`, `TaskSubmission`, or `TaskSource`
- No shortening of long model lists; full allowlists should still be returned
- No listener-side option suggestion logic for `/task`
- No change to plain-message or non-text local usage behavior outside `/task`
- No requirement that CLI or other producers start sending partial tasks in this change, even though the API contract will allow it

## 4. Scope Assessment

This is one coherent feature rather than multiple projects.

The change spans several packages because the current partial-command rejection happens too early in the flow:

- `lark-listener` decides whether `/task` is submitted at all
- `/tasks` decides which incomplete shapes are allowed onto the queue
- enrichment decides which option list or payload guidance to return
- the existing result pipeline delivers the final user-visible message

Those layers must stay aligned or the same input will produce different behavior depending on where it is rejected.

## 5. User Decisions Captured

- Help should come from the pipeline, not an immediate listener reply
- `/task <invalid>` should be interpreted as an invalid task type
- Missing and invalid executor should both show valid executors
- Missing and invalid model should both show valid models
- Missing and blank payload should be treated the same
- Bare `/task` should return both the canonical syntax and valid task types
- Payload-required replies should return both the canonical syntax and a payload-required explanation
- Partial `/task` submissions should still receive the normal Lark reaction
- Invalid task type takes precedence over later executor/model tokens
- Invalid executor takes precedence over any model token that follows it
- The API capability should be general, not limited to Lark-only requests
- Stage inference should come only from existing task fields being present or missing, not from added parse metadata

## 6. Current State

### 6.1 Listener behavior

`packages/daemon/lark-listener/src/message-handler.ts` currently treats `/task` as valid only when the first line matches:

```text
/task <type> <executor> <model> <payload>
```

Anything shorter falls back to the generic usage reply and is **not** submitted.

That blocks the pipeline from helping with partial states such as:

- missing `task_type`
- missing `executor`
- missing `model`
- missing payload

### 6.2 API behavior

`packages/api/src/routes/tasks.ts` currently enforces normal-task completeness at submission time:

- `task_type` must be a non-empty string
- `executor` and `executor_model` must both be present for non-control tasks
- non-control payload must be non-empty

That means even if the listener started submitting partial `/task` commands, the API would still reject them before they reached enrichment.

### 6.3 Shared task contract

`TaskSubmission.executor` and `Task.executor` are currently typed as `TaskExecutorType`, which assumes the token is already valid.

That makes the type contract too narrow for this feature because `/task localagent foo` needs to carry the raw invalid executor token `"foo"` through the queue so enrichment can respond with valid executors.

### 6.4 Enrichment behavior

`packages/daemon/task-enrichment/src/enrichment-service.ts` already has the final-stage semantic checks for:

- unknown `task_type`
- invalid `executor`
- invalid `executor_model`

But it does not yet have staged handling for:

- missing `task_type`
- missing `executor`
- missing `model`
- missing payload

It also assumes the API has already ruled out incomplete normal-task submissions.

## 7. Approaches Considered

### Approach A - Listener-side progressive help

Teach `lark-listener` to parse `/task` progressively and reply locally with valid task types, executors, models, or payload guidance.

**Pros**

- Smallest backend change
- Fastest user feedback

**Cons**

- Conflicts with the decision to keep help in the pipeline
- Duplicates validation logic and copy outside enrichment
- Creates two sources of truth for task option help

### Approach B - General partial normal-task submission through the API (recommended)

Allow partial non-control task submissions onto the queue, infer the user's current routing stage from existing task fields, and let enrichment return the next relevant help message.

**Pros**

- Matches all captured product decisions
- Keeps user-facing guidance in one semantic validation layer
- Reuses the existing Lark result delivery path
- Requires no new persisted metadata

**Cons**

- Broadens the API contract for all normal-task producers
- Requires careful guardrails so incomplete normal tasks never execute

### Approach C - Partial-task mode with explicit parse metadata

Add an explicit partial-command marker or parse-stage field so enrichment knows whether the user stopped at type, executor, model, or payload.

**Pros**

- More explicit backend semantics
- Easier to reason about exact parser state

**Cons**

- Conflicts with the decision not to add metadata
- More surface area than needed
- Harder to keep existing task contracts simple

## 8. Recommendation

Adopt **Approach B**.

It is the smallest coherent design that satisfies all chosen behaviors:

- pipeline-only help
- progressive `/task` submission
- existing-field inference only
- task-type precedence over executor/model
- executor precedence over model
- full option lists
- continued Lark reaction behavior

The main contract change is that partial **normal** tasks become valid queue inputs, while still being guaranteed to terminate as enrichment rejections until all required routing fields and payload are present.

## 9. Proposed Design

### 9.1 Canonical `/task` syntax remains unchanged

The runnable command remains:

```text
/task <type> <executor> <model> <payload>
```

This feature does **not** make shorter forms executable. It only makes them eligible for downstream help.

The distinction is:

- shorter forms are valid **help-seeking submissions**
- only the full form with a non-empty payload is a valid **runnable submission**

### 9.2 Progressive `/task` parsing in `lark-listener`

`MessageHandler` should stop treating shorter `/task` forms as parser errors.

For `/task`, the listener should submit the best-effort routing shape it can infer from the first line:

| User input | Submitted shape |
|---|---|
| `/task` | `task_type: ''`, no executor, no model, `payload: ''` |
| `/task foo` | `task_type: 'foo'`, no executor, no model, `payload: ''` |
| `/task localagent` | `task_type: 'localagent'`, no executor, no model, `payload: ''` |
| `/task localagent cursor` | `task_type: 'localagent'`, `executor: 'cursor'`, no model, `payload: ''` |
| `/task localagent cursor auto` | `task_type: 'localagent'`, `executor: 'cursor'`, `executor_model: 'auto'`, `payload: ''` |
| `/task localagent cursor auto fix this` | full runnable shape |

Important parsing rules:

- The parser still recognizes `/task` only when the message starts with the exact command token, not `/taskforce`
- Multiline payload is preserved **only when the payload starts on the first line**
- If the first line ends right after `<model>`, the command is treated as missing payload even if later lines exist
- Plain text and non-text messages remain local usage replies and are not submitted
- `/new`, `/gc`, and `/end` keep their current local command parsing behavior

This preserves the canonical syntax while letting partial `/task` states reach enrichment.

### 9.3 Shared task contract carries raw routing tokens

`TaskSubmission` and `Task` should continue using the same existing fields, but `executor` must become a raw optional string rather than `TaskExecutorType`.

Recommended type boundary:

```ts
export interface TaskSubmission {
  task_type: string;
  payload: string;
  executor?: string;
  executor_model?: string;
  task_source?: TaskSource;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  executor?: string;
  executor_model?: string;
  submitted_at: string;
  task_source?: TaskSource;
}
```

Execution-facing types such as `JobSubmission`, `JobAttempt`, and `TaskResultSubmission` should stay strict and continue using validated executor enums.

That keeps the queue layer flexible while preserving strictness once a job is actually runnable.

### 9.4 API accepts partial normal-task submissions

`POST /tasks` should shift from "normal tasks must already be runnable" to "task submissions must be structurally meaningful enough for enrichment to decide."

#### Structural validation that should remain

- `task_type` must be a string, but it may now be empty for partial `/task`
- `payload` must be a string
- `task_source`, when present, must still pass existing validation
- `executor_model` without `executor` remains invalid and should return `400`
- Control vs non-control continues to be determined by `isControlTaskType(task_type)` (see `CONTROL_TASK_TYPES` in shared types). An empty `task_type` is not a control task, so the relaxed non-control rules apply.

#### Validation that should move out of the API for non-control tasks

For non-control tasks, the API should no longer require:

- non-empty `task_type`
- present `executor`
- present `executor_model`
- non-empty payload
- valid executor/model pair

Those checks move to enrichment so the user gets the next relevant option help instead of a generic HTTP failure.

`POST /tasks` today skips executor/model pair validation when `task_source.source === 'lark'`; once routing checks move to enrichment for all non-control tasks, that deferral should collapse into the same rule—**no** executor/model correctness checks at the HTTP layer for non-control submissions (Lark and non-Lark producers behave the same).

#### Control tasks remain strict

This feature is about `/task`, not progressive `/new`.

So control-task handling should remain strict:

- bare `/new`, `/gc`, `/end` still work
- explicit `/new <executor> <model>` still requires a valid pair when present
- partial control routing inputs should continue to fail locally in the listener rather than becoming queued help requests

That keeps the contract change narrowly targeted at normal-task progressive help.

### 9.5 Enrichment becomes the stage-aware help engine

For non-control tasks, `EnrichmentService.enrich(...)` should evaluate fields in this exact order.

Normalize `task_type` once with `trim()` for all non-control staging: a **missing** task type is an empty string after trim; **unknown** and downstream stages use that same trimmed value so spacing does not change semantics or echoed copy.

1. **Missing task type**
2. **Unknown task type**
3. **Missing executor**
4. **Invalid executor**
5. **Missing model**
6. **Invalid model**
7. **Missing or blank payload**
8. **Runnable task enrichment**

That ordering implements the desired precedence:

- invalid task type wins over later executor/model tokens
- invalid executor wins over later model tokens
- payload guidance only appears after type/executor/model are all semantically valid

### 9.6 Exact help semantics by stage

#### Missing task type

Input examples:

- `/task`
- partial submissions where `task_type` is empty after trim (including `''` and whitespace-only)

Response should include:

- the canonical syntax line
- the valid task types from current enrichment rules

#### Unknown task type

Input example:

- `/task foo`

Response should include:

- the invalid task type
- the valid task types

This should win even if later executor/model tokens look valid.

#### Missing executor

Input example:

- `/task localagent`

Response should include:

- the task type being completed
- the valid executors

#### Invalid executor

Input example:

- `/task localagent foo`

Response should include:

- the invalid executor token
- the valid executors

The model token should not be considered until executor is valid.

#### Missing model

Input example:

- `/task localagent cursor`

Response should include:

- the executor being completed
- the full valid model list for that executor

#### Invalid model

Input example:

- `/task localagent cursor xyz`

Response should include:

- the invalid model
- the full valid model list for that executor

#### Missing or blank payload

Input examples:

- `/task localagent cursor auto`
- `/task localagent cursor auto    `

Response should include:

- the canonical syntax line
- an explicit "payload is required" explanation

Missing and whitespace-only payload should behave identically.

### 9.7 Shared error-format helpers

The user-facing copy for progressive `/task` help should live in shared helpers alongside the existing invalid executor/model helpers.

Recommended additions in `packages/shared/src/routing-errors.ts`:

- `TASK_COMMAND_USAGE`
- `formatMissingTaskTypeMessage(validTypes: string[])`
- `formatUnknownTaskTypeMessage(taskType: string, validTypes: string[])`
- `formatMissingExecutorMessage(taskType: string)`
- `formatMissingModelMessage(executor: TaskExecutorType)`
- `formatMissingPayloadMessage()`

The existing helpers should stay:

- `formatInvalidExecutorMessage('/task' | '/new', executor)`
- `formatInvalidModelMessage('/task' | '/new', executor, model)`

That gives the pipeline one shared source of truth for all user-visible routing help.

### 9.8 Poller behavior stays mostly unchanged

`EnrichmentPoller` already converts enrichment rejections into failed `TaskResultSubmission` records and publishes them through `/results`.

That path should remain unchanged for this feature.

The only expected poller work is focused regression coverage to prove that the new staged rejection messages are still published verbatim to Lark-visible results.

### 9.9 Interaction with control tasks

This feature should not broaden `/new`, `/gc`, or `/end` into progressive help flows.

Specifically:

- `/new` keeps current exact parsing and current enrichment behavior
- `/gc` keeps current base-message-only behavior
- `/end` keeps current cleanup behavior
- control tasks should not use the new partial normal-task help stages

That keeps the change focused on the user request rather than redesigning every command.

## 10. Data Flow

### 10.1 Bare `/task`

```text
User sends: /task
      |
      v
lark-listener
  -> submit partial task with task_type=''
      |
      v
API /tasks
  -> accept string payload + empty task_type
      |
      v
enrichment
  -> detect missing task type
  -> reject with canonical syntax + valid task types
      |
      v
enrichment-poller
  -> publish failed result
      |
      v
lark-result
  -> reply in thread with help text
```

### 10.2 Missing model

```text
User sends: /task localagent cursor
      |
      v
lark-listener
  -> submit { task_type: 'localagent', executor: 'cursor', payload: '' }
      |
      v
API /tasks
  -> accept executor without model for non-control task
      |
      v
enrichment
  -> task type exists
  -> executor valid
  -> model missing
  -> reject with valid cursor models
```

### 10.3 Missing payload

```text
User sends: /task localagent cursor auto
      |
      v
lark-listener
  -> submit { task_type: 'localagent', executor: 'cursor', executor_model: 'auto', payload: '' }
      |
      v
enrichment
  -> type valid
  -> executor valid
  -> model valid
  -> payload blank
  -> reject with canonical syntax + payload-required message
```

### 10.4 Runnable task

```text
User sends: /task localagent cursor auto investigate the bug
      |
      v
lark-listener
  -> submit full shape
      |
      v
API /tasks
  -> accept
      |
      v
enrichment
  -> all stages pass
  -> create job
```

## 11. File Changes

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Allow raw `executor?: string` on `TaskSubmission` and `Task` while keeping job/result types strict |
| `packages/shared/src/index.ts` | Modify | Re-export any new progressive-help formatting helpers/constants |
| `packages/shared/src/routing-errors.ts` | Modify | Add missing-stage `/task` help formatters and canonical syntax constant |
| `packages/shared/src/__tests__/routing-errors.test.ts` | Modify | Lock exact copy for missing task type, missing executor, missing model, missing payload, and existing invalid executor/model helpers |
| `packages/api/src/routes/tasks.ts` | Modify | Accept partial non-control tasks, reject only structurally invalid shapes, keep control-task strictness |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Cover accepted partial shapes, continued control validation, and `executor_model`-without-`executor` rejection |
| `packages/daemon/lark-listener/src/message-handler.ts` | Modify | Submit progressive `/task` shapes instead of replying locally for partial `/task` forms |
| `packages/daemon/lark-listener/src/adapters/task-submitter.ts` | Modify | Accept raw optional executor strings and serialize partial `/task` submissions |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Modify | Cover `/task`, `/task <type>`, `/task <type> <executor>`, `/task <type> <executor> <model>`, payload-required flow, and continued reaction behavior |
| `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts` | Modify | Verify raw partial routing fields are posted as submitted |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Add ordered stage inference for missing/invalid type, executor, model, and payload |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Assert exact staged rejection precedence and happy-path enrichment |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Modify | Confirm staged rejection reasons still publish verbatim through `/results` |

## 12. Testing Strategy

### 12.1 Shared formatting

- bare `/task` formatting returns syntax + valid task types
- unknown type formatting returns invalid type + valid task types
- missing executor formatting returns valid executors
- invalid executor formatting stays unchanged
- missing model formatting returns valid models
- invalid model formatting stays unchanged
- missing payload formatting returns syntax + payload-required message

### 12.2 API route

- accepts non-control task with empty `task_type`
- accepts non-control task with `task_type` only
- accepts non-control task with `task_type` + executor only
- accepts non-control task with full routing but blank payload
- rejects `executor_model` without `executor`
- keeps `/new` validation strict
- keeps other existing source-shape validation intact

### 12.3 Lark listener

- `/task` submits a partial task and still reacts
- `/task localagent` submits partial routing and still reacts
- `/task localagent cursor` submits partial routing and still reacts
- `/task localagent cursor auto` submits with blank payload and still reacts
- `/task localagent cursor auto hello` submits full runnable shape
- `/taskforce ...` is still not treated as `/task`
- plain text remains a local usage reply
- non-text remains a local usage reply

### 12.4 Enrichment service

- missing task type returns syntax + valid task types
- unknown task type wins over later executor/model tokens
- missing executor returns valid executors
- invalid executor wins over model guidance
- missing model returns valid models
- invalid model returns valid models
- missing payload returns syntax + payload-required message
- fully valid task still enriches successfully

### 12.5 Result pipeline

- staged rejections from enrichment are still published unchanged through `/results`
- Lark-sourced tasks still reply in-thread with the exact rejection text

## 13. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| General API capability lets other producers enqueue incomplete normal tasks | Keep the capability limited to queue acceptance; enrichment always rejects incomplete shapes before job creation |
| Broadening `Task.executor` to `string` weakens type safety in queue-layer code | Keep execution-facing job/result types strict and validate before job creation |
| Missing-payload parsing could become ambiguous with newline-start payloads | Preserve the existing rule that payload must start on the first line after `<model>` and document it explicitly |
| API relaxation could accidentally make control commands too permissive | Keep control-task validation separate and strict |
| Message copy diverges between listener usage replies and pipeline help replies | Centralize `/task` help strings in shared helpers and keep listener local usage copy intentionally limited to non-`/task` cases |

## 14. Acceptance Criteria

1. `/task` is submitted to the pipeline and replies with the canonical syntax plus valid task types.
2. `/task <invalid>` replies with invalid-task-type guidance and valid task types.
3. `/task <valid-type>` replies with valid executors.
4. `/task <valid-type> <valid-executor>` replies with valid models for that executor.
5. `/task <valid-type> <valid-executor> <valid-model>` with empty or whitespace-only payload replies with canonical syntax plus a payload-required message.
6. `/task <invalid-type> <valid-executor> <valid-model> <payload>` still prioritizes task-type guidance.
7. `/task <valid-type> <invalid-executor> <any-model>` still prioritizes executor guidance.
8. Partial `/task` submissions still receive the normal Lark reaction.
9. Plain text and non-text Lark messages remain local usage replies and are not submitted as tasks.
10. `/new`, `/gc`, and `/end` retain their current behavior.
11. No incomplete normal-task submission ever becomes a runnable job.
