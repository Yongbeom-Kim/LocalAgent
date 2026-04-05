# Design: Thin Lark Listener, Enrichment-Owned Semantics

**Date:** 2026-04-05
**Status:** Proposed
**Type:** Architecture refactor
**Packages:** `@local-agent/lark-listener-daemon`, `@local-agent/task-enrichment-daemon`, `@local-agent/shared`, `@local-agent/lark-result-daemon`

## 1. Problem

The current `lark-listener` is no longer a thin ingress adapter.

Today it owns too many responsibilities on the hot path:

- Lark command parsing and local rejection
- user-visible usage/help replies
- thread/session metadata lookup via extra Lark API calls
- authoritative SQLite writes for inbound messages and thread state
- queue submission and success reaction

That creates the wrong boundary for an ingress daemon. A listener that should only adapt Lark traffic into the internal pipeline can now reject messages before enqueue, fail closed on SQLite or metadata lookup problems, and create synthetic thread state before downstream policy has decided what the message means.

The desired boundary is stricter:

- the listener should remain responsible for Lark-specific normalization, including rich-text and message-type decoding
- the listener should not decide whether a message is valid for the LocalAgent workflow
- enrichment should be the source of truth for command semantics, thread recovery, rejection behavior, and authoritative SQLite state

## 2. Goals

1. Make `lark-listener` a thin wrapper around the Lark API.
2. Ensure the listener never rejects a message for workflow-policy reasons.
3. Move command parsing, root/thread semantics, and authoritative SQLite ownership into `task-enrichment`.
4. Preserve the current external Lark command contract in `COMMANDS.md`.
5. Keep Lark-specific normalization in the listener so downstream code does not depend on the full vendor event schema.

## 3. Non-goals

- No redesign of the overall task/job/result pipeline.
- No change to the external command surface in `COMMANDS.md`.
- No attempt to introduce a new cross-platform chat envelope abstraction beyond what this refactor needs.
- No removal of the current best-effort success reaction from the listener.
- No Lark metadata fetches in enrichment; if root/thread identifiers are needed, the listener should resolve them and include them in the normalized envelope.

## 4. User Decisions Captured

- Refactor scope is limited to the Lark listener and enrichment boundary, not a full Lark stack rewrite.
- The listener should remain responsible for Lark-specific decoding such as rich text normalization.
- The listener should emit a smaller normalized Lark envelope, not the raw vendor event.
- The listener should do only the enqueue API call on the hot path; if enqueue fails, it may emit an immediate enqueue-failure message.
- The listener should keep emitting the best-effort `OnIt` reaction on successful enqueue.
- The listener may perform the narrow Lark metadata lookup needed to resolve root/thread identifiers for the normalized envelope.
- Enrichment should own authoritative SQLite persistence.
- Enrichment should preserve the current external command contract and rejection behavior.
- Messages that cannot be sensibly normalized should be rejected downstream, not silently forwarded as unusable payloads.
- Enrichment should rely on the listener envelope rather than making extra Lark metadata fetches.

## 5. Current State Summary

### Listener

`packages/daemon/lark-listener/src/message-handler.ts` currently:

- extracts text or normalized content
- fetches thread metadata from Lark
- queries and updates SQLite thread/message history
- parses `/task`, `/new`, `/status`, `/end`, and `/gc`
- sends local usage replies for malformed inputs
- submits tasks
- reacts with `OnIt`

### Enrichment

`packages/daemon/task-enrichment/src/enrichment-poller.ts` currently already owns:

- root vs thread policy enforcement
- thread recovery through `ThreadContextFetcher`
- control-task routing and rejection
- final rejection publication through `/results`

The refactor is therefore a boundary correction, not a new subsystem.

## 6. Approaches Considered

### Approach A: Keep current listener parsing, move only SQLite writes downstream

The listener would continue parsing commands and generating local usage replies, but SQLite ownership would move to enrichment.

**Pros**

- Smaller implementation delta
- Less test churn in the listener

**Cons**

- Listener still rejects messages locally
- Workflow semantics remain split between listener and enrichment
- Thin-wrapper goal is not met

### Approach B: Listener emits a normalized Lark envelope; enrichment owns all workflow semantics (recommended)

The listener would normalize the Lark event into a smaller internal envelope, enqueue it, and react on success. Enrichment would parse commands, decide root/thread behavior, persist inbound audit rows, and update authoritative thread/session state.

**Pros**

- Matches the desired boundary exactly
- Keeps Lark-specific decoding isolated to the adapter layer
- Removes SQLite and policy dependencies from ingress
- Preserves a stable internal contract without exposing the full Lark schema downstream

**Cons**

- Requires coordinated changes to task submission, enrichment parsing, and tests
- Moves some currently local failure paths into downstream async handling

### Approach C: Listener forwards the raw Lark event; enrichment does everything else

The listener would become nearly transparent and send the full raw Lark event body to the queue.

**Pros**

- Simplest listener implementation
- Lowest transformation cost at ingress

**Cons**

- Enrichment becomes tightly coupled to vendor event shape
- Rich-text and content normalization logic leaks downstream
- Internal contracts become harder to evolve and test

## 7. Recommendation

Adopt **Approach B**.

This gives the cleanest architectural boundary:

- listener owns Lark adaptation
- enrichment owns workflow semantics
- result routing remains responsible for delivering downstream outcomes back to Lark

It is the smallest change that fully satisfies the thin-wrapper requirement without pushing the full Lark schema into enrichment.

Important nuance: the listener is still allowed to do a narrow Lark metadata lookup when the websocket event itself does not contain enough root/thread identifiers. That lookup remains adapter work, not workflow-policy work.

## 8. Proposed Architecture

### 8.1 Responsibility split

#### `lark-listener`

Owns only:

- receiving `im.message.receive_v1` events
- deduplicating repeated message delivery
- normalizing vendor-specific content into a stable internal Lark envelope
- resolving root/thread identifiers from the event or, if needed, a narrow Lark metadata lookup
- submitting the envelope to `POST /tasks`
- sending a best-effort enqueue-failure reply if the API call fails
- sending a best-effort `OnIt` reaction after successful enqueue

Does not own:

- command grammar parsing
- root/thread policy
- authoritative SQLite writes
- thread/session recovery policy beyond attaching resolved identifiers into the envelope
- usage/help replies for malformed commands

#### `task-enrichment`

Owns:

- parsing commands from the normalized envelope
- deciding root vs thread semantics
- rejecting malformed or context-invalid messages
- persisting inbound Lark audit/history rows in SQLite
- mutating authoritative thread/session state in SQLite
- deriving thread context from SQLite
- publishing rejection or status results into the normal results pipeline

### 8.2 Normalized Lark envelope

The listener should submit a single internal task type for all inbound Lark messages.

Recommended task shape:

```json
{
  "task_type": "lark_inbound",
  "payload": "<JSON stringified normalized envelope>",
  "task_source": {
    "source": "lark",
    "message_id": "om_xxx"
  }
}
```

Recommended normalized payload schema:

```json
{
  "platform": "lark",
  "schema_version": 1,
  "message_id": "om_xxx",
  "root_message_id": "om_root",
  "thread_id": "omt_xxx",
  "chat_type": "p2p",
  "sender_open_id": "ou_xxx",
  "sender_type": "user",
  "message_type": "text",
  "raw_content": "{\"text\":\"hello\"}",
  "normalized_text": "hello",
  "mentions": [],
  "is_normalizable": true,
  "occurred_at_ms": 1743811200000
}
```

Notes:

- `normalized_text` is the listener’s best-effort human-usable representation.
- `raw_content` preserves the original Lark content body for audit/debugging.
- `is_normalizable` distinguishes usable payloads from message types that enrichment must reject.
- `root_message_id` and `thread_id` are adapter-resolved identifiers, not workflow decisions.
- `root_message_id` is **required** for all envelopes. For a root message, set `root_message_id = message_id`.
- `thread_id` is **nullable**. If Lark does not provide a thread identifier for a root message, set `thread_id = null`.
- The listener does not include session identity in this envelope.

Required/optional summary (v1):

- Required: `platform`, `schema_version`, `message_id`, `root_message_id`, `chat_type`, `sender_open_id`, `sender_type`, `message_type`, `raw_content`, `mentions`, `is_normalizable`, `occurred_at_ms`
- Conditionally required: `normalized_text` must be present when `is_normalizable = true`
- Optional: `thread_id` (null for non-threaded/root messages)

### 8.3 Message normalization rules

The listener remains the Lark adapter and should normalize vendor content as follows:

- `text`: extract plain text
- `post`: flatten rich text into readable normalized text
- `image`, `file`, `audio`, and other known message types: produce the same current best-effort normalized text when meaningful
- if a message type cannot be sensibly normalized, set `is_normalizable: false`, keep `raw_content`, and do not reject locally

This keeps Lark-specific content handling out of enrichment while preserving the ability for enrichment to reject unusable messages consistently.

### 8.4 Listener success and failure behavior

#### Success path

1. Receive event.
2. Dedup by `message_id`.
3. Resolve root/thread identifiers from the event or Lark metadata API if needed.
4. Normalize into the internal Lark envelope.
5. Submit to `POST /tasks` as `task_type: 'lark_inbound'`.
6. On success, add `OnIt` reaction best-effort.

Important behavioral note:

- `OnIt` is an **ingress ack** meaning “enqueued successfully”, not “validated/accepted by enrichment”. After this refactor it may appear even for messages that are later rejected downstream (for example malformed `/task`). This is considered an acceptable implementation-level difference.

#### Failure path

If queue submission fails after retries:

- do not attempt policy-specific parsing or classification
- send a single best-effort enqueue-failure reply such as a generic temporary failure message
- log the failure with message metadata

This is the only user-visible failure the listener should own, because it is the only failure local to the ingress boundary.

### 8.5 Enrichment parsing model

`task-enrichment` should add a first-stage parser for `task_type: 'lark_inbound'`.

That parser should:

1. Decode the normalized envelope.
2. Persist the inbound message as raw Lark history/audit data (without mutating thread/session state).
3. Determine whether the source message is root or thread primarily using envelope-provided identity:

- root message: `message_id === root_message_id`
- thread reply: `message_id !== root_message_id`

If needed, consult SQLite thread state for the referenced `root_message_id` to determine whether a thread is active/known.
4. Parse workflow commands from `normalized_text`.
5. Apply the current command contract from `COMMANDS.md`.
6. Update authoritative thread/session state only after classification succeeds.
7. Continue with existing enrichment behavior for accepted work.
8. Publish failure results for rejected work.

Integration with existing `ThreadContextFetcher`:

- The existing `ThreadContextFetcher` relies on SQLite history. Because the listener will no longer persist inbound messages, the `lark_inbound` handler must persist the inbound row before attempting any thread-context fetch.
- `enrichment-poller` must special-case `task_type: 'lark_inbound'` so it does not run the current thread preflight (which reads from SQLite) before the inbound message has been persisted.

Output mapping:

- Accepted `lark_inbound` tasks are translated into a normal `JobSubmission` with `job.task_type` set to the derived workflow task type (for example `gc`, `status`, `cleanup`, or an executor-backed task type for `/task ...`).
- Rejected `lark_inbound` tasks publish a failure/help `TaskResult` (via the existing results pipeline), with `task_source` preserved so the reply lands in the correct Lark thread.

Idempotency requirement:

- Enrichment must treat `message_id` as an idempotency key when persisting inbound messages. Duplicate deliveries (including listener restarts) must not create duplicate inbound rows or double-advance thread state.

### 8.6 SQLite ownership model

SQLite moves from listener-owned hot-path dependency to enrichment-owned authoritative state.

#### Inbound audit persistence

Enrichment should persist every inbound Lark message that successfully reaches it, including:

- normalized message fields
- raw content
- sender metadata
- message type
- envelope metadata needed for future thread recovery

This preserves audit/history even for malformed or rejected inputs.

Constraint:

- Inbound audit persistence must not create or advance authoritative thread/session state. Thread/session state is updated only after classification succeeds.

To support idempotency, inbound persistence should be implemented as one of:

- a unique constraint on `(platform, message_id)` plus an insert-or-ignore/upsert strategy, or
- an explicit existence check keyed by `message_id` before insert.

#### Authoritative thread state

Enrichment should update thread/session state only after it has determined the meaning of the message.

Examples:

- rejected root `/task foo` should record the inbound message but should not create an active thread state row
- accepted root `/task ...` should create or update the thread state row
- accepted thread natural-language continuation should update thread timestamps but not invent new routing defaults
- accepted `/new` and `/end` should mutate state exactly where the workflow semantics already live

This prevents synthetic active thread state from being created by ingress.

### 8.7 Thread recovery model

The current metadata lookup should remain in the listener, but only as adapter support for envelope construction.

Enrichment should recover thread/root state using:

- the inbound envelope fields `message_id`, `root_message_id`, and `thread_id`
- previously persisted inbound/outbound Lark rows in SQLite
- the existing thread-context fetcher and thread-state repository functions, updated as needed for the new `lark_inbound` flow

Constraint captured from the user:

- enrichment should not make Lark API metadata fetches for this flow

This means the listener-owned normalized envelope must contain enough resolved message identity information to recover root/thread relationships using internal state alone.

If the listener cannot build a minimally valid envelope (for example missing `message_id` or `raw_content`), it must treat the event as an adapter failure and follow the enqueue-failure path (do not enqueue).

If thread metadata resolution fails, it is acceptable for the listener to fall back to `root_message_id = message_id` and `thread_id = null`.

### 8.8 External contract preservation

`COMMANDS.md` remains authoritative and should not change semantically.

Preserved behavior:

- root `/task <type> <executor> <model> <payload>` remains the only root task-creation entrypoint
- thread natural-language replies remain continuation candidates
- `/new`, `/status`, and `/end` remain thread-only
- `/gc` remains root-only
- malformed command shape still produces the same usage/help behavior
- context-invalid commands are still rejected the same way

Acceptable implementation-level differences:

- replies may be emitted by enrichment/result routing instead of the listener
- reply timing may shift slightly because validation is no longer synchronous in ingress
- enqueue-failure replies become explicitly listener-owned and generic
- `OnIt` may be emitted for messages that are later rejected downstream, because it only indicates successful enqueue

### 8.9 Result routing impact

No architectural redesign is needed for `lark-result`.

It should continue to deliver results published by enrichment or execution. The main impact is that more Lark-visible failure/help messages now originate from enrichment-issued failure results rather than direct listener replies.

The existing notifier path already supports emitting text replies for failures and can remain the transport for those downstream responses.

## 9. File and Module Impact

### Listener package

- `packages/daemon/lark-listener/src/index.ts`: remove SQLite bootstrapping and repository wiring; retain only metadata resolver wiring needed for envelope identity resolution
- `packages/daemon/lark-listener/src/message-handler.ts`: replace command parser flow with envelope normalization and submission only; keep narrow metadata resolution for root/thread identifiers; keep dedup and success reaction; keep enqueue-failure reply only
- `packages/daemon/lark-listener/src/adapters/task-submitter.ts`: submit `lark_inbound` tasks with JSON payloads
- `packages/daemon/lark-listener/src/adapters/lark-reactor.ts`: unchanged in role
- `packages/daemon/lark-listener/src/adapters/lark-replier.ts`: narrowed to generic enqueue-failure replies only
- `packages/daemon/lark-listener/src/adapters/lark-message-metadata-resolver.ts`: retain and narrow for envelope identity resolution only

### Enrichment package

- `packages/daemon/task-enrichment/src/enrichment-poller.ts`: add `lark_inbound` entrypoint parsing; move listener command semantics here; persist inbound audit data here; update authoritative thread state here
- `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`: adapt to the new persisted inbound message flow; rely on internal SQLite relationships rather than listener-resolved metadata

### Shared package

- `packages/shared/src/types.ts`: add internal `lark_inbound` task type support if needed; add normalized envelope types
- `packages/shared/src/db/lark-history-repository.ts`: split inbound message persistence from thread-state mutation more explicitly; add helpers needed by enrichment-owned persistence/classification
- `packages/shared/src/lark-content.ts`: may need to expose richer normalization helpers for the listener envelope builder

### Documentation

- `COMMANDS.md`: likely unchanged semantically; update only if wording must clarify unchanged behavior
- `docs/development/design/*`: add this design as the new architectural authority for listener/enrichment ownership

## 10. Failure and Edge Cases

### Enqueue failure

- listener logs the failure
- listener sends a generic enqueue-failure reply
- no `OnIt` reaction is sent
- no SQLite mutation occurs because SQLite is downstream-owned

### Non-normalizable inbound message

- listener still enqueues the normalized envelope with `is_normalizable: false`
- enrichment records the raw inbound message
- enrichment rejects it with the same thread/root help path appropriate to context

### Duplicate delivery

- listener dedup remains the first protection against WebSocket replay
- downstream logic must be idempotent for persisted inbound message IDs (at minimum for inbound audit persistence and thread-state mutation)
- if listener thread metadata resolution fails, it may fall back to `root_message_id = message_id` and `thread_id = null`. This may reduce downstream thread-recovery accuracy for that message, but keeps ingress best-effort and avoids introducing Lark API calls in enrichment.

### Missing thread state for a thread reply

- enrichment rejects it using the existing thread recovery failure behavior
- no synthetic new session is created

## 11. Testing Strategy

### Listener tests

- submits every inbound message as `lark_inbound`
- never locally rejects malformed `/task`, `/new`, `/status`, or `/end`
- resolves root/thread identifiers into the envelope
- sends enqueue-failure reply only when `/tasks` submission fails
- still reacts on successful enqueue
- marks non-normalizable messages correctly in the envelope

### Enrichment tests

- parses commands from the normalized envelope
- preserves existing acceptance/rejection behavior from `COMMANDS.md`
- persists inbound audit messages before final rejection publication
- updates thread state only after accepted classification
- rejects non-normalizable root and thread messages through the correct downstream path

### Regression focus

- root malformed `/task` still produces the current usage reply
- threaded `/task ...` still produces the thread-specific rejection
- `/new`, `/status`, `/end`, and `/gc` keep their current contexts and rejection classes
- thread continuation still inherits the same state as before

## 12. Rollout Notes

This refactor should land as a single coordinated change across listener, enrichment, and shared types/repository helpers because the boundary changes are coupled.

To reduce risk:

- preserve the existing user-visible contract and test it explicitly
- keep the listener reaction path unchanged
- avoid introducing new network dependencies into enrichment
- keep migration scope narrow to the listener/enrichment boundary

## 13. Open Questions Resolved

- **Should the listener parse commands?** No. It should only emit normalized Lark envelopes.
- **Should the listener own SQLite writes?** No. SQLite becomes enrichment-owned authoritative state.
- **Should the listener keep the success reaction?** Yes.
- **Should enrichment re-fetch metadata from Lark?** No. The listener resolves and includes root/thread identifiers in the envelope.
- **Should the external contract change?** No.
