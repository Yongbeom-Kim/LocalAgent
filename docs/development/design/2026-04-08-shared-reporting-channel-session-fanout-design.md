# Design: Shared Reporting Channels with Root and Child Sessions

**Date:** 2026-04-08
**Status:** Ready for implementation planning
**Packages affected:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/migrator`, `packages/daemon/lark-listener`, `packages/daemon/telegram-inbound`, `packages/daemon/task-enrichment`, `packages/daemon/lark-result`, `packages/daemon/telegram-outbound`, `packages/daemon/task`, `packages/cli`

## 1. Problem

The current system still treats a Lark thread or Telegram topic as if it belongs to exactly one session.

Today:

- `lark_threads.session_id` and `telegram_threads.session_id` encode a `1 thread/topic -> 1 session` ownership model.
- `session_platform_links` allows only one `(platform, external_thread_key)` row globally, which prevents multiple sessions from attaching to the same reporting channel.
- thread context fetchers return a single inherited `session_id`, and enrichment assumes that any plain reply inside a thread should continue that single session.
- result delivery and cleanup logic delete state by the single session currently attached to the thread/topic.

That model blocks the planned feature where a root session can programmatically spawn child sessions that behave like normal sessions internally but report their phase updates and final results back into the same Lark thread or Telegram topic.

## 2. Goal

Change the data model and routing contracts so one reporting channel can own many sessions while preserving a single default root session for human interaction.

After this feature:

1. one Lark thread or Telegram topic is a shared reporting channel rather than an exclusive session owner;
2. each reporting channel has exactly one root session used for default human replies and inherited thread context;
3. additional child sessions can attach to that same reporting channel internally;
4. child sessions keep their own `session_id`, workspace, queue, lifecycle, and executor selection;
5. child session phase updates and final results are posted into the same reporting channel as the root session;
6. normal user replies in the shared thread/topic continue only the root session;
7. `/status` keeps its current user-visible semantics by resolving through the root session only;
8. `/end` on the shared thread/topic tears down the root session and every attached child session;
9. the CLI and internal enqueue contracts allow explicit targeting of a session while still specifying the reporting-channel context separately.

## 3. Non-Goals

- No user-facing command for choosing which child session to talk to.
- No user-facing syntax for attaching arbitrary new sessions to an existing thread/topic.
- No automatic child-session creation from plain thread replies.
- No introduction of a fully generic platform-agnostic `reporting_channels` table in V1.
- No change to the current FIFO execution and workspace semantics of individual sessions.
- No change to the meaning of `/status` for end users beyond the internal root-session resolution needed to preserve current behavior.

## 4. User Decisions Captured

- A Lark thread / Telegram topic becomes a pure reporting channel that can have many attached sessions.
- Each reporting channel still has one primary root session.
- Normal user replies always target only the root session; there is no user-facing target-session selection.
- Secondary sessions are out of scope from a user-creation perspective for now, but the internal contracts must support explicit target-session routing.
- Child sessions are normal sessions internally and only differ in being programmatically spawned and reporting into the root session's reporting channel.
- Child sessions always materialize explicit `session_platform_links` attachments for the reporting channels they report into.
- Child phase updates and final results always post into the same thread/topic as the root session.
- `/end` must delete all sessions attached to the reporting channel, not only the root session.
- The data model should track lineage with `parent_session_id` only; upward traversal can derive the root.
- `parent_session_id` is immutable after creation; reparenting is forbidden.
- Lineage must be acyclic; parent sessions must already exist before a child session is created.
- Normal human thread-context construction should use only root-session context, even if child outputs are visible in the same thread/topic.
- Message history rows should preserve the producing `session_id` rather than rewriting child output to the root session.
- Parent/context mismatches are rejected rather than silently corrected.
- Once `/end` starts for a reporting channel, that root enters a closing state and new child attachments are rejected.
- If the root reporting channel is bridged across Lark and Telegram, child sessions inherit the same reporting surfaces.
- Child sessions without any reporting-channel attachment are out of scope for this feature.
- Scope includes both Lark and Telegram data models, plus CLI contract changes.

## 5. Existing Context

### 5.1 Session identity is already the execution identity

Current implemented behavior:

- `sessions` is the canonical execution/workspace identity keyed by `session_id`.
- job queues are routed by `session_id`, and task execution serialization also happens by `session_id`.
- cleanup, GC, and workspace lifecycle all already operate in session terms.

That means child sessions should remain independent `session_id` rows rather than being collapsed into the root session.

### 5.2 Thread/topic ownership is still modeled as single-session ownership

Current implemented behavior:

- `lark_threads.session_id` and `telegram_threads.session_id` imply a thread/topic belongs to exactly one session.
- `session_platform_links` enforces `UNIQUE (platform, external_thread_key)`, which blocks multiple sessions from attaching to the same reporting channel.
- both Lark and Telegram inbound resolvers recover one `session_id` from the thread/topic and continue that session.

### 5.3 Prompt history and result persistence already use message tables

Current implemented behavior:

- `lark_messages` and `telegram_messages` already carry both a reporting-channel anchor and a `session_id`.
- prompt-history formatters strip metadata headers from outbound bot messages but do not distinguish root-session output from child-session output.
- result notifiers persist outbound rows with the task's `session_id` and currently mutate thread rows so the thread row itself keeps following whichever session most recently wrote into it.

Important caveat:

- Lark inbound persistence currently writes `lark_messages.session_id = root_message_id` in the audit path and does not reliably backfill it to the resolved root session id.
- Telegram persistence currently includes an update that can rewrite `telegram_messages.session_id` across a whole topic on thread upsert.

Both behaviors conflict with this design's requirement to (a) preserve the producing session id on message rows and (b) filter root-session prompt history by `session_id = root_session_id`.

That last behavior must change because the thread/topic row must remain rooted to the root session even when child sessions emit results into the same reporting channel.

## 6. Scope Assessment

This is one coherent subsystem.

It spans:

- shared schema and repositories,
- inbound resolution for Lark and Telegram,
- thread-context and prompt-history construction,
- result delivery and cleanup,
- internal task/job submission contracts,
- CLI submission surface.

Those all serve the same feature: one-to-many session attachment to a shared reporting channel.

## 7. Approaches Considered

### Approach A: Reinterpret existing thread/topic rows as reporting-channel roots and attach many sessions through links (recommended)

Keep the existing per-platform thread/topic tables, but redefine them as the canonical reporting-channel rows owned by the root session. Add session lineage in `sessions`, remove per-thread uniqueness from `session_platform_links`, and preserve per-message producing `session_id` in message tables.

**Pros**

- Minimal churn relative to the current schema and code organization.
- Preserves the already-correct meaning of `session_id` for execution, workspaces, and queues.
- Keeps Lark and Telegram largely symmetrical.
- Makes root-only human continuation and all-session cleanup explicit without introducing a new abstraction layer.

**Cons**

- Requires careful renaming and semantics changes across several repositories.
- Some existing helper names remain slightly thread-centric even though the model becomes reporting-channel-centric.

### Approach B: Add a new generic `reporting_channels` table and demote `lark_threads` / `telegram_threads` to projections

Introduce a new platform-agnostic reporting-channel table keyed independently from sessions, then link every session to it and let the platform-specific tables point at that row.

**Pros**

- Cleanest conceptual model.
- Future channel additions become easier.

**Cons**

- Much larger migration and implementation surface.
- Not necessary for the current feature scope.
- Forces the codebase to absorb a new abstraction before there is clear need.

### Approach C: Keep current schema mostly intact and fake multi-session reporting by rewriting child output into the root session

Leave thread rows single-session-owned and publish child output as if it belonged to the root session.

**Pros**

- Smallest schema change.
- Could make the UI look simple.

**Cons**

- Destroys provenance of which session produced which message.
- Makes future child-targeted context and cleanup fragile.
- Conflicts with the requirement that child sessions remain normal sessions internally.

## 8. Recommendation

Adopt **Approach A**.

It is the smallest change that preserves the existing meaning of `session_id` where it already works correctly and separates two concepts the current schema conflates:

- the reporting channel used for human-visible conversation and fan-out; and
- the session used for execution, workspaces, queues, and cleanup.

## 9. Design Overview

### 9.1 Core invariants

V1 codifies these invariants:

1. A reporting channel has exactly one root session.
2. A session belongs to at most one reporting channel per platform, but a reporting channel may have many attached sessions.
3. Root sessions have `parent_session_id = NULL`; child sessions reference their immediate parent session.
4. `parent_session_id` is write-once, parents must already exist, and lineage cycles are invalid.
5. A child session always materializes explicit reporting-channel attachments through `session_platform_links`.
6. Human replies in a shared reporting channel always resolve to the root session.
7. Child results and phase events route to the same reporting channel as the root session.
8. If the root reporting channel is bridged across Lark and Telegram, child sessions inherit the same bridged reporting surfaces.
9. Message history preserves the producing `session_id`; visible co-location in one thread/topic does not collapse all persisted rows to the root session.
10. Parent/context mismatches are rejected.
11. `/end` on a reporting channel transitions the root into a closing state and blocks new child attachments.
12. `/end` on a reporting channel ends and deletes the root session plus every descendant session attached to that reporting channel.

Child sessions still use the same execution model as ordinary sessions: their own queue, lock, workspace, and cleanup lifecycle.

### 9.2 High-level architecture

```text
Human reply in Lark/Telegram thread/topic
  -> inbound listener resolves reporting channel
  -> reporting channel row yields root session
  -> enrichment continues only the root session

Programmatic child task creation
  -> caller provides explicit target session_id
  -> caller also provides reporting-channel context
  -> child job executes on its own session queue/workspace
  -> phase + terminal results resolve reporting channel from link rows
  -> notifier posts into the same thread/topic as root session

/end in shared reporting channel
  -> resolve root session from reporting channel row
  -> enumerate attached descendant sessions
  -> clean up workspaces + DB rows + links + bridges for all attached sessions
```

## 10. Schema Changes

### 10.1 `sessions`

Add session lineage directly to the canonical session table.

Recommended changes:

- add `parent_session_id TEXT NULL`;
- add self-referencing foreign key to `sessions.session_id`;
- add index on `parent_session_id` for descendant traversal.

Semantics:

- `NULL` means root session;
- non-`NULL` means immediate parent session;
- `parent_session_id` is immutable after insert;
- the referenced parent session must already exist;
- cycles are invalid and must be rejected by application logic before persistence;
- root traversal remains application logic; no `root_session_id` field is stored in V1.

### 10.2 `lark_threads`

This table becomes the canonical Lark reporting-channel row.

Recommended changes:

- rename `session_id` to `root_session_id`;
- keep one row per `root_message_id`;
- keep task/executor/model/status fields as the root-session default metadata for human continuation;
- keep `thread_id`, `source`, `chat_type`, timestamps.

This row must no longer be overwritten to whichever child session most recently posted into the thread.

### 10.3 `telegram_threads`

This table becomes the canonical Telegram reporting-channel row.

Recommended changes:

- rename `session_id` to `root_session_id`;
- keep primary key `(chat_id, topic_id)`;
- keep task/executor/model/status fields as root-session metadata;
- keep `seed_message_id`, `status_message_id`, timestamps, metadata.

### 10.4 `session_platform_links`

This becomes the attachment table between any session and a reporting channel on a given platform.

Recommended changes:

- keep primary key `(session_id, platform)`;
- keep `external_thread_key`;
- **drop** `UNIQUE (platform, external_thread_key)`;
- add non-unique index on `(platform, external_thread_key)` because lookups now return many sessions;
- add helper methods for:
  - list all links by platform and external thread key;
  - list all platform links by session ids;
  - delete many links by session ids.

Result:

- many sessions may now attach to the same Lark root message or Telegram topic;
- each individual session still has at most one link per platform.

Attachment policy:

- every child session participating in this feature must get explicit `session_platform_links` rows for the reporting channels it reports into;
- unattached child sessions are out of scope for V1;
- when the root reporting channel is bridged, child sessions inherit attachments for both Lark and Telegram.

### 10.5 `session_bridges`

This table represents the cross-platform pairing of the reporting channel, not every attached child session.

Recommended changes:

- rename `session_id` to `root_session_id`;
- keep one row per root reporting channel pair;
- preserve uniqueness on Lark root and Telegram topic.

This avoids duplicating the same Lark/Telegram bridge row for every child session attached to the same reporting channel.

### 10.6 `lark_messages` and `telegram_messages`

Keep the existing `session_id` column and do **not** rewrite child output rows to the root session.

Semantics become explicit:

- reporting-channel anchor columns (`root_message_id`, `thread_id`, `(chat_id, topic_id)`) identify where the message appeared;
- `session_id` identifies which session produced or owns the message.

This is required for provenance, future child-aware debugging, targeted cleanup, and deterministic filtering when building root-only human history.

## 11. Repository and Contract Changes

### 11.1 Session repository

`SessionRepository` must support lineage and subtree traversal.

Add methods for:

- upserting `parentSessionId`;
- listing direct children of a session;
- listing the full descendant closure for a root session;
- deleting many sessions by ids or deleting a rooted session tree.

V1 traversal may be application-driven rather than using a recursive SQL CTE abstraction in repository APIs, but the design must expose a reliable way to enumerate a root-attached subtree.

### 11.2 Session-platform-link repository

Current single-row lookup by thread/topic is no longer sufficient.

Add methods for:

- list links by `(platform, externalThreadKey)`;
- resolve the root-session attachment for a reporting channel;
- delete all links for a set of session ids;
- optionally list all sessions attached to the same external thread key for diagnostics and cleanup.

The old singular helper can remain only where the code path explicitly expects a single session/platform row keyed by `session_id`.

### 11.3 Session-bridge repository

Rename APIs to root-oriented semantics:

- `upsertSessionBridge` -> root-session bridge upsert;
- `getBridgeBySessionId` should either become `getBridgeByRootSessionId` or keep compatibility with clearly updated semantics;
- deletion and end-marking should operate on `root_session_id`.

### 11.4 History repositories

`LarkHistoryRepository` and `TelegramHistoryRepository` must distinguish:

- root reporting-channel state (`rootSessionId` on thread/topic rows);
- producing session identity (`sessionId` on message rows).

They also need helpers to:

- fetch only message rows for a specific producing session within a reporting channel;
- list messages for a thread/topic without mutating the root-session ownership row;
- delete rows by a set of session ids when `/end` removes an entire attached subtree.

Additionally, history repositories must stop rewriting message ownership:

- inbound persistence must set the correct producing `session_id` (root session id for normal user replies);
- thread/topic upserts must not bulk rewrite `*_messages.session_id` across an entire reporting channel.

## 12. Inbound Resolution and Enrichment

### 12.1 Lark inbound resolution

`LarkSessionResolver` should continue to materialize the root session when the reporting channel is first created.

For later human replies:

- resolve the Lark reporting-channel row by `root_message_id`;
- use its `root_session_id` for default continuation;
- do not select a child session based on the most recent link or message.

Attached child sessions are intentionally invisible to human reply routing in V1.

### 12.2 Telegram inbound resolution

`TelegramSessionResolver` should mirror the Lark behavior:

- reporting topic rows keep `root_session_id`;
- default continuation resolves only that root session;
- child attachments do not affect user-visible reply routing.

### 12.3 Thread context fetchers

Current `ThreadContextFetcher` and `TelegramThreadContextFetcher` return a single inherited `session_id` and a prompt history formed from all thread/topic messages.

That is no longer acceptable because shared reporting channels may contain child-session outputs that should remain visible to users but should not contaminate root-session continuation context.

Required behavior:

- `inheritedSessionId` becomes the root session id from the reporting-channel row;
- prompt history for normal human continuation is built from message rows in the reporting channel **filtered to `session_id = root_session_id`**;
- child-session outbound rows are excluded from root-session prompt history.

This requires that message persistence for human replies records `session_id = root_session_id` on the relevant inbound/outbound rows.

This preserves the explicit user decision that normal human replies continue only the root session's context.

### 12.4 Internal enqueue contract

The API already accepts optional `session_id` and `context_ref` on `/tasks`, but that contract is currently underspecified for this feature.

V1 should standardize the distinction:

- `session_id`: the explicit execution target session;
- `context_ref`: the reporting-channel anchor (`platform`, `root_key`) used for result routing and thread/topic association.

For internal producers creating child-session work:

- both fields should be set explicitly;
- `task_source` may be absent if the task was not created from a user message;
- enrichment should not invent a new `session_id` when one is explicitly supplied.

Validation rules:

- when a task or session declares `parent_session_id`, its `context_ref` must match the reporting channel inherited from the parent/root chain;
- mismatched parent lineage and `context_ref` is a validation error, not a candidate for silent correction;
- child-session creation must persist explicit platform-link attachments matching that resolved reporting channel.

## 13. Result Routing and Persistence

### 13.1 Lark results

`LarkNotifier` currently persists outbound replies using `result.session_id` and also updates the Lark thread row with that same session identity.

Required change:

- resolve the destination reporting channel for an attached session via:
  - `result.context_ref` when present (preferred for programmatic child-session tasks);
  - else `session_platform_links` for the emitting session id;
  - else (bridge mode) `session_bridges` via the root reporting-channel key derived from platform links;
- persist the outbound message row with the producing `result.session_id`;
- keep `lark_threads.root_session_id` unchanged even when the message was emitted by a child session.

### 13.2 Telegram results

`TelegramNotifier` must mirror the Lark change:

- resolve the topic from the child session's platform link or the root bridge;
- persist outbound message rows with the producing child `session_id`;
- keep `telegram_threads.root_session_id` unchanged.

### 13.3 Phase updates and mirrors

Phase and mirror consumers should keep using the existing event transport.

However, destination lookup must now understand that:

- the emitting `session_id` may be a child session;
- the output destination still comes from the shared reporting channel attachment or root bridge.

Mirror idempotency remains unchanged because it is keyed to origin message identity rather than session ownership.

## 14. Cleanup and `/end`

### 14.1 Root resolution

When `/end` is issued from a reporting channel:

- resolve the reporting-channel row;
- recover its `root_session_id`;
- mark the root reporting channel as closing before descendant enumeration begins;
- enumerate all descendant sessions attached to that root via `parent_session_id` traversal.

While a reporting channel is closing:

- new child-session attachments must be rejected;
- new internally targeted tasks that would attach a fresh child session must fail fast rather than race cleanup.

### 14.2 What `/end` deletes

`/end` must remove, in one logical operation:

- the root session workspace;
- every attached child-session workspace;
- all `sessions` rows in the root subtree;
- all `session_platform_links` rows for that subtree;
- all `lark_messages` / `telegram_messages` rows whose `session_id` belongs to that subtree;
- the `lark_threads` / `telegram_threads` reporting-channel row for the root channel;
- the `session_bridges` row for that root reporting channel.

Deletion helpers must be updated so per-session deletion (for child sessions) does not delete the root reporting-channel row.

### 14.3 Result notification ordering

As today, terminal cleanup should happen only after the user-visible cleanup reply is successfully posted. The difference is that cleanup now targets a rooted session subtree rather than a single session.

### 14.4 GC semantics

GC must also be updated so it can safely remove stale child-session rows and root-owned reporting-channel state without assuming one reporting channel equals one session.

V1 does not need to redesign GC strategy, but every GC path touched by this feature must avoid leaving orphaned child sessions, links, or root channel rows behind.

## 15. CLI Changes

The CLI should be adjusted to support the internal routing contract rather than only the user-facing root-session submission path.

Recommended additions:

- optional `--session-id` to target an existing execution session explicitly;
- optional `--context-platform` and `--context-root-key` to specify the reporting-channel anchor;
- validation that context fields are supplied together;
- continue supporting the existing simple submission mode when these fields are omitted.

This is not for end users choosing child sessions in a shared thread. It is to support programmatic and operator-driven task submission that must bind a task to a specific child session while preserving shared reporting-channel routing.

## 16. Migration Strategy

The schema change will require another relational migration.

Recommended migration steps:

1. add `parent_session_id` to `sessions` and backfill `NULL` for all existing rows;
2. rename or recreate thread/topic tables so `session_id` becomes `root_session_id`;
3. rename `session_bridges.session_id` to `root_session_id`;
4. remove the unique constraint on `session_platform_links(platform, external_thread_key)` and replace it with a non-unique index;
5. backfill current data so each existing thread/topic still points to its current single root session;
6. backfill message rows so normal human thread/topic messages use `session_id = root_session_id`:
   - for Lark: update `lark_messages.session_id` by joining `lark_threads` on `root_message_id` and writing the thread's `root_session_id`.
   - for Telegram: remove any logic that rewrites message session ids across a topic, and backfill as needed to align root-session history filtering.

If SQLite rename limitations make direct column renames awkward, table-rebuild migrations are acceptable and likely clearer.

## 17. Testing Strategy

Minimum required coverage:

1. schema/repository tests proving many sessions can attach to the same Lark root and Telegram topic;
2. inbound resolver tests proving human replies still continue only the root session;
3. thread-context tests proving root-session history excludes child-session output rows and depends on correct root-session message `session_id` backfill;
4. result notifier tests proving child-session results route to the shared reporting channel while preserving child `session_id` in persisted message rows;
5. cleanup tests proving `/end` on the reporting channel removes the full rooted subtree;
6. CLI tests proving explicit `session_id` plus `context_ref` submission is accepted and validated.

## 18. Risks and Mitigations

### Risk 1: Root-session metadata is accidentally overwritten by child output

**Mitigation:** rename fields and repository methods to root-oriented semantics, and add tests asserting child result persistence does not mutate `root_session_id` on thread/topic rows.

### Risk 2: Root prompt history becomes polluted by child-session output

**Mitigation:** build human continuation history by filtering to root-session message rows only; add regression tests with interleaved child output.

### Risk 3: `/end` deletes only the root session and leaves child orphans

**Mitigation:** centralize subtree enumeration from `parent_session_id` and reuse it across notifiers and cleanup executors; test multi-level descendant cleanup.

### Risk 4: Destination lookup becomes ambiguous once platform links are no longer unique by thread/topic

**Mitigation:** reserve singular reporting-channel ownership to the root thread/topic row and use list-based lookup APIs only where attachment multiplicity is expected.

### Risk 5: CLI and internal producers misuse `session_id` and `context_ref`

**Mitigation:** document and validate the contract clearly: `session_id` selects execution target; `context_ref` selects reporting channel.

## 19. Acceptance Criteria

This feature is complete when:

1. a reporting channel has one root session and can have multiple attached child sessions;
2. child sessions preserve their own `session_id`, queue, workspace, and executor lifecycle;
3. child phase and terminal results route into the same Lark thread / Telegram topic as the root session;
4. normal human replies in the shared reporting channel still continue only the root session;
5. root human prompt history excludes child-session output rows;
6. `session_platform_links` allows many sessions to attach to the same reporting channel;
7. `/end` from the reporting channel removes the full root-plus-descendants subtree across workspaces and DB state;
8. CLI and API contracts can explicitly submit work to a target child session while still binding it to a reporting channel context.
