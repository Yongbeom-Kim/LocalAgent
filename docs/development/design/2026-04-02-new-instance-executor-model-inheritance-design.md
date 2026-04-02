# Design: `/new` Executor and Model Inheritance in Lark Threads

> **Naming note:** The current executor naming contract uses `claude` and `cursor`. For the live rename spec, see `docs/development/design/2026-04-02-executor-rename-claude-and-cursor-design.md` and `docs/development/plans/2026-04-02-executor-rename-claude-and-cursor.md`.

> The current normal-task routing contract is defined in `docs/development/design/2026-04-02-task-explicit-routing-contract-design.md` and `docs/development/plans/2026-04-02-task-explicit-routing-contract.md`.

**Date:** 2026-04-02
**Status:** Ready for implementation
**Type:** Feature enhancement
**Packages:** `@local-agent/shared`, `@local-agent/lark-listener-daemon`, `@local-agent/task-enrichment-daemon`, `@local-agent/task-daemon`, `@local-agent/api`, `@local-agent/lark-result-daemon`

## 1. Problem

The existing `/new` command already creates a fresh executor instance inside the same Lark thread and session, but executor selection is still tied to the static `new_instance` enrichment rule.

That creates two workflow gaps:

1. Users cannot explicitly choose the executor/model for a fresh `/new` instance.
2. After a user starts working with a different executor/model in a thread, later bare `/new` commands and ordinary follow-up messages do not inherit that choice.

The desired behavior is:

- `/new` should keep working as a bare command.
- `/new <executor> <model>` should explicitly select the executor/model pair.
- Any later message in the thread should keep using that selected pair until another explicit `/new <executor> <model>` changes it.
- `/gc` and `/end` keep their special behavior and do not inherit executor/model.

## 2. Goal

Extend the thread metadata mechanism so executor/model selection behaves like thread-scoped state:

- successful bot replies visibly include `executor:` and `model:` lines
- thread processing extracts the most recent valid pair from bot replies
- bare `/new` inherits that pair when present, otherwise falls back to enrichment config
- ordinary thread messages also inherit that pair unless the current message explicitly changes it
- explicit `/new <executor> <model>` uses exactly that pair, with no fallback list behind it

## 3. Non-goals

- No new persistence layer, cache, or database for thread state
- No new command for changing executor/model outside `/new <executor> <model>`
- No support for `/new <executor>` without a model
- No support for extra trailing arguments beyond `/new <executor> <model>`
- No inheritance for `/gc` or `/end`
- No executor fallback behind an inherited or explicitly selected thread pair
- No change to how task type inheritance works, beyond coexisting with executor/model inheritance

## 4. User Decisions Captured

- Valid `/new` forms are exactly:
  - `/new`
  - `/new <executor> <model>`
- `/new <executor>` is invalid.
- Executor/model choice is echoed visibly in bot replies using:
  - `executor: <executor>`
  - `model: <model>`
- Bare `/new` scans backward for the most recent bot reply containing both lines.
- If no valid pair can be found, bare `/new` falls back to the configured `new_instance` enrichment rule.
- All messages inherit the thread's executor/model pair unless they explicitly change it.
- Today, the only command that explicitly changes the pair is `/new <executor> <model>`.
- Invalid executor/model pairs should be rejected according to normal layer responsibilities:
  - `lark-listener` handles command syntax and arity
  - shared validation / enrichment handles executor-model validity
- `executor:` and `model:` lines must remain visible in the user-facing Lark reply.
- Those lines must be stripped from `threadContext` before history is passed to executors.
- Thread-selected executor/model replaces the effective executor list entirely for inheriting tasks.
- If that selected executor later fails, the task fails; it does not fall back to the YAML preference array.
- `/gc` and `/end` remain special and do not inherit executor/model.
- A later successful `/new <executor> <model>` replaces the previously inherited pair for future messages.

## 5. Current State

Relevant behavior already exists in nearby features:

- `MessageHandler` already parses bare `/new` into `task_type: 'new_instance'`.
- `EnrichmentPoller` already treats `new_instance` specially and sets `skipContinue: true`.
- `ThreadContextFetcher` already extracts:
  - inherited `task_type`
  - inherited `session_id`
  - post-`/new` context fences
- `LarkNotifier` already emits visible thread metadata lines for `task_type` and `session_id`.
- `TaskOrchestrator` already knows the concrete executor/model pair used for each attempt.

The missing piece is a first-class thread inheritance path for executor/model, plus parser support for explicit `/new <executor> <model>`.

## 6. Approaches Considered

### Approach A — Extend the existing reply-marker inheritance pattern (recommended)

Use visible reply markers for `executor:` and `model:`, extract them in `ThreadContextFetcher`, and let `EnrichmentPoller` override enriched executor preferences with the inherited pair when appropriate.

**Pros**

- Matches the existing `task_type` and `session_id` architecture.
- No new infrastructure.
- State is transparent and debuggable in-thread.
- Keeps thread parsing in one place.

**Cons**

- Requires a few more metadata fields to flow through results.
- Thread metadata extraction becomes slightly more asymmetric:
  - `task_type` and `session_id` come from older/root metadata behavior
  - `executor/model` comes from the most recent valid reply

### Approach B — Handle executor/model inheritance only in `EnrichmentPoller`

Keep the current `ThreadContextFetcher` contract unchanged and add ad hoc backward-scanning for `executor:` / `model:` inside the poller.

**Pros**

- Fewer type changes in the thread context adapter.

**Cons**

- Splits thread parsing logic across multiple layers.
- Harder to test and maintain.
- Drifts away from the existing metadata extraction pattern.

### Approach C — Persist thread executor state outside message history

Introduce a dedicated store keyed by thread/session to remember the chosen pair.

**Pros**

- Strongly structured state.

**Cons**

- Unnecessary infrastructure for the current problem.
- Duplicates information already available in thread history.
- Violates the repo's established metadata-through-replies pattern.

## 7. Recommendation

Adopt **Approach A**.

The system already uses visible reply tags as the durable source of thread-scoped state. Extending that mechanism to cover `executor:` and `model:` is the smallest coherent change, and it gives bare `/new` and ordinary thread follow-ups the same inheritance source.

## 8. Proposed Design

### 8.1 Command contract in `MessageHandler`

`MessageHandler.parseCommand()` will accept:

- `/new`
- `/new <executor> <model>`

It will reject:

- `/new <executor>`
- `/new <executor> <model> <extra>`
- `/new` followed by multiline payload content

#### Parsing responsibility split

`lark-listener` should only validate command shape, not semantic executor/model validity.

That means:

- if the command does not have either 0 args or exactly 2 args, reply with the existing usage hint
- if it has exactly 2 args, submit a `new_instance` task whose payload encodes the explicit override
- executor/model validity is checked later using the shared allowlists

#### Payload encoding

Because `TaskSubmission` currently only has `task_type`, `payload`, and `task_source`, the explicit override will be encoded into `payload` as JSON:

```json
{"executor":"cursor_agent","executor_model":"gpt-5.4-medium-fast"}
```

Behavior:

- bare `/new` -> `taskPayload: ''`
- explicit `/new <executor> <model>` -> `taskPayload: JSON.stringify({ executor, executor_model })`

This keeps the parser change small and preserves the current task schema.

### 8.2 Result metadata: add executor/model to task results

To make executor/model durable in thread history, successful task results need to carry the actual pair used at execution time.

#### Shared type changes

Add optional fields to result types in `packages/shared/src/types.ts`:

```ts
export interface TaskResultSubmission {
  job_id: string;
  task_id: string;
  task_type: string;
  session_id?: string;
  executor?: TaskExecutorType;
  executor_model?: string;
  status: ResultStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  task_source?: TaskSource;
}
```

These are optional because rejection results created directly by the enrichment daemon do not have a concrete execution attempt.

### 8.3 Emit visible `executor:` / `model:` lines in Lark replies

`LarkNotifier` will prepend visible metadata lines near the start of every Lark reply when executor metadata is present:

```text
executor: cursor_agent
model: gpt-5.4-medium-fast
task_type: code_review
session_id: 018f6b7e-1234-7abc-8def-1234567890ab
Task ID: ...
Job ID: ...
status: success
Exit code: 0
Output:
...
```

Rules:

- `executor:` and `model:` appear only when both are present on the result
- they remain visible to users
- they are emitted on ordinary successful or failed execution results
- enrichment rejection results may omit them

This makes the latest actual executor/model pair discoverable from thread history.

### 8.4 Capture the actual executor/model used by the orchestrator

`TaskOrchestrator.runExecutors()` already knows which `ExecutorPreference` is being attempted.

When an attempt returns a result, the orchestrator will annotate it before returning:

```ts
lastResult = {
  ...executorResult,
  executor: pref.executor,
  executor_model: pref.executor_model,
};
```

This should happen for both:

- the first success returned to the caller
- the final failure returned after all configured preferences are exhausted

When `job.executors` contains only one pair (including thread-inherited tasks), those cases collapse to a single attempt: annotate that pair on success or on that attempt’s failure.

That way, Lark replies always reflect the actual pair used for the task outcome.

### 8.5 Pass executor/model through the results API and task poller

#### `packages/api/src/routes/results.ts`

Accept optional `executor` and `executor_model` fields on POST `/results`:

- validate them only when provided
- if one is provided, require both
- validate the pair with the existing shared helpers:
  - `isTaskExecutorType()`
  - `isValidExecutorModel()`

#### `packages/daemon/task/src/task-poller.ts`

Preserve executor/model when forwarding results from the task daemon to the results API, alongside existing `task_type`, `session_id`, and `task_source`.

### 8.6 Extend `ThreadContextFetcher` with inherited executor/model

Add fields to `ThreadContextResult`:

```ts
export interface ThreadContextResult {
  threadContext: string | null;
  inheritedTaskType: string | null;
  inheritedSessionId: string | null;
  inheritedExecutor: TaskExecutorType | null;
  inheritedExecutorModel: string | null;
}
```

#### Extraction algorithm

Unlike `task_type` and `session_id`, executor/model should come from the **most recent** valid bot reply in the thread.

#### Message list for extraction

Run the scan on the **full** thread message list returned by `fetchAllThreadMessages` (before `applyNewInstanceFence`). `threadContext` body text must still be built from the fenced slice only, as today. Splitting the two avoids dropping a valid pair that appears before the last `/new` boundary while keeping conversational history truncated at the fence.

Algorithm:

1. Iterate thread messages in reverse chronological order.
2. Consider only bot messages.
3. Parse content via `extractLarkMessageContent()`.
4. Match:
   - `^executor: ([a-zA-Z0-9_-]+)$`
   - `^model: ([^\n]+)$`
5. Require both lines to be present in the same message.
6. Trim whitespace from both captured groups, then validate:
   - executor is a valid `TaskExecutorType`
   - model is valid for that executor via `isValidExecutorModel()`
7. Return the first valid pair found in reverse order.
8. If no valid pair is found, return `null` fields and let enrichment config decide.

#### Source restriction

Only bot replies from this system are intended to count.

The current implementation already approximates that pattern by inspecting non-user messages, and this feature should follow the same convention as `task_type` / `session_id` extraction.

### 8.7 Strip executor/model lines from thread history

Add stripping regexes in `ThreadContextFetcher`, alongside the existing `task_type` and `session_id` stripping. Prefer **prefix-based** line removal so any line starting with `executor:` or `model:` is removed from the formatted `threadContext`, even if it would not have passed extraction validation (avoids leaving spoofed or malformed lines in prompts):

```ts
const EXECUTOR_LINE_REGEX = /^executor: .*\n?/m;
const MODEL_LINE_REGEX = /^model: .*\n?/m;
```

When formatting `threadContext`, remove:

- `executor: ...`
- `model: ...`
- `task_type: ...`
- `session_id: ...`

This preserves the visible markers in Lark while avoiding metadata noise in executor prompts.

### 8.8 Inheritance behavior in `EnrichmentPoller`

`EnrichmentPoller` becomes the place where thread metadata is turned into effective executor preferences.

The poller already handles `new_instance` in a **dedicated early branch** (before the generic enrich path). This feature must extend that branch for explicit `/new <executor> <model>` and bare `/new` executor behavior, and extend the generic path for ordinary messages—not only the default enrich block at the end.

Executor/model inheritance applies only when `fetchThreadContext` returns a non-null `ThreadContextResult` (Lark `task_source`, configured `ThreadContextFetcher`, message participates in a thread, and fetch did not fail). If the fetcher is absent, the call is skipped and there is no thread result; if the fetch returns `null`, there is no inherited pair—use enrichment config as today.

#### Control commands stay special

- `/gc` ignores inherited executor/model
- `/end` ignores inherited executor/model (listener maps bare `/end` to `task_type: cleanup`; apply the same non-inheritance rules to `cleanup` tasks as to `gc`)

Implementation should key off existing control-task flags (`isGcTask`, `isCleanupTask`, etc.) so behavior stays aligned with today’s poller structure.

#### Explicit `/new <executor> <model>`

For `task_type === 'new_instance'`, if `task.payload` contains an explicit override JSON:

1. Parse the payload into `{ executor, executor_model }`
2. Validate using shared helpers
3. If invalid, publish a normal rejection result
4. If valid, call `EnrichmentService.enrich()` as today, then override:

```ts
job.executors = [{ executor, executor_model }];
job.skipContinue = true;
```

This explicit pair becomes the thread's new effective executor/model once the task completes and the bot reply is posted.

#### Bare `/new`

For `task_type === 'new_instance'` with empty payload:

- if `threadResult.inheritedExecutor` + `threadResult.inheritedExecutorModel` exist, override `job.executors` to that single pair
- otherwise keep the configured `new_instance` rule from enrichment config

`skipContinue: true` remains unchanged.

#### Ordinary thread messages

For any non-control task in a Lark thread:

- enrich the task normally based on effective `task_type`
- if an inherited executor/model pair exists, replace `job.executors` with exactly that one pair
- if no inherited pair exists, keep the enriched executor list from config

This means:

- plain messages inherit the pair
- `/task <type> ...` messages also inherit the pair
- only explicit `/new <executor> <model>` changes the pair today

### 8.9 No fallback behind thread-selected executor/model

When a task inherits a thread-selected pair, the executor list becomes:

```ts
[{ executor: inheritedExecutor, executor_model: inheritedExecutorModel }]
```

This intentionally discards the YAML rule's fallback array for that task.

Reason:

- user-selected thread state should be deterministic
- the user explicitly chose an executor/model pair
- the requested behavior is "try only that exact chosen pair"

### 8.10 Relationship to existing `/new` fencing

The current `/new` fence behavior remains:

- `ThreadContextFetcher` still truncates visible conversational history at the last successful `/new` boundary
- executor/model lookup still scans backward for the most recent valid pair

That asymmetry is intentional:

- conversation history should only include post-reset messages
- executor/model should persist as thread state until explicitly changed

In practice, because successful replies now always echo executor/model, the most recent valid pair will usually also be post-fence.

## 9. Data Flow

### 9.1 Explicit selection

```text
User sends: /new cursor_agent gpt-5.4-medium-fast
        |
        v
lark-listener
  -> task_type: new_instance
  -> payload: {"executor":"cursor_agent","executor_model":"gpt-5.4-medium-fast"}
        |
        v
enrichment-poller
  -> validate explicit pair
  -> override job.executors to that one pair
  -> set skipContinue: true
        |
        v
task-daemon
  -> runs cursor_agent / gpt-5.4-medium-fast
  -> annotates result with executor + executor_model
        |
        v
lark-result
  -> reply starts with:
     executor: cursor_agent
     model: gpt-5.4-medium-fast
```

### 9.2 Bare `/new`

```text
User sends: /new
        |
        v
thread-context-fetcher
  -> scan backward for most recent valid executor/model in bot replies
        |
        +-> found pair -> use exactly that pair
        |
        +-> not found -> keep new_instance rule from enrichment config
```

### 9.3 Ordinary follow-up message

```text
User replies in thread: "fix tests"
        |
        v
thread-context-fetcher
  -> inheritedTaskType from thread metadata
  -> inheritedSessionId from thread metadata
  -> inheritedExecutor/model from most recent valid bot reply
  -> strip metadata lines from threadContext
        |
        v
enrichment-poller
  -> apply task_type inheritance as today
  -> enrich with rule for task_type
  -> replace job.executors with inherited single pair
        |
        v
task-daemon executes exactly that pair
```

## 10. File Changes

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Add optional `executor` / `executor_model` to `TaskResultSubmission` and `TaskResult` |
| `packages/daemon/lark-listener/src/message-handler.ts` | Modify | Accept `/new <executor> <model>` syntax and encode explicit override into task payload |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Modify | Add parsing tests for bare `/new`, explicit `/new`, and invalid arities |
| `packages/api/src/routes/results.ts` | Modify | Accept and validate optional `executor` / `executor_model` on results |
| `packages/api/src/__tests__/routes/results.test.ts` | Modify | Verify result-route validation and passthrough for executor metadata |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Modify | Annotate returned result with the actual executor/model used for the final attempt |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Modify | Verify result annotation uses the selected executor/model |
| `packages/daemon/task/src/task-poller.ts` | Modify | Preserve executor metadata when posting results |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Modify | Verify executor/model is forwarded with task results |
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` (`@local-agent/lark-result-daemon`) | Modify | Prepend visible `executor:` / `model:` lines to Lark replies |
| `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts` | Modify | Verify reply format includes executor/model lines when present |
| `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Modify | Extract inherited executor/model from latest valid bot reply and strip lines from thread context |
| `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts` | Modify | Add extraction, validation, reverse-scan, and stripping tests |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Modify | Apply explicit `/new` override, bare `/new` inheritance, and ordinary thread executor inheritance |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Modify | Verify executor inheritance and explicit override behavior |

## 11. Testing Strategy

### 11.1 Parser and command handling

- `/new` submits `new_instance` with empty payload
- `/new cursor_agent gpt-5.4-medium-fast` submits `new_instance` with structured payload
- `/new cursor_agent` is rejected with usage hint
- `/new cursor_agent gpt-5.4-medium-fast extra` is rejected with usage hint
- `/newfoo` is not treated as `/new`

### 11.2 Thread context extraction

- extracts the most recent valid executor/model pair from bot replies
- trims whitespace on captured executor and model before validation
- ignores user-authored `executor:` / `model:` lines
- ignores malformed or cross-invalid pairs
- requires both lines in the same message
- strips `executor:` and `model:` lines from thread context
- preserves current `/new` fence behavior

### 11.3 Enrichment behavior

- bare `/new` inherits the latest valid executor/model when present
- bare `/new` falls back to config when no valid pair exists
- explicit `/new <executor> <model>` overrides config with a single-entry executor list
- explicit invalid pair is rejected by shared validation path
- ordinary thread messages inherit the single selected pair
- `/task <type> ...` still inherits executor/model while changing task type
- `/gc` and `/end` ignore inherited executor/model

### 11.4 Result propagation

- orchestrator annotates final result with actual executor/model
- task poller preserves that metadata when posting results
- results API accepts valid pairs and rejects invalid partial metadata
- Lark replies visibly include executor/model when present

## 12. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Thread metadata extraction becomes more complex | Keep all parsing inside `ThreadContextFetcher` with focused tests |
| Visible metadata lines clutter replies | Strip them from executor history so only user-visible output changes |
| Old threads without executor/model markers behave inconsistently | Fallback to enrichment config when no valid pair is found |
| Explicit `/new` payload encoding in `Task.payload` is ad hoc | Limit it to `new_instance` and document the JSON contract clearly |
| Result-route validation could reject existing rejection results | Keep executor/model optional and require both only when one is present |

## 13. Acceptance Criteria

1. `/new` accepts either no args or exactly `<executor> <model>`.
2. `/new <executor>` and `/new <executor> <model> <extra>` are rejected locally.
3. Successful Lark replies visibly include `executor:` and `model:` when execution metadata exists.
4. `ThreadContextFetcher` extracts the most recent valid bot-authored executor/model pair.
5. `ThreadContextFetcher` strips executor/model lines from `threadContext`.
6. Bare `/new` inherits the latest valid pair, or falls back to enrichment config if none exists.
7. Ordinary thread messages inherit the thread-selected pair unless they explicitly change it.
8. The only explicit pair-changing command introduced by this feature is `/new <executor> <model>`.
9. Inherited or explicit thread-selected executor/model replaces the effective executor list with a single pair.
10. `/gc` and `/end` continue to ignore executor/model inheritance.
