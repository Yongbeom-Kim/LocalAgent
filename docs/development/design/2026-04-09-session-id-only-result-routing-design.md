# Design: Session-ID-Only Result Routing for Lark and Telegram

**Date:** 2026-04-09
**Status:** Draft
**Packages affected:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/migrator`, `packages/daemon/lark-result`, `packages/daemon/telegram-outbound`, `packages/daemon/lark-listener`, `packages/daemon/telegram-inbound`, `packages/daemon/task-enrichment`, `packages/daemon/task`, `packages/cli`

## 1. Problem

The current messaging architecture still carries multiple routing concepts through the result-delivery path:

- outbound result payloads may include `session_id`, `context_ref`, and same-platform `task_source` hints;
- Lark and Telegram notifiers can resolve destinations from a mix of inbound source metadata, platform-link mappings, and cross-platform bridge rows;
- `session_bridges` couples Lark and Telegram routing state even though the result queue fanout can already be handled by RabbitMQ exchange topology;
- inbound continuation and outbound result delivery are partially entangled through the same persistence rows.

That architecture makes the routing contract broader than necessary. The user’s target model is narrower:

1. result services should receive only `session_id` in the result payload;
2. each platform’s outbound daemon should map `session_id` to its own external destination;
3. if that mapping does not exist yet, the platform daemon should lazily create it and persist it;
4. cross-platform fanout should come from RabbitMQ exchange behavior, not a database bridge table.

## 2. Goal

Redesign result routing so `session_id` is the only required routing identity for outbound Lark and Telegram delivery, while keeping inbound human continuation deterministic.

After this feature:

- result events destined for Lark/Telegram rely on `session_id` only for routing;
- each outbound daemon owns its own platform-specific `session_id -> external destination` resolution and lazy creation flow;
- `session_platform_links` becomes the only persistent outbound routing map;
- `session_bridges` is removed entirely;
- RabbitMQ exchange fanout delivers the same result event to both platform daemons when configured;
- `lark_threads.root_session_id` and `telegram_threads.root_session_id` remain only as live inbound anchors for human continuation while the conversation is active;
- `/end` hard-deletes platform mappings and thread/topic anchor rows;
- inbound replies to a deleted thread/topic are treated as brand-new sessions rather than resurrecting the old session;
- child sessions remain normal sessions, keep `parent_session_id`, and lazily acquire per-platform outbound mappings when each platform daemon first needs them.

## 3. Non-Goals

- No generic platform-agnostic reporting-channel table.
- No retained tombstone rows for ended thread/topic anchors in V1.
- No database-level bridge or fanout configuration between Lark and Telegram.
- No backward-compatibility shim for old result payloads that still depend on `context_ref` or bridge lookup.
- No user-facing command to manually choose which child session within a shared visible thread/topic receives a human reply.
- No eager pre-materialization of child platform links.

## 4. User Decisions Captured

- Apply the redesign to both Lark and Telegram.
- Result-delivery services should receive `session_id` only.
- If no destination mapping exists, the platform daemon should auto-create one.
- Backward-compatibility with the old result-routing contract is not required.
- Destination resolution and creation stay inside each platform daemon rather than moving to a shared cross-platform service.
- Database routing remains per-platform; no generic reporting-channel abstraction in V1.
- Cleanup hard-deletes mappings instead of retaining ended mapping tombstones.
- Child-session delivery mappings are lazily created only when a platform daemon first needs them.
- Late result/phase events after cleanup must not auto-create a new destination for an ended or missing session; daemons should check live session state before lazy create.
- The bridge concept is removed entirely.
- Inbound human replies should continue a stable root session while the thread/topic is alive.
- The stable inbound root anchor should be stored on `lark_threads.root_session_id` and `telegram_threads.root_session_id`.
- Those live anchor rows are hard-deleted on `/end`.
- Child activity must never mutate a thread/topic row’s `root_session_id`.
- Cross-platform fanout is controlled by RabbitMQ exchange topology, not DB state.
- If an inbound human reply arrives after the anchor row was deleted, it should be treated as a brand-new session.
- This is an intentional tradeoff of full hard-delete semantics: once `/end` removes the live anchor row, the system no longer remembers ownership of that external thread/topic, so a later inbound reply must be handled as new work.
- Fanout should continue sending only to currently materialized platform surfaces; a child result should not auto-create a missing platform surface solely because another platform received the same event.

## 5. Existing Context

### 5.1 Execution identity is already session-centric

Current code already treats `session_id` as the execution identity for:

- session rows in `sessions`;
- per-session job routing in `/jobs/next/:sessionId`;
- workspace lifecycle and cleanup;
- child-session lineage through `parent_session_id`.

That remains correct and should not be changed.

### 5.2 Outbound routing is broader than necessary today

Today Lark and Telegram outbound daemons can derive destinations from:

- `task_source` for same-platform direct replies;
- `context_ref` root keys;
- `session_platform_links`;
- `session_bridges` for cross-platform lookup;
- fallback direct message/topic creation.

This makes result delivery depend on multiple routing inputs instead of one canonical identity.

### 5.3 Inbound continuation already depends on platform thread/topic rows

Inbound resolvers and context fetchers currently look up live thread/topic rows first:

- Lark uses `lark_threads` and filters prompt history to messages matching the thread’s root-owned session;
- Telegram uses `telegram_threads` and prompt history for the topic;
- both systems treat the thread/topic row as the normal continuation anchor.

That means the thread/topic tables remain the best place to keep the live root session anchor for inbound behavior.

## 6. Scope Assessment

This is one coherent subsystem.

It spans:

- SQLite schema and repositories;
- result payload contract validation;
- Lark and Telegram outbound notifier logic;
- inbound session resolution and thread-context reconstruction;
- cleanup and GC behavior;
- CLI/API surfaces that still expose obsolete routing hints.

Those pieces all serve the same re-architecture: `session_id`-only outbound routing with per-platform lazy destination materialization.

## 7. Approaches Considered

### Approach A: Minimal per-platform routing re-architecture (recommended)

Use `session_id` as the only outbound routing identity, keep platform-specific lazy create inside each outbound daemon, preserve live inbound root anchors on `lark_threads`/`telegram_threads`, and remove `session_bridges` entirely.

**Pros**

- Matches the requested architecture directly.
- Removes bridge-specific complexity.
- Keeps platform-specific API behavior local to each daemon.
- Minimizes conceptual churn while still materially simplifying routing.

**Cons**

- Some routing logic remains duplicated between Lark and Telegram.
- Cleanup and post-end inbound behavior must be made explicit because there are no retained tombstones.

### Approach B: Shared resolver layer with platform adapters

Keep the same high-level contract but move resolution orchestration into a shared library.

**Pros**

- Less duplicated decision logic.
- Easier to enforce symmetry.

**Cons**

- Conflicts with the user’s explicit preference to keep resolution/create ownership inside each platform daemon.
- Adds an abstraction layer that is not necessary for V1.

### Approach C: Generic reporting-channel model

Add a platform-agnostic abstraction for root anchors, outbound links, and fanout.

**Pros**

- Clean long-term model.
- Future platform additions become easier.

**Cons**

- Overbuilt for the current ask.
- Conflicts with the requested minimal `session_id`-only payload and no-bridge direction.

## 8. Recommendation

Adopt **Approach A**.

This is the smallest architecture that satisfies the target model:

- `session_id` only for outbound routing;
- no bridges;
- per-platform daemon-local lazy create;
- RabbitMQ exchange-based cross-platform fanout;
- live root anchors only for inbound continuation.

## 9. Design Overview

### 9.1 Core invariants

1. `session_id` is the only outbound routing identity for result and phase delivery.
2. Each platform daemon owns destination lookup and lazy creation for its own platform.
3. `session_platform_links` is the only persistent outbound routing map.
4. `session_bridges` does not exist in V1.
5. Cross-platform fanout is determined by RabbitMQ exchange wiring, not DB state.
6. `lark_threads.root_session_id` and `telegram_threads.root_session_id` are live inbound continuation anchors only.
7. A thread/topic row’s `root_session_id` never changes due to child-session output.
8. `/end` hard-deletes platform links and thread/topic anchor rows.
9. After anchor deletion, inbound replies to the old thread/topic are treated as brand-new sessions.
10. Child sessions keep `parent_session_id` lineage and lazily create platform links independently per platform when needed.
11. If an outbound daemon receives a late event for a missing or ended session, it must not auto-create a new destination.
12. Lazy destination creation is allowed only when the platform has enough fallback metadata to materialize a destination safely.
13. Message rows preserve the producing `session_id`.

### 9.2 Architecture flow

```text
Task execution result
  -> publish result event containing session_id
  -> RabbitMQ exchange fans out to lark-result / telegram-outbound queues
  -> each platform daemon receives the same event
  -> daemon resolves session_id -> platform destination from session_platform_links
  -> if missing and session is still live and has platform-specific fallback metadata, daemon lazily creates destination and persists link
  -> daemon posts result to its own platform

Inbound human reply in Lark/Telegram
  -> resolve live thread/topic row
  -> recover root_session_id from lark_threads / telegram_threads
  -> continue only that root session
  -> child outputs visible in the same thread/topic do not change root ownership

/end
  -> enumerate root + descendants
  -> remove workspaces
  -> delete session_platform_links for subtree
  -> delete live lark_threads / telegram_threads anchor rows for affected roots
  -> delete sessions and messages for subtree
  -> future replies to old threads/topics are handled as brand-new sessions
```

## 10. SQLite Schema

### 10.1 `sessions`

Keep:

- `session_id` primary key
- `parent_session_id`
- `task_type`
- `executor`
- `executor_model`
- `status`
- `created_at_ms`
- `updated_at_ms`
- `fallback_seed_text`
- `fallback_origin`
- `fallback_title_hint`

Drop:

- `ended_at_ms`

Indexes:

- `idx_sessions_parent_session_id`
- `idx_sessions_status_updated_at`

Rationale:

- session rows remain the execution identity;
- lineage still matters for cleanup and child-session behavior;
- if cleanup hard-deletes ended sessions, `ended_at_ms` is unnecessary in V1.

### 10.2 `session_platform_links`

Keep:

- `session_id`
- `platform`
- `external_thread_key`
- `claim_token`
- `claim_expires_at_ms`
- `created_at_ms`
- `updated_at_ms`

Primary key:

- `(session_id, platform)`

Indexes:

- `idx_session_platform_links_platform_external_thread_key`
- `idx_session_platform_links_session_id`

Drop:

- `link_status`
- `ended_at_ms`

Semantics:

- row exists = active mapping;
- row missing = mapping has not been created yet or has been cleaned up;
- `external_thread_key IS NULL` plus claim fields means lazy creation is in progress.

### 10.3 `lark_threads`

Keep:

- `root_message_id` primary key
- `thread_id`
- `root_session_id`
- `source`
- `chat_type`
- `task_type`
- `executor`
- `executor_model`
- `status`
- `created_at_ms`
- `updated_at_ms`

Indexes:

- unique/index on `thread_id`
- unique/index on `root_session_id`
- `idx_lark_threads_status_updated_at`

Drop:

- `ended_at_ms`

Semantics:

- authoritative inbound root anchor while alive;
- child result delivery may post into the thread but never rewrites `root_session_id`;
- hard-delete the row on `/end`.

### 10.4 `telegram_threads`

Keep:

- composite primary key `(chat_id, topic_id)`
- `root_session_id`
- `source`
- `task_type`
- `executor`
- `executor_model`
- `status`
- `seed_message_id`
- `status_message_id`
- `metadata_json`
- `created_at_ms`
- `updated_at_ms`

Indexes:

- unique/index on `root_session_id`
- `idx_telegram_threads_status_updated_at`

Drop:

- `ended_at_ms`

Semantics mirror Lark:

- authoritative live inbound anchor;
- immutable root ownership while alive;
- hard-delete on `/end`.

### 10.5 `lark_messages` and `telegram_messages`

Keep both message tables and their current producer `session_id` semantics.

Keep current indexes for:

- thread/topic ordered history lookup;
- session-scoped history lookup.

Rationale:

- prompt-history reconstruction still needs root-owned message filtering;
- auditability still benefits from preserving the producing session id;
- cleanup deletes message rows before or together with the parent thread/topic row.

### 10.6 Drop `session_bridges`

Remove the table entirely.

Rationale:

- no bridge concept remains;
- no DB-level cross-platform pairing is needed;
- RabbitMQ exchange fanout replaces cross-platform routing state.

## 11. Data Model Semantics

### 11.1 Outbound routing

For each platform daemon:

1. receive an event containing `session_id`;
2. read the session row;
3. if the session is missing or not active, do not create a destination;
4. look up `(session_id, platform)` in `session_platform_links`;
5. if a link exists, use it;
6. if no link exists, attempt lazy creation using that platform’s native API only when the session has enough fallback metadata for that platform;
7. persist the link on success;
8. send the message.

### 11.2 Inbound continuation

For each inbound message:

1. resolve the live thread/topic row by external platform key;
2. recover `root_session_id` from that row;
3. continue only the root session;
4. if the row does not exist because the session was ended and cleaned up, treat the inbound message as a brand-new session.

Behavior note:

- this is an intentional consequence of full hard-delete cleanup;
- once the live anchor row is gone, the system no longer remembers ownership of that external thread/topic;
- therefore a later reply cannot safely continue the old session and is treated as new work instead.

### 11.3 Child-session behavior

Child sessions:

- remain ordinary session rows with `parent_session_id`;
- do not eagerly create any platform links;
- lazily create a Lark link when the Lark result daemon first needs one;
- lazily create a Telegram link when the Telegram outbound daemon first needs one;
- may therefore have one platform mapping materialized before the other even when both daemons receive the same event.

### 11.4 Fanout behavior

RabbitMQ exchange routing determines which daemons see the event.

The DB does **not** decide whether a session fans out to Lark, Telegram, or both.

Consequences:

- if both daemons receive the same event, both may independently resolve or create a destination;
- if only one daemon receives the event, only that platform sends;
- fanout policy lives in broker topology and deployment configuration, not schema or app-level bridge rows.

## 12. API and Contract Changes

### 12.1 `/results`

Result and phase events for Lark/Telegram routing should require and rely on `session_id` only.

Changes:

- make `session_id` required for `event_kind = result` and `event_kind = phase`;
- remove `context_ref` from the outbound-routing path for result and phase events;
- stop depending on `task_source` for delivery routing except where it remains useful for audit text or same-platform mirror suppression;
- mirror-event behavior tied to bridge rows is removed.

### 12.2 `/tasks`, `/jobs`, CLI submit

Shared contracts and CLI surfaces should stop presenting stale routing knobs as normal usage for this feature.

Changes:

- keep `session_id` as the canonical explicit execution target;
- remove or de-emphasize `context_ref` from new result-routing flows;
- if `context_ref` remains elsewhere for non-result uses, clearly separate it from result delivery.

## 13. Repository and Daemon Changes

### 13.1 Repositories

`SessionPlatformLinkRepository`

- simplify row semantics by removing ended-state handling;
- keep claim-based lazy-create coordination;
- treat row absence as the only non-active state.

`SessionBridgeRepository`

- remove entirely.

`LarkHistoryRepository` / `TelegramHistoryRepository`

- keep live root anchor row semantics;
- hard-delete thread/topic rows on cleanup;
- preserve producing `session_id` on message rows;
- continue supporting root-owned prompt-history filtering.

### 13.2 Lark outbound daemon

`lark-result` should:

- stop using `context_ref` and bridge lookup as routing sources;
- resolve destination only via `session_id` and `session_platform_links`;
- lazy-create a Lark root message/thread when no link exists, the session is still active, and `fallback_seed_text` is present;
- refuse lazy create when the session is missing, ended, or lacks enough fallback metadata;
- remove mirror logic that depends on `session_bridges`.

### 13.3 Telegram outbound daemon

`telegram-outbound` should:

- stop using bridge lookup and `context_ref` as routing sources;
- resolve destination only via `session_id` and `session_platform_links`;
- lazy-create a Telegram topic when no link exists, the session is still active, and `fallback_seed_text` is present;
- refuse lazy create for missing, ended, or under-specified sessions;
- remove mirror logic that depends on `session_bridges`.

### 13.4 Inbound resolvers

`lark-session-resolver` and `telegram-session-resolver` should:

- resolve continuation from live thread/topic rows first;
- stop using platform-link rows as an inbound fallback once the thread/topic row is gone;
- reject inbound continuation when the anchor row is absent.

### 13.5 Thread-context fetchers

Prompt-history reconstruction should continue filtering to root-owned messages using the live thread/topic row’s `root_session_id`.

If the thread/topic row no longer exists, context fetch should not silently continue from history-only reconstruction.

## 14. Cleanup and GC

### 14.1 `/end`

Cleanup for a root session subtree should:

1. enumerate descendants from `parent_session_id`;
2. mark the subtree `sessions.status = 'ended'` before deleting any routing rows;
3. remove workspace directories for the subtree;
4. delete `session_platform_links` rows for the subtree;
5. delete `lark_messages` / `telegram_messages` rows for the subtree;
6. delete `lark_threads` / `telegram_threads` live anchor rows for the affected roots;
7. delete `sessions` rows for the subtree.

Because thread/topic rows are hard-deleted, future inbound replies to those old external threads/topics should start brand-new sessions.

### 14.2 GC

GC should no longer expect `session_bridges` to exist.

Stale-row cleanup should use the surviving thread/topic and session tables only.

## 15. Migration Strategy

Migration should:

1. drop `session_bridges`;
2. remove `ended_at_ms` from `sessions`, `session_platform_links`, `lark_threads`, and `telegram_threads`;
3. remove `link_status` from `session_platform_links`;
4. preserve existing message rows;
5. preserve existing `root_session_id` fields on `lark_threads` and `telegram_threads`;
6. preserve existing platform link rows where possible, translating active rows into the simplified no-status form;
7. rebuild `session_platform_links` through a `__new_session_platform_links` table copy so SQLite can drop obsolete columns safely;
8. explicitly drop the old unique index on `(platform, external_thread_key)` before creating the simplified non-unique lookup index;
9. update schema-version expectations and GC compatibility checks.

## 16. Risks and Mitigations

### Risk 1: late result events recreate destinations after cleanup

If the daemon only checks link existence, a missing link after cleanup could trigger unintended re-creation.

**Mitigation:** require a live session-row check before lazy create; missing/ended session means no create. Cleanup must mark `sessions.status = 'ended'` before link deletion so a late event cannot recreate a destination during teardown.

### Risk 2: inbound accidentally continues from old platform-link rows instead of live anchor rows

That would resurrect ended conversations.

**Mitigation:** inbound resolvers must treat thread/topic rows as the only continuation anchor; no fallback to platform-link lookup after cleanup.

### Risk 3: Lark and Telegram daemon logic drifts over time

The architecture intentionally keeps resolution local per daemon.

**Mitigation:** align tests and repository contracts so both daemons follow the same high-level state machine even if implemented locally.

### Risk 4: removing bridge rows breaks mirror-only paths

Some current mirror behavior still depends on bridge lookup.

**Mitigation:** explicitly remove bridge-based mirror behavior from scope and tests in this feature.

## 17. Open Questions Resolved

- Should outbound routing use only `session_id`? Yes.
- Should both platforms follow the same model? Yes.
- Should auto-create happen when mapping is missing? Yes.
- Should compatibility shims for the old contract remain? No.
- Should bridge state remain in the DB? No.
- Where is cross-platform fanout configured? RabbitMQ exchange topology.
- Where is live inbound root ownership stored? `lark_threads.root_session_id` and `telegram_threads.root_session_id`.
- What happens after `/end`? Hard-delete live anchor rows; any future reply to the old thread/topic is treated as a brand-new session.

## 18. Summary

This design deliberately narrows the messaging model:

- outbound result routing becomes `session_id` only;
- platform daemons own platform-specific lazy destination creation;
- `session_platform_links` is the only outbound routing map;
- `session_bridges` is removed;
- thread/topic rows remain only as live inbound anchors while a conversation exists;
- RabbitMQ exchange fanout, not DB bridge state, determines which platform daemons receive the event.
