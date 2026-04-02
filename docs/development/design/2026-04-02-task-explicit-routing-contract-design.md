# Design: Explicit `/task` Routing Contract

**Date:** 2026-04-02
**Status:** Ready for implementation
**Type:** Breaking change / command contract redesign
**Packages:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/lark-listener-daemon`, `@local-agent/task-enrichment-daemon`, `@local-agent/cli`, `@local-agent/lark-result-daemon`

## 1. Problem

Today the system still treats `task_type` as the primary user-facing routing input, while executor and model are selected later through enrichment rules and thread inheritance.

That creates three problems:

1. The normal `/task` command is incomplete. Users can choose a task type, but not the executor/model pair directly.
2. Routing responsibility is split awkwardly across layers:
   - `lark-listener` parses only `task_type`
   - enrichment YAML chooses executors/models
   - thread metadata may later override that choice
3. Lark still accepts plain non-command messages as implicit `generic` tasks, which is convenient but no longer matches the desired explicit-routing model.

The requested direction is a stronger contract:

- normal tasks should be submitted with explicit `task_type`, `executor`, `executor_model`, and `payload`
- `/task` becomes the primary normal-task entrypoint in Lark
- plain Lark messages stop creating tasks
- task-type YAML should remain useful, but only for prompts/hooks rather than executor selection

## 2. Goal

Redesign task submission so normal tasks are explicitly routed at submission time, while control commands remain the only tasks allowed to defer executor/model resolution:

- `/task <type> <executor> <model> <payload>` is the only valid normal Lark task syntax
- root `/task` establishes thread-visible routing metadata through the normal result markers
- plain Lark text and non-text messages are rejected with the command usage hint
- threaded `/task` is rejected in all cases
- `TaskSubmission` / `Task` can omit `executor` and `executor_model` only for control commands
- enrichment YAML keeps owning task-type-specific prompts/hooks, not executor/model selection

## 3. Non-goals

- No compatibility support for the old `/task <type> <payload>` syntax
- No continued support for plain implicit `generic` Lark messages
- No support for threaded `/task`, even when it matches existing thread routing
- No shell-style quoting or delimiter syntax for `/task`
- No new persistence layer for thread state
- No change to the visible reply-marker architecture for `task_type`, `executor`, `model`, and `session_id`
- No attempt to make CLI control-command submission a first-class workflow

## 4. Scope Assessment

This is one coherent subsystem change, not multiple separate projects.

The feature spans several packages because the repo currently treats task routing as a cross-cutting contract:

- shared task/result types
- `/tasks` API validation
- Lark command parsing and submission
- enrichment behavior
- CLI submission
- thread inheritance via visible reply metadata

Those all need to move together for the new command model to remain internally consistent.

## 5. User Decisions Captured

- The new normal-task syntax is the exact contract:
  - `/task <type> <executor> <model> <payload>`
- The old `/task <type> <payload>` form is removed.
- `/task` requires a non-empty payload.
- Payload begins immediately after `<model>` on the same line.
- Payload may contain later spaces or newlines, but it may not begin on a new line.
- Plain Lark messages are rejected instead of becoming `generic` tasks.
- Non-text Lark messages are also rejected with the same usage hint.
- Threaded `/task` is rejected in every case.
- Root `/task` establishes both thread `task_type` and thread executor/model for later metadata-based inheritance.
- Thread metadata continues to use visible bot reply markers as the durable source of truth.
- Syntax validation should stay in `lark-listener`; semantic executor/model validation should happen downstream via shared/API validation.
- Unknown task types should still be rejected through the YAML-backed enrichment path because YAML remains the source of task-type prompt/hook definitions.
- Task-type YAML should keep only prompt/hook responsibilities.
- `executor` and `executor_model` are optional only for control commands.
- Control commands should not use synthetic placeholder executor/model pairs.
- `/new` remains as-is conceptually: the dedicated way to start a fresh instance/reset context.
- CLI normal submission should require explicit `--type`, `--executor`, and `--model`.
- The main usage hint should be updated to the new exact `/task` syntax and still mention `/end`.

## 6. Current State

Today the system behaves differently from the desired explicit contract:

- `MessageHandler` parses:
  - `/task <type> <payload>`
  - bare `/new`
  - `/new <executor> <model>`
  - bare `/gc`
  - bare `/end`
- plain Lark messages become `task_type: 'generic'`
- non-text Lark messages are converted into structured JSON payloads and also submitted as `generic`
- `TaskSubmission` and `Task` do not carry executor/model
- `POST /tasks` accepts only `task_type`, `payload`, and optional `task_source`
- enrichment YAML still chooses executors/models per `task_type`
- thread metadata can override executor/model later based on visible `executor:` and `model:` reply lines
- threaded `/task` is currently rejected only when it conflicts with the inherited thread `task_type`

That means executor/model selection for ordinary tasks is still an enrichment concern rather than an input contract.

## 7. Approaches Considered

### Approach A - Parser-only overlay

Keep the task schema mostly unchanged and encode executor/model inside command-specific payload formats.

**Pros**

- Smaller shared/API diff
- Less churn for current task producers

**Cons**

- Fights the requested explicit-routing direction
- Hides routing inside payload conventions
- Makes validation and debugging less uniform

### Approach B - Explicit routing contract with control-command exceptions (recommended)

Make normal tasks carry explicit routing fields at submission time, while allowing only control commands to omit executor/model so enrichment can resolve them.

**Pros**

- Matches the requested product contract closely
- Keeps routing explicit for normal tasks
- Preserves coherent `/new`, `/gc`, and `/end` control behavior
- Lets YAML keep a smaller, clearer responsibility boundary

**Cons**

- Broad surface-area change across shared types, API, listener, CLI, and tests
- Requires careful validation rules to distinguish normal tasks from control commands

### Approach C - Explicit routing plus task-type policy enforcement

Require routing fields on normal tasks, but also add a new policy layer in enrichment that restricts which executors/models each task type may use.

**Pros**

- Stronger central policy control
- Future room for per-task restrictions

**Cons**

- More complexity than requested
- Introduces a new "requested vs effective routing" model
- Not necessary to satisfy the stated feature goals

## 8. Recommendation

Adopt **Approach B**.

It cleanly matches the desired user experience:

- normal work uses explicit `/task`
- control commands remain special
- thread state still flows through reply markers
- YAML is simplified to prompts/hooks rather than executor selection

This is the smallest coherent design that satisfies all of the captured product decisions without introducing a new policy layer.

## 9. Proposed Design

### 9.1 Public command contract in Lark

#### Normal task command

`MessageHandler.parseCommand()` should treat only this form as a valid normal task:

- `/task <type> <executor> <model> <payload>`

Rules:

- `type`, `executor`, and `model` are the first three whitespace-delimited tokens after `/task`
- payload is the remainder after the third delimiter
- payload must be non-empty
- payload must begin on the same line as `<model>`
- payload may contain subsequent spaces and newlines
- `/task`
- `/task <type>`
- `/task <type> <executor>`
- `/task <type> <executor> <model>`
- `/task <type> <executor> <model>\n<payload>`
  are all invalid and should trigger the usage hint

Example valid command:

```text
/task code_review cursor gpt-5.4-medium-fast review the failing tests
```

Example valid multiline payload:

```text
/task code_review claude sonnet review this diff
and explain the regression risk
```

Example invalid multiline-start payload:

```text
/task code_review claude sonnet
review this diff
```

#### Control commands

These remain reserved commands:

- `/new`
- `/new <executor> <model>`
- `/gc`
- `/end`

Their special semantics stay in place, but they now align better with the shared task contract:

- explicit `/new <executor> <model>` should use structured task fields rather than encoding a JSON override inside `payload`
- bare `/new`, `/gc`, and `/end` may omit `executor` / `executor_model`

### 9.2 Shared task contract

`packages/shared/src/types.ts` should extend `TaskSubmission` and `Task` to include routing fields:

```ts
export interface TaskSubmission {
  task_type: string;
  payload: string;
  executor?: TaskExecutorType;
  executor_model?: string;
  task_source?: TaskSource;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  executor?: TaskExecutorType;
  executor_model?: string;
  submitted_at: string;
  task_source?: TaskSource;
}
```

The fields are optional at the type level because control commands may omit them, but the contract is stricter than "optional everywhere":

- non-control tasks must provide both fields
- control tasks may omit both fields
- one field without the other is always invalid

#### Control-task definition

The system should treat these as control task types:

- `new_instance`
- `gc`
- `cleanup`

That distinction can live either:

- in shared helpers, or
- in route/service validation local to the affected packages

The important contract is behavioral, not where the helper function lives.

### 9.3 `/tasks` API validation

`packages/api/src/routes/tasks.ts` should become the main structural validator for submitted tasks.

Validation rules:

1. `task_type` must be a non-empty string
2. `payload` must be a string
3. `task_source`, when present, must pass existing source validation
4. `executor` and `executor_model` must be provided together
5. if both are present, they must be a valid shared pair
6. if `task_type` is not a control task:
   - both `executor` and `executor_model` are required
   - `payload.trim()` must be non-empty
7. if `task_type` is a control task:
   - executor/model may be absent
   - payload may be empty
8. for **non-control** tasks, whether `task_type` is defined in enrichment YAML is **not** asserted at `/tasks`; missing or unknown types still fail later in enrichment when the YAML rule lookup fails (control task types continue to use their existing dedicated poller/service paths and are not required to mirror the normal-task YAML lookup model)

This keeps semantic task-type existence checks in enrichment, but moves pair validation and control-vs-normal contract enforcement earlier into the API.

### 9.4 CLI submission contract

`packages/cli/src/commands/submit.ts` should follow the new explicit normal-task contract:

- `--payload` remains required
- `--type` becomes required
- `--executor` becomes required
- `--model` becomes required
- there is no default `generic` fallback

The CLI is treated as a normal-task producer, not a control-command transport.

That means the CLI request body for a normal task becomes:

```json
{
  "task_type": "code_review",
  "executor": "claude",
  "executor_model": "sonnet",
  "payload": "review this diff"
}
```

### 9.5 Lark listener becomes command-only

`packages/daemon/lark-listener/src/message-handler.ts` should stop acting as an implicit plain-message submitter.

New high-level behavior:

- text message with valid `/task ...` -> submit normal task
- text message with valid control command -> submit control task
- text message with anything else -> reply with usage hint
- non-text message -> reply with usage hint
- no task submission for invalid or unsupported inputs

This is a deliberate breaking change.

#### Usage hint

The main usage hint should become:

```text
Usage: /task <type> <executor> <model> <payload> or /end (in a thread)
```

The hint remains intentionally short even though `/new` and `/gc` still exist, because the primary guidance is for normal-task usage.

### 9.6 Submission shape from `TaskSubmitter`

`TaskSubmitter.submit(...)` should accept optional executor/model fields and serialize them directly into `TaskSubmission`.

For example:

- normal `/task`:

```json
{
  "task_type": "code_review",
  "payload": "review this diff",
  "executor": "cursor",
  "executor_model": "gpt-5.4-medium-fast",
  "task_source": { "source": "lark", "message_id": "..." }
}
```

- bare `/new`:

```json
{
  "task_type": "new_instance",
  "payload": "",
  "task_source": { "source": "lark", "message_id": "..." }
}
```

- explicit `/new claude sonnet`:

```json
{
  "task_type": "new_instance",
  "payload": "",
  "executor": "claude",
  "executor_model": "sonnet",
  "task_source": { "source": "lark", "message_id": "..." }
}
```

- bare `/gc` and `/end` follow the same omission pattern as bare `/new` (no executor/model), with `task_type` set to `gc` or `cleanup` respectively.

This removes the current special-case JSON payload encoding for explicit `/new` overrides.

### 9.7 Enrichment YAML narrows to prompt/hook configuration

`packages/daemon/task-enrichment/src/enrichment-service.ts` should stop reading executor arrays from YAML rules.

The rule shape becomes conceptually:

```yaml
rules:
  code_review:
    system_prompt: |
      ...
    setup_hook: |
      ...
    setup_hook_timeout_ms: 300000
```

The active YAML responsibilities become:

- existence of valid task types
- `system_prompt`
- `setup_hook`
- `setup_hook_timeout_ms`

Notably removed from task-type YAML responsibility:

- executor selection
- executor fallback arrays
- task-type-driven model selection

Because the user specifically asked for prompts/hooks only, task-type YAML should no longer be the place where normal-task executors/models are chosen.

### 9.8 Enrichment service behavior

`EnrichmentService.enrich(...)` should change from "choose executors from rule" to "apply task-type metadata to an already-routed task."

For normal tasks:

1. validate that a YAML rule exists for `task.task_type`
2. require `task.executor` and `task.executor_model` to already be present
3. validate the pair using existing shared helpers
4. build `job.executors` from exactly that one explicit pair
5. append `system_prompt`, `setup_hook`, and `setup_hook_timeout_ms` from the YAML rule

That means a normal-task `JobSubmission.executors` becomes:

```ts
[{ executor: task.executor, executor_model: task.executor_model }]
```

No task-type executor fallback array survives for normal tasks.

### 9.9 Control-command executor resolution

Control commands are the only place where executor/model may be absent on the incoming `Task`.

#### `/new`

Behavior should remain aligned with the earlier `/new` feature design:

- explicit `/new <executor> <model>`:
  - task already carries the pair
  - enrichment validates it and uses exactly that pair
- bare `/new`:
  - if thread metadata contains an inherited executor/model pair, use that exact pair
  - otherwise use a fixed default `new_instance` fallback pair

Because task-type YAML no longer owns executors, the default bare `/new` fallback should move into control-command logic rather than enrichment rules.

Recommended default:

```ts
{ executor: 'claude', executor_model: 'sonnet' }
```

This matches the current default `new_instance` behavior without keeping executor choice in YAML.

#### `/gc`

`gc` remains a special task with a fixed executor pair, resolved in poller logic:

```ts
{ executor: 'claude', executor_model: 'sonnet' }
```

#### `/end`

`cleanup` remains a special task with a fixed builtin pair:

```ts
{ executor: 'builtin', executor_model: 'none' }
```

### 9.10 Thread behavior

#### Root `/task`

A root `/task` submission should be treated as the normal way to establish thread routing state:

- explicit `task_type`
- explicit `executor`
- explicit `model`
- generated or reused `session_id`
- visible result markers in the bot reply

Because result formatting already includes:

- `executor: ...`
- `model: ...`
- `task_type: ...`
- `session_id: ...`

the existing reply-marker architecture remains the durable thread-state carrier.

#### Threaded `/task`

Any `/task` inside a thread must be rejected.

This is stricter than the current behavior, which only rejects task-type mismatches.

**Where rejection happens:** Thread membership is established when enrichment resolves Lark thread context (for example via `ThreadContextFetcher`), not from the minimal fields the listener uses for command parsing. So the **authoritative** rejection for a non-control `/task` sent inside a thread is in **enrichment-poller** after `POST /tasks` may already have persisted a task row. The listener should still parse `/task` normally and submit; implementers must define a terminal failure path (user-visible thread-specific message, no runnable job) for that case. Optional future optimization: reject earlier in the listener if the Lark event payload is extended to expose a reliable root-vs-thread indicator—only if it stays correct for all chat modes.

New rule:

- if a non-control Lark task resolves to a thread at enrichment time, reject it

The rejection copy can stay in the current style:

```text
Cannot use /task in a thread. Remove the /task prefix or start a new conversation.
```

The exact wording can be tuned, but it should remain a direct thread-specific explanation rather than falling back to the generic usage hint.

#### Plain threaded replies

These will normally be rejected earlier by `lark-listener` because plain Lark messages are no longer valid task submissions at all.

Even so, enrichment should keep a defense-in-depth rejection for non-control threaded tasks in case another producer submits them unexpectedly with a Lark `task_source`.

### 9.11 Thread metadata extraction remains structurally unchanged

`ThreadContextFetcher` should keep the existing architecture:

- extract inherited `task_type`
- extract inherited `session_id`
- extract inherited `executor` / `model`
- strip metadata lines from `threadContext`
- apply `/new` fence behavior

The important behavioral change is not in the fetcher itself, but in who gets to use that context:

- control commands still use thread context and inheritance
- normal `/task` in a thread is rejected rather than interpreted as a retargeting request

### 9.12 Result metadata remains the same

`TaskOrchestrator`, `TaskPoller`, `POST /results`, and `LarkNotifier` already support the visible executor/model marker path.

That architecture should stay intact:

- actual executor/model used for the final attempt is attached to results
- Lark replies keep `executor:` and `model:` visible
- thread inheritance continues to read those values from bot replies

No new persistence mechanism is needed.

### 9.13 Config migration

The YAML files under `packages/daemon/task-enrichment/config/` should be updated so that active task types still exist, but no longer declare executor arrays.

Implications:

- rules like `generic`, `localagent-plan`, and `localagent-exec` remain valid task types
- their executor/model selection moves to explicit task submission
- their prompts/hooks remain configured in YAML
- comments that refer to "default type for plain messages" should be removed because plain Lark messages no longer submit tasks

## 10. Data Flow

### 10.1 Root `/task`

```text
User sends:
/task code_review cursor gpt-5.4-medium-fast review this diff
        |
        v
lark-listener
  -> validate exact command shape
  -> POST /tasks with explicit executor/model
        |
        v
API /tasks
  -> validate non-control task has explicit pair
        |
        v
enrichment
  -> validate task_type exists in YAML
  -> apply prompt/hook config only
  -> job.executors = [{ cursor, gpt-5.4-medium-fast }]
        |
        v
task-daemon executes
        |
        v
Lark reply includes:
  executor: cursor
  model: gpt-5.4-medium-fast
  task_type: code_review
  session_id: ...
```

### 10.2 Bare `/new`

```text
User sends: /new
        |
        v
lark-listener
  -> submit control task without executor/model
        |
        v
enrichment-poller
  -> require thread + inherited session
  -> if inherited executor/model exists, use it
  -> else use fixed new-instance fallback pair
  -> skipContinue = true
```

### 10.3 Invalid plain Lark message

```text
User sends: fix the tests
        |
        v
lark-listener
  -> reply with usage hint
  -> do not submit task
```

### 10.4 Invalid threaded `/task`

```text
User sends in thread:
/task code_review claude sonnet review this
        |
        v
lark-listener
  -> command shape is valid (listener does not decide thread membership)
  -> POST /tasks (task row may exist before enrichment)
        |
        v
enrichment-poller
  -> thread detected via thread-context resolution
  -> reject because non-control /task is not allowed in threads
  -> user-visible thread-specific error (no job execution)
```

## 11. File Changes

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Add optional `executor` / `executor_model` to `TaskSubmission` and `Task`; keep executor result types intact |
| `packages/shared/src/index.ts` | Modify | Re-export any new task-contract helpers if added |
| `packages/shared/src/__tests__/types.test.ts` | Modify | Add task-contract validation coverage if helper functions are introduced |
| `packages/api/src/routes/tasks.ts` | Modify | Enforce control-vs-normal submission rules and validate executor pairs |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Cover required explicit routing for normal tasks and allowed omissions for control tasks |
| `packages/cli/src/commands/submit.ts` | Modify | Require `--type`, `--executor`, and `--model`; send explicit routing fields |
| `packages/cli/src/__tests__/submit.test.ts` | Modify | Verify CLI request body and required options |
| `packages/daemon/lark-listener/src/message-handler.ts` | Modify | Replace implicit plain-message submission with command-only behavior; parse new `/task` syntax |
| `packages/daemon/lark-listener/src/adapters/task-submitter.ts` | Modify | Accept optional executor/model fields and serialize them into `TaskSubmission` |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Modify | Cover new `/task` grammar, invalid plain messages, invalid non-text messages, and `/new` structured submission |
| `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts` | Modify | Verify explicit routing serialization and control-command omissions |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Remove executor selection from YAML rules and build job executors from task input |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Modify | Reject threaded non-control tasks, resolve control-command fallback executors, and preserve `/new` behavior |
| `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Verify | Existing metadata extraction remains the thread-state source of truth |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Cover prompt/hook-only rules and explicit task routing |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Modify | Cover threaded `/task` rejection and control-command routing resolution |
| `packages/daemon/task-enrichment/config/enrichment.yaml` | Modify | Remove executor arrays and keep only task-type metadata fields |
| `packages/daemon/task-enrichment/config/local-agent.yaml` | Modify | Remove executor arrays and preserve hooks/prompts for custom task types |
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Verify | Existing visible metadata contract remains suitable |
| `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts` | Verify or modify | Ensure expected output still reflects visible executor/model markers |
| `docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md` | Modify | Add a short note pointing to this design for the current normal-task routing contract |
| `docs/development/plans/2026-04-02-new-instance-executor-model-inheritance.md` | Modify | Add a short note pointing to this design for the current normal-task routing contract |

## 12. Testing Strategy

### 12.1 Lark listener parsing

- `/task code_review claude sonnet review this` submits a normal task with explicit pair
- `/task code_review claude sonnet` is rejected
- `/task code_review claude` is rejected
- `/task code_review claude sonnet\nreview this` is rejected
- `/taskforce ...` is not treated as `/task`
- plain text message is rejected with usage hint
- image/file/post messages are rejected with usage hint
- bare `/new` submits a control task without executor/model
- explicit `/new claude sonnet` submits a control task with explicit pair

### 12.2 `/tasks` API validation

- non-control task requires executor/model pair
- non-control task rejects missing pair
- non-control task rejects empty payload
- control task accepts omitted pair
- control task accepts explicit valid pair when provided
- any task rejects only-one-of-two routing fields
- any task rejects invalid executor/model pair

### 12.3 CLI contract

- `submit` requires `--type`
- `submit` requires `--executor`
- `submit` requires `--model`
- request body contains `task_type`, `executor`, `executor_model`, and `payload`

### 12.4 Enrichment service

- valid normal task with explicit pair becomes single-entry `job.executors`
- YAML rule existence is still required
- YAML-provided `system_prompt` and hook fields are preserved
- executor arrays are no longer read from YAML

### 12.5 Enrichment poller

- threaded non-control Lark task is rejected even if routing markers exist
- bare `/new` inherits executor/model from thread metadata when present
- bare `/new` falls back to fixed default when no pair is inherited
- explicit `/new <executor> <model>` uses exactly that pair
- `/gc` and `/end` still resolve fixed control executors

### 12.6 Thread metadata

- root `/task` replies still emit visible executor/model/task_type/session_id lines
- thread fetcher still extracts those lines correctly
- `/new` fence behavior is unchanged

## 13. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking plain-message behavior in Lark is surprising to existing users | Make the usage hint explicit and keep command syntax simple |
| Optional executor fields for control tasks create ambiguity in the type contract | Enforce the stricter control-vs-normal rule in API validation and tests |
| Removing executor arrays from YAML could accidentally drop behavior for existing task types | Keep task-type existence and prompt/hook behavior intact; migrate active YAML files in the same change |
| Threaded `/task` rejection now happens later than listener parsing | Keep a dedicated rejection path in enrichment that explains thread usage clearly |
| A syntactically valid threaded `/task` may create a task at the API before enrichment rejects it | Treat as terminal failure with user-visible reply; do not enqueue or run a job; align with existing failure patterns for rejected tasks |
| `/new` fallback behavior becomes split from YAML | Centralize fixed control fallback pairs in one place inside enrichment-poller or shared constants |

## 14. Acceptance Criteria

1. `/task` only accepts the exact normal-task form `/task <type> <executor> <model> <payload>`.
2. Normal Lark messages without `/task` are rejected instead of being submitted as `generic`.
3. Non-text Lark messages are rejected instead of being converted into generic payloads.
4. `TaskSubmission` and `Task` can carry explicit executor/model fields.
5. Non-control tasks require explicit executor/model at the `/tasks` API boundary.
6. Control tasks may omit executor/model without using synthetic placeholder values.
7. Explicit `/new <executor> <model>` uses structured task fields rather than JSON-in-payload overrides.
8. Task-type YAML remains required for known task types, but only for prompt/hook metadata rather than executor selection.
9. Enrichment builds normal-task `job.executors` from the submitted task pair rather than from YAML.
10. Any `/task` used inside a thread is rejected.
11. Root `/task` still establishes visible thread metadata through normal bot replies.
12. CLI normal submission requires explicit `type`, `executor`, and `model`.
