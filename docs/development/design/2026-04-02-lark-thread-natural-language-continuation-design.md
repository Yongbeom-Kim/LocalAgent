# Design: Natural-Language Continuation in Lark Threads

> Authority note: repo-root `COMMANDS.md` is the authoritative external Lark command contract.
> This design doc explains rationale and implementation boundaries for thread reply behavior.

> This design updates the thread behavior described in `docs/development/design/2026-04-02-task-explicit-routing-contract-design.md` and `docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md`.

**Date:** 2026-04-02
**Status:** Ready for implementation
**Type:** Command contract refinement
**Packages:** `@local-agent/shared`, `@local-agent/lark-listener-daemon`, `@local-agent/task-enrichment-daemon`, `@local-agent/api`

## 1. Problem

The current Lark contract still makes threaded conversation feel like a fresh command submission flow.

Today:

- root messages are expected to use explicit `/task <type> <executor> <model> <payload>`
- plain thread replies are treated as natural-language continuation
- threaded `/task ...` messages are rejected in enrichment with a thread-specific help message

That is the opposite of the desired conversational model. In a Lark thread, users should be able to keep talking naturally and let the system continue the current task/session automatically.

## 2. Goal

Split Lark behavior into two modes:

- **root message mode:** outside a thread, `/task <type> <executor> <model> <payload>` is the only valid user entrypoint
- **thread continuation mode:** inside a thread, plain natural-language replies continue the existing conversation automatically, while `/new` and `/end` remain the only explicit control commands

More specifically:

- plain thread replies inherit the thread's `task_type`, `executor`, `executor_model`, and `session_id`
- `/task ...` is always invalid inside a thread
- bare `/new` in a thread starts a fresh instance using the inherited executor/model
- `/new <executor> <model>` in a thread starts a fresh instance and changes the thread's effective executor/model for later replies
- `/end` is valid only in a thread
- if thread state cannot be recovered cleanly, the message is rejected rather than silently starting a new session
- threaded non-text messages should be converted into a usable text or JSON payload when possible; otherwise they are rejected with a thread-specific help message

## 3. Non-goals

- No new database or persistence layer for thread state
- No new thread-only slash command beyond `/new` and `/end`
- No support for `/task` as an escape hatch inside threads
- No attempt to infer a new root task from plain text outside a thread
- No change to the visible reply-marker architecture for `task_type`, `session_id`, `executor`, and `model`
- No change to CLI behavior beyond staying aligned with the root `/task` contract

## 4. User Decisions Captured

- In a Lark thread, every plain natural-language reply should continue the current conversation.
- Thread replies inherit the thread's existing `task_type`, `executor`, `model`, and `session_id` with no user-visible syntax.
- `/task` is always invalid inside a thread.
- Outside a thread, root messages should keep the explicit `/task <type> <executor> <model> <payload>` contract.
- If thread metadata cannot be recovered cleanly, reject the reply instead of falling back to a new task or new session.
- For non-text replies inside a thread, attempt to convert them into text or JSON payload and continue; if conversion is not usable, reject.
- `/new <executor> <model>` is valid only in threads, not as a new root message.
- Bare `/new` remains valid in threads and inherits the current executor/model.
- `/end` remains thread-only and should be rejected outside a thread.
- Root plain text should return the usage hint to the user, even if the listener forwards it internally as a continuation candidate and enrichment performs the final rejection.
- Root `/new` should return an explicit thread-only message rather than the generic usage hint.
- When a threaded reply is rejected for shape/content, the message should explicitly say thread replies must be natural language, `/new`, or `/end`.

## 5. Current State

Relevant current behavior:

- `MessageHandler` only treats slash commands as runnable inputs and otherwise replies with the `/task` usage hint.
- `ThreadContextFetcher` already extracts inherited `task_type`, `session_id`, executor/model markers, and thread history.
- `EnrichmentPoller` is already the source of truth for thread-aware acceptance and rejection.
- `EnrichmentService` already validates root `/task` routing fields and already treats `new_instance` and `cleanup` specially.

The missing behavior is not executor/session inheritance itself. The missing behavior is an input contract that treats thread replies as continuations instead of fresh command submissions.

## 6. Approaches Considered

### Approach A - Listener-owned thread routing

Make `lark-listener` query thread state before submission and fully decide whether a message is root-only or thread-only.

**Pros**

- Earlier user feedback
- Fewer invalid tasks hit enrichment

**Cons**

- Duplicates thread-detection logic already owned by `ThreadContextFetcher`
- Pushes Lark API coupling deeper into the listener
- Conflicts with the desired layering where `/task` in a thread is rejected by enrichment

### Approach B - Syntax in listener, all thread authority in enrichment (recommended)

Keep `lark-listener` responsible only for syntax extraction and payload normalization. Keep `task-enrichment` as the sole source of truth for whether the message is in a thread and whether inherited thread state is recoverable.

**Pros**

- Preserves the existing layering
- Avoids duplicating any thread-membership logic in the listener
- Matches the requested behavior that threaded `/task` is rejected in enrichment
- Keeps the boundary cleaner: listener parses, enrichment decides thread semantics

**Cons**

- Root plain text and root non-text will be forwarded and rejected one step later
- Some root thread-only commands also reach enrichment before rejection

### Approach C - Persist separate thread mode/state

Add dedicated storage for thread mode and thread-selected routing.

**Pros**

- Strongly structured state

**Cons**

- Unnecessary infrastructure for a problem already solved by visible reply metadata
- Larger scope than requested

## 7. Recommendation

Adopt **Approach B**.

The repo already centralizes thread authority in `ThreadContextFetcher` and `EnrichmentPoller`. Extending that model to all root/thread decisions is cleaner than splitting membership checks across two daemons.

## 8. Proposed Design

### 8.1 Public Lark contract

#### Root messages

Outside a thread, the only valid user command is:

- `/task <type> <executor> <model> <payload>`

Root behavior:

- plain text root messages are rejected with the `/task` usage hint
- non-text root messages are rejected with the same `/task` usage hint
- `/new`
- `/new <executor> <model>`
- `/end`
  are rejected as invalid root commands for the Lark workflow
- `/gc` remains valid as a root control command

Thread-specific rejections should be explicit where helpful:

- root `/new` and root `/end` should say they are thread-only commands

#### Thread replies

Inside a thread, valid inputs are:

- plain natural-language text
- non-text messages that can be converted into usable text or JSON payload
- `/new`
- `/new <executor> <model>`
- `/end`

Invalid thread input:

- `/task ...`
- malformed `/new ...`
- non-text replies that cannot be converted into a usable payload

The thread help message should be explicit:

```text
Thread replies must be natural language, /new, or /end.
```

When the rejection is specifically about `/task` in a thread, the message should add the root guidance:

```text
Cannot use /task in a thread. Reply with natural language, /new, or /end.
Use /task only as a new root message.
```

### 8.2 Listener parsing and submission model

`MessageHandler` should stop treating every plain text message as immediately invalid. Instead it should classify each incoming message syntactically and forward anything that may be a valid thread continuation.

1. **Explicit root-capable task**
   - Parsed from `/task <type> <executor> <model> <payload>`
   - Submitted with explicit `task_type`, `executor`, `executor_model`, and `payload`

2. **Thread continuation candidate**
   - Parsed from plain natural-language text
   - Parsed from a non-text message that can be normalized into usable text or JSON
   - Submitted as an internal placeholder task type with no explicit routing

3. **Thread control task**
   - `/new`
   - `/new <executor> <model>`
   - `/end`

4. **Immediate local usage rejection**
   - malformed `/task`
   - malformed `/new`

This means:

- plain text messages are submitted as continuation candidates rather than locally rejected
- normalized non-text messages are submitted as continuation candidates rather than locally rejected
- `/new`, `/new <executor> <model>`, and `/end` are forwarded without listener-side thread checks
- only malformed command shapes are rejected locally

#### Internal placeholder task type

Introduce an internal Lark-only placeholder task type:

```ts
const THREAD_REPLY_TASK_TYPE = 'thread_reply';
```

This is not a user-facing task type. It exists only so the listener can submit continuation candidates without pretending they are root `/task` submissions.

Why a dedicated placeholder instead of reusing `generic`:

- it avoids reintroducing `generic` as a user-visible routing concept
- it makes the continuation path explicit in enrichment and tests
- it preserves the explicit root `/task` contract while still allowing non-command thread replies

Continuation candidates are submitted as:

```ts
{
  task_type: 'thread_reply',
  payload: '<normalized text or JSON>',
  task_source: { source: 'lark', message_id },
}
```

### 8.3 Non-text conversion contract

For thread replies, non-text content should be normalized on a best-effort basis.

Recommended behavior:

- if `extractLarkMessageContent(msgType, content)` returns a meaningful human-readable string, use it as the payload
- otherwise, if `content` is valid JSON, wrap it into a compact structured payload such as:

```json
{"lark_message_type":"image","content":{"image_key":"img_v3_abc"}}
```

- otherwise reject with the thread help message

Root non-text messages may still be normalized and forwarded as continuation candidates. If enrichment later determines the message is not in a thread, it rejects them with the root `/task` usage hint.

### 8.4 Thread lookup must become tri-state

`ThreadContextFetcher.fetchThreadContext()` currently returns `null` for both:

- "this message is not in a thread"
- "the fetch failed after retries"

That is no longer sufficient because the new contract requires rejection on metadata recovery failure instead of silent fallback.

Replace the return shape with an explicit result union:

```ts
type ThreadLookupResult =
  | { kind: 'not_thread' }
  | {
      kind: 'thread';
      threadContext: string | null;
      inheritedTaskType: string | null;
      inheritedSessionId: string | null;
      inheritedExecutor: TaskExecutorType | null;
      inheritedExecutorModel: string | null;
    }
  | { kind: 'error'; reason: string };
```

Behavior:

- if `getThreadId()` determines the message is a root message, return `{ kind: 'not_thread' }`
- if thread messages are fetched successfully, return `{ kind: 'thread', ... }`
- if any required Lark lookup fails after retries, return `{ kind: 'error', reason }`

This lets enrichment distinguish "root message" from "cannot safely determine thread state".

### 8.5 Metadata requirements for thread continuation

For a `thread_reply` task to continue successfully, the thread lookup must provide all routing state required to reconstruct the active conversation:

- `inheritedTaskType`
- `inheritedSessionId`
- `inheritedExecutor`
- `inheritedExecutorModel`

If any of those are missing, reject the reply. Do not fall back to a fresh session, config-selected executor list, or placeholder task type.

Suggested rejection message:

```text
Unable to continue this thread because its task metadata is incomplete.
Start a new root message with /task, or use a thread that already has task state.
```

`threadContext` itself may still be `null` and should not block continuation. A thread may be valid even when there is no retained history segment after filtering or `/new` fencing.

### 8.6 EnrichmentPoller behavior matrix

`EnrichmentPoller` remains the authority for all root/thread behavior.

#### When thread lookup returns `not_thread`

- explicit `/task ...` proceeds normally
- `thread_reply` is rejected with the root `/task` usage hint
- `/new` and `/new <executor> <model>` are rejected with a thread-only message
- `/end` is rejected with a thread-only message
- `/gc` proceeds as the existing root control command

#### When thread lookup returns `thread`

- `thread_reply` inherits `task_type`, `session_id`, `executor`, and `executor_model` from thread metadata, then proceeds as a normal enriched task
- explicit `/task ...` is rejected with the thread-specific `/task` message
- bare `/new` inherits the current executor/model as already designed
- `/new <executor> <model>` overrides the executor/model for the new instance and becomes the thread's next visible pair after success
- `/end` continues to use inherited `session_id` and cleanup behavior
- `/gc` is rejected in-thread, unchanged

#### When thread lookup returns `error`

- reject the Lark message instead of guessing whether it was root or threaded
- do not generate a new session id
- do not fall back to enrichment config

Suggested message:

```text
Unable to determine thread state for this Lark message. Please retry.
```

This is intentionally conservative. Once thread-continuation semantics exist, guessing wrong is worse than rejecting.

### 8.7 EnrichmentService responsibilities

`EnrichmentService` should continue to own semantic validation of explicit routing pairs.

Behavior after this design:

- root `/task` still requires valid `task_type`, `executor`, `executor_model`, and non-empty payload
- `thread_reply` should never reach `EnrichmentService` unresolved; `EnrichmentPoller` must rewrite it to the inherited task type first
- `new_instance` keeps its existing explicit-pair validation rules
- `cleanup` keeps its builtin executor behavior

This keeps the continuation rewrite logic in the poller, where thread context already exists.

### 8.8 Shared/API contract implications

The API should remain permissive enough to accept the internal `thread_reply` placeholder from `lark-listener`.

That means the system must not treat every non-control task without executor/model as an API error, because `thread_reply` is an intentional intermediate shape.

The stricter user-facing contract still holds at the product level:

- users may only create root tasks through `/task`
- only Lark continuation candidates use `thread_reply`
- enrichment either rewrites `thread_reply` into an inherited routed task or rejects it

If desired, `thread_reply` can be documented as an internal-only pseudo-control task in shared constants to make this exception explicit.

### 8.9 Impact on earlier specs

This design refines two recent specs.

#### Update to explicit `/task` routing contract

The root-message contract remains unchanged.

What changes is the thread contract:

- earlier spec: threaded `/task` is rejected and plain thread messages are rejected too
- new spec: threaded `/task` is rejected, but plain thread replies become the normal continuation path

#### Update to `/new` inheritance contract

The inheritance rules for bare `/new` and explicit `/new <executor> <model>` remain intact.

What changes is command scope:

- `/new` and `/new <executor> <model>` become thread-only Lark commands
- root `/new` is rejected instead of being treated as a valid Lark root entrypoint

## 9. Files Changed

| File | Change |
|------|--------|
| `packages/shared/src/types.ts` | Add `THREAD_REPLY_TASK_TYPE` or equivalent internal-task marker if shared constants are preferred |
| `packages/shared/src/routing-errors.ts` | Add thread-specific help/rejection text constants/helpers |
| `packages/daemon/lark-listener/src/message-handler.ts` | Parse thread continuation candidates, normalize non-text replies, and submit `thread_reply` placeholders |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Cover continuation submission, non-text normalization, and malformed local command rejection |
| `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Return tri-state thread lookup result instead of conflating root and fetch failure |
| `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts` | Cover `not_thread`, `thread`, and `error` outcomes |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Rewrite `thread_reply` using inherited metadata, reject root/thread-only misuse, and reject lookup errors conservatively |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Cover thread continuation success, incomplete metadata rejection, root rejection, and explicit thread-only command messages |

## 10. Acceptance Criteria

1. A root Lark message must use `/task <type> <executor> <model> <payload>` to create work.
2. A root plain-text or root non-text Lark message is rejected with the `/task` usage hint and does not produce a runnable job.
3. A plain text reply inside a thread continues the inherited task/session without requiring `/task`.
4. A threaded non-text reply is continued when it can be converted into usable text or JSON payload.
5. A threaded non-text reply that cannot be converted is rejected with the thread help message.
6. `/task ...` inside a thread is rejected in enrichment with a message telling the user to reply with natural language, `/new`, or `/end`.
7. Bare `/new` in a thread inherits the thread executor/model.
8. `/new <executor> <model>` is valid only in a thread and updates the thread's effective executor/model on success.
9. Root `/new` and root `/end` are rejected as thread-only commands.
10. If thread lookup or metadata recovery fails, the system rejects the message and does not create a fresh session as fallback.
