# Design: Fanout-Based Shared-Channel Routing Without Session Bridges

**Date:** 2026-04-09  
**Status:** Ready for implementation planning  
**Packages affected:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/migrator`, `packages/daemon/lark-listener`, `packages/daemon/telegram-inbound`, `packages/daemon/task-enrichment`, `packages/daemon/lark-result`, `packages/daemon/telegram-outbound`, `packages/daemon/task`, `packages/cli`

## 1. Problem

The current architecture still carries two overlapping routing models for shared Lark and Telegram delivery:

- execution identity is already modeled by `sessions.session_id`;
- reporting-channel attachment is modeled by `session_platform_links` plus per-platform thread/topic tables;
- cross-platform pairing is additionally modeled by `session_bridges`;
- result consumers still contain fallback logic that tries to infer destinations from `session_id`, `task_source`, platform tables, and bridge rows.

That overlap creates unnecessary state and a weak routing contract.

Today:

- `session_bridges` duplicates information that can be derived from the root session and its platform links;
- fanout already transports phase, result, and mirror events, but consumers still rely on local inference rather than an explicit reporting-channel anchor;
- direct removal of the bridge table would leave ambiguous routing paths unless the event contract becomes stricter;
- cleanup and GC still carry bridge-specific deletion branches;
- daemon composition roots still instantiate `SessionBridgeRepository`, so bridge removal is not just a notifier-local change;
- pollers still dispatch some events by `task_source.source` rather than by an explicit platform anchor;
- task intake still allows session-backed work to enter the system without a guaranteed reporting-channel anchor.

The user wants to simplify the architecture by removing the bridge table and relying on the existing fanout queue model rather than maintaining redundant pairing state.

## 2. Goal

Remove `session_bridges` and simplify shared-channel routing so fanout remains the transport layer while explicit reporting-channel context becomes the contract boundary.

After this feature:

1. `session_bridges` no longer exists in schema or runtime code;
2. root-session ownership plus `session_platform_links` becomes the only persistent routing model;
3. fanout remains the delivery transport for phase, result, and mirror events;
4. every fanout-routed event intended for shared-channel delivery carries explicit `context_ref`;
5. consumers hard-fail shared-channel routing when required `context_ref` is missing instead of inferring from links, history, or bridge rows;
6. mirror remains a distinct event kind rather than being folded into phase/result;
7. pollers dispatch to platform-specific consumers using explicit platform contract rules;
8. cleanup and GC delete sessions, links, and per-platform history without any bridge-table path;
9. daemon bootstrap wiring no longer imports or constructs `SessionBridgeRepository`;
10. the overall routing model is easier to reason about because transport and persistence responsibilities are separated.

## 3. Non-Goals

- No redesign of RabbitMQ topology beyond the contract changes needed for routing.
- No replacement of fanout with topic-routing or per-destination exchanges.
- No introduction of a new generic `reporting_channels` table.
- No attempt to preserve backward compatibility for shared-channel events that omit `context_ref` after the cutover ships.
- No folding of mirror into phase/result payload semantics.
- No change to session execution identity, queue isolation, or workspace lifecycle.
- No requirement that notifiers create fallback channels on behalf of malformed result events.

## 4. User Decisions Captured

- Scope is broader than deleting one table; it includes messaging and routing simplification around that removal.
- `session_bridges` should be fully deleted, not retained as a derived cache.
- Fanout should remain transport only, not the source of truth for routing.
- Shared-channel routing should use explicit `context_ref` in queue payloads.
- Missing required `context_ref` should hard-fail rather than relying on permanent fallback inference.
- Mirror should remain its own event kind.
- Rollout target is a direct cutover rather than a long compatibility phase.

## 5. Existing Context

### 5.1 Execution identity is already session-based

Current implemented behavior:

- `sessions.session_id` is the canonical execution identity;
- jobs are routed by `session_id` through per-session queues;
- cleanup, GC, and lineage traversal already operate in session terms.

This part of the architecture is already correct and does not need a second cross-platform identity layer.

### 5.2 Reporting-channel attachment already exists without the bridge table

Current implemented behavior:

- `lark_threads.root_session_id` and `telegram_threads.root_session_id` represent root reporting-channel ownership;
- `session_platform_links` attaches sessions to reporting channels on each platform;
- inbound resolvers in Lark and Telegram already use platform links plus platform history to recover or materialize sessions.

That means most inbound routing is already bridge-free.

### 5.3 The bridge table is now mostly a notifier and cleanup fallback

Current implemented behavior:

- `session_bridges` is primarily referenced in `lark-result`, `telegram-outbound`, daemon bootstrap wiring, and cleanup/GC flows;
- `POST /results` publishes fanout events with optional `context_ref` for phase/result and no `context_ref` requirement for mirror;
- result consumers currently compensate for missing routing anchors by inferring from `session_id`, `task_source`, platform history, and bridge rows;
- some pollers decide which platform should process a mirror event based on `task_source.source` instead of an explicit anchored destination;
- task intake still accepts session-backed work without requiring the reporting-channel anchor that downstream fanout delivery now depends on.

This makes shared-channel delivery more implicit than it needs to be.

## 6. Scope Assessment

This is one coherent subsystem.

It spans:

- shared event contracts;
- task intake validation;
- result API validation for fanout event submission;
- inbound submitter responsibilities;
- enrichment and task-daemon publishing responsibilities;
- Lark and Telegram poller dispatch behavior;
- Lark and Telegram result delivery;
- shared schema and repositories;
- daemon composition roots;
- cleanup and GC.

These all serve one architectural change: fanout-transported, context-anchored routing without a dedicated cross-platform bridge table.

## 7. Approaches Considered

### Approach A: Delete `session_bridges` and strengthen event contracts with explicit `context_ref` (recommended)

Keep fanout as transport, keep persistence authority in root-session and platform-link state, and require shared-channel events to carry explicit `context_ref` so consumers do not need bridge-specific fallback inference.

**Pros**

- Removes redundant state rather than replacing it with another cache.
- Clarifies the boundary between transport and persistence.
- Makes result consumers simpler and more deterministic.
- Fits the existing root-session/reporting-channel direction already present in the codebase.

**Cons**

- Requires coordinated updates across publishers, pollers, consumers, and intake surfaces.
- A direct cutover means older event payloads must be eliminated before deployment.

### Approach B: Delete `session_bridges` but preserve consumer-side fallback inference

Remove the table, but let consumers keep guessing from `session_id`, `task_source`, and platform state when `context_ref` is absent.

**Pros**

- Smaller payload-surface change.
- Fewer API validation updates.

**Cons**

- Leaves the hardest part of the architecture implicit.
- Preserves the same class of routing ambiguity the bridge table was previously masking.
- Keeps poller and notifier behavior inconsistent.
- Makes direct cutover riskier because silent inference failures become harder to diagnose.

### Approach C: Make fanout payloads the primary routing source and demote DB state

Treat the queue payload itself as the canonical cross-platform routing record, minimizing DB lookups during delivery.

**Pros**

- Potentially fewer DB reads during notification.
- Strong event-driven flavor.

**Cons**

- Pushes durable routing semantics into transient transport.
- Conflicts with the user decision that fanout should be transport only.
- Makes cleanup and lineage reasoning worse, not better.

## 8. Recommendation

Adopt **Approach A**.

The simplified architecture should be:

- `sessions` owns execution identity;
- `lark_threads` / `telegram_threads` own root reporting-channel metadata;
- `session_platform_links` owns session-to-channel attachment;
- task intake and publishers are responsible for preserving the reporting-channel anchor;
- fanout transports already-addressed events;
- pollers dispatch events according to explicit platform contract rules;
- `context_ref` explicitly tells consumers which reporting channel an event is for.

This removes the redundant bridge layer without making the queue responsible for durable routing state.

## 9. Design Overview

### 9.1 Core invariants

V1 codifies these invariants:

1. A shared reporting channel still has exactly one root session per platform row.
2. Cross-platform pairing is derived from the root session's active platform links, not stored in `session_bridges`.
3. Fanout is transport only; it never becomes the durable source of routing truth.
4. Any mirror event and any phase/result event intended for shared-channel delivery must carry `context_ref`.
5. Consumers hard-fail shared-channel delivery when the event contract is violated.
6. Mirror remains semantically distinct from phase/result.
7. Per-platform thread/topic rows preserve root ownership even when child sessions emit output.
8. Pollers must not reinterpret a missing destination contract by peeking at `task_source.source` alone.
9. Cleanup and GC operate on session trees, platform links, and platform history only.

### 9.2 Delivery modes

The cutover should formalize three routing modes.

#### Mode A: direct source-addressed same-platform delivery

Used for direct replies or reactions where the event is completely addressed by `task_source`.

Properties:

- event may omit `session_id`;
- event may omit `context_ref`;
- delivery target is derived directly from platform-native source fields;
- event is not eligible for cross-platform shared-channel fanout inference.

Examples:

- Lark direct reaction update addressed by `task_source.message_id`;
- Telegram direct reply addressed by `task_source.chat_id` and `task_source.topic_id`.

#### Mode B: session-backed shared-channel delivery

Used for task lifecycle output or mirrors that should land in a shared reporting surface.

Properties:

- event is tied to a session-backed execution path;
- event must carry `context_ref`;
- consumers use `context_ref` as the destination contract;
- consumers may load DB metadata for persistence or verification, but not to invent a missing anchor.

#### Mode C: fallback-materialized session attachment before fanout

Fallback channel creation may still exist, but only before a shared-channel event is published.

Properties:

- fallback materialization is an intake or producer concern, not a notifier concern;
- if a session needs a fallback Lark thread or Telegram topic, that attachment must be created and persisted before phase/result/mirror fanout publication;
- the resulting event still carries explicit `context_ref`;
- consumers never create fallback channels merely because `context_ref` is absent.

This distinction is important. “No consumer-side inference” does not prohibit creating fallback attachments upstream. It prohibits consumers from guessing destinations after the event contract has already been violated.

### 9.3 High-level architecture

```text
task intake / inbound submitter / enrichment / mirror producer
  -> resolve or materialize reporting attachment before fanout if needed
  -> emit fanout event with explicit context_ref
  -> API validates event contract
  -> RabbitMQ fanout exchange transports event

Lark poller / Telegram poller
  -> read event from platform queue
  -> dispatch only events whose explicit contract matches the platform
  -> do not rely on task_source.source alone for mirror/shared-channel routing

Lark consumer / Telegram consumer
  -> require context_ref for shared-channel routing
  -> resolve destination through platform-specific root_key
  -> use DB only to load metadata / verify ownership / persist history
  -> hard-fail invalid shared-channel events

cleanup / GC
  -> traverse root session + descendants
  -> delete sessions, session_platform_links, lark_* rows, telegram_* rows
  -> no session_bridges branch exists
```

## 10. Data Model Changes

### 10.1 Remove `session_bridges`

Delete the table entirely.

Implications:

- no shared repository for bridge lookups;
- no migration path that preserves bridge rows as runtime state;
- no daemon bootstrap wiring that constructs bridge repositories;
- no cleanup or GC deletion branch for bridge rows;
- any previous lookup of “peer platform by session id” must instead resolve via root session and `session_platform_links` before event publication, not during notification.

### 10.2 Keep root-session ownership on platform tables

`lark_threads.root_session_id` and `telegram_threads.root_session_id` remain the canonical root-channel ownership fields.

Required semantics:

- root ownership is stable after materialization;
- child-session output must not rewrite the root owner;
- platform rows provide metadata for delivery and cleanup, not cross-platform pairing state;
- platform rows, not `session_platform_links`, decide which session owns a reporting channel.

### 10.3 Keep `session_platform_links` as the attachment table

`session_platform_links` becomes the only session-to-channel attachment abstraction.

Required semantics:

- each session may have at most one link per platform;
- multiple sessions may attach to the same reporting channel where the broader shared-channel design permits it;
- root session links provide the derived cross-platform pairing after bridge-table removal;
- attachment lookups answer “which channels is this session attached to?” not “which session owns this channel?”;
- ownership-sensitive resolution must read `lark_threads` / `telegram_threads`, not choose an arbitrary row from `session_platform_links`.

## 11. Event Contract Changes

### 11.1 Shared-channel events must carry `context_ref`

For `phase`, `result`, and `mirror` events:

- `mirror` always requires `context_ref`;
- `phase` and `result` require `context_ref` whenever they are session-backed shared-channel events;
- direct same-platform `phase` and `result` events may omit `context_ref` only when they omit `session_id` and are fully addressed by `task_source`;
- `context_ref.platform` identifies the reporting platform anchor;
- `context_ref.root_key` identifies the platform-specific root reporting-channel key.

Interpretation:

- for Lark, `root_key` is the Lark root message id;
- for Telegram, `root_key` is the Telegram external thread key (`chat_id:topic_id`).

### 11.2 Task intake contract must align with result-event contract

The result-event contract is only enforceable if task intake preserves enough information.

Required behavior:

- task submission surfaces must reject session-backed shared-channel work that omits `context_ref` when the task is intended to publish into a shared reporting channel;
- inbound submitters must propagate `context_ref` whenever they resolve or materialize a shared reporting attachment;
- any workflow that plans to rely on fallback attachment creation must create that attachment before emitting fanout lifecycle events;
- downstream daemons must preserve the original `context_ref` rather than re-deriving it.

### 11.3 Hard failure on contract violation

Consumers must not silently infer shared-channel routing when `context_ref` is missing.

Expected behavior:

- invalid events are rejected at task intake or the result API boundary whenever possible;
- if an invalid event reaches a poller or consumer, that component should log and fail the delivery path instead of guessing;
- `task_source` may address direct same-platform replies and reactions;
- `context_ref` addresses anchored fanout delivery for shared-channel work;
- `task_source` must never be used to infer a peer-platform destination;
- `session_platform_links` and platform history may verify metadata and persistence state, but must not be used to guess a missing reporting anchor for delivery.

This is deliberate. The purpose of the cutover is to eliminate implicit routing behavior.

### 11.4 Mirror remains distinct

Mirror events keep their own event kind because they represent user-authored cross-channel replication rather than task lifecycle output.

Required behavior:

- mirror payloads gain required `context_ref` for deterministic destination resolution;
- mirror poller dispatch must honor `context_ref.platform` rather than relying only on `task_source.source`;
- loop prevention remains keyed by origin message identity and mirror metadata;
- mirror is not folded into result or phase semantics.

## 12. Publisher and Intake Changes

### 12.1 Task submission and intake validation

`POST /tasks`, CLI surfaces, and inbound submitters must align with the stricter routing contract.

Required behavior:

- explicit child-session work continues to accept separate `session_id` and `context_ref`;
- work intended to report into a shared channel must provide `context_ref` at submission time;
- if a fallback attachment must be created, it must be created before fanout lifecycle publication so the resulting task and result paths stay contract-complete.

### 12.2 Result API validation

`POST /results` must be tightened so that:

- `mirror` submissions require valid `context_ref`;
- `phase` submissions with `session_id` require valid `context_ref` unless the event is the direct same-platform mode that omits `session_id` entirely;
- `result` submissions with `session_id` require valid `context_ref` unless the event is the direct same-platform mode that omits `session_id` entirely;
- error text is explicit that shared-channel routing now requires an anchored reporting-channel reference.

The API remains the first hard gate before fanout publication.

### 12.3 Enrichment and task-daemon responsibilities

Publishers that already know the reporting channel must pass it forward instead of relying on downstream inference.

Required producers to emit explicit `context_ref`:

- Lark inbound resolution and enrichment for root and continuation tasks;
- Telegram inbound resolution and enrichment for root and continuation tasks;
- task-daemon final result publication;
- any synthetic failure or cleanup publication path;
- mirror publication paths.

## 13. Poller and Consumer Changes

### 13.1 Poller dispatch rules

Platform pollers should become thin contract enforcers rather than routing guessers.

Required behavior:

- a Lark poller should dispatch shared-channel events only when the event contract is Lark-addressed or when the event is direct same-platform Lark delivery;
- a Telegram poller should dispatch shared-channel events only when the event contract is Telegram-addressed or when the event is direct same-platform Telegram delivery;
- mirror dispatch must not rely solely on `task_source.source` because that reflects the origin message, not necessarily the intended fanout destination;
- pollers should reject or log malformed shared-channel events instead of silently reclassifying them.

### 13.2 Lark delivery

`LarkNotifier` and related notification code should resolve the destination primarily from `context_ref`.

Expected behavior:

- `context_ref.platform === 'lark'` means the event is explicitly addressed to Lark;
- `context_ref.platform === 'telegram'` is not a cue to infer a peer Lark destination through bridge rows or link fallback;
- source-addressed direct Lark events without `session_id` may still route from `task_source.message_id`;
- if a Lark-visible event is intended for the shared Lark channel, the publishing path must already have provided the Lark `context_ref`;
- platform-specific history repositories are used to load thread metadata and persist output, not to derive missing contract data;
- notifier-side fallback thread creation for malformed shared-channel results is out of scope for the new contract and should be removed or moved upstream.

### 13.3 Telegram delivery

`TelegramNotifier` follows the same rule:

- resolve topic destination from explicit Telegram `context_ref`;
- allow source-addressed direct Telegram events without `session_id` to route from `task_source`;
- use platform history and links to verify or persist state, not to invent a missing destination;
- do not infer Telegram routing via `session_bridges`, best-effort peer lookup, or notifier-side fallback topic creation when the contract is missing.

### 13.4 Dual-platform fanout

If a root session is attached to both Lark and Telegram, publishers should emit the distinct events needed for each reporting surface with the correct platform-specific `context_ref`.

This is the key architectural shift:

- a consumer should consume only the events addressed to its platform queue semantics;
- shared-channel duplication becomes an explicit publishing decision rather than a consumer-side inference trick.

### 13.5 Daemon composition roots

Removing bridge-era routing is not complete until process wiring is updated.

Required behavior:

- Lark and Telegram outbound daemon entrypoints stop importing `SessionBridgeRepository`;
- notifier constructors and dependency graphs reflect the post-bridge architecture;
- bootstrap code should fail fast if the configured schema version still exposes bridge-era assumptions.

## 14. Cleanup and GC

Cleanup and GC simplify after bridge removal.

They must delete:

- the root session and descendants;
- all `session_platform_links` for the deleted session set;
- all `lark_messages` / `telegram_messages` for the deleted session set;
- root-owned `lark_threads` / `telegram_threads` rows as appropriate.

They must not:

- query or delete `session_bridges`;
- depend on bridge rows for root resolution;
- retain special-case missing-table handling that only exists to tolerate bridge-era cleanup paths.

## 15. Migration Strategy

The rollout is a direct cutover.

Required order:

1. update task intake, inbound submitters, and publishers so emitted shared-channel work always carries explicit `context_ref`;
2. update API validation, poller dispatch logic, and consumer logic to enforce the stricter contract;
3. remove bridge-table usage from runtime code, including daemon bootstrap wiring and cleanup logic;
4. ship the schema migration that drops `session_bridges`;
5. remove bridge repository exports and tests.

Operational assumption:

- no mixed long-lived deployment where old producers emit bridge-era payloads against new hard-fail pollers or consumers.

## 16. Risks and Mitigations

### Risk 1: Missing `context_ref` breaks valid deliveries after cutover

Mitigation:

- tighten task intake and result API validation first;
- add explicit regression tests for every publishing path;
- treat contract violations as rollout blockers.

### Risk 2: Publishers emit only one platform context for dual-surface roots

Mitigation:

- make dual-platform fanout an explicit producer responsibility;
- test Lark and Telegram outputs separately rather than depending on notifier inference.

### Risk 3: Pollers still route mirror or shared-channel events by origin heuristics

Mitigation:

- add poller-level tests for mirror and lifecycle event dispatch;
- require platform dispatch to match explicit contract semantics.

### Risk 4: Root ownership drifts on platform rows

Mitigation:

- keep root-session ownership stable in history repositories;
- verify child-session outputs do not rewrite root ownership.

### Risk 5: Cleanup leaves platform-specific orphan rows

Mitigation:

- ensure cleanup and GC are defined entirely in terms of session subtree deletion and root-owned thread/topic rows.

### Risk 6: Plan misses build-breaking bridge imports outside notifiers

Mitigation:

- explicitly update daemon composition roots and shared exports as part of the bridge-removal task set.

## 17. Test Strategy

Required coverage:

- task intake rejects shared-channel work that omits `context_ref` where the contract requires it;
- result API validation rejects shared-channel `phase`, `result`, and `mirror` events that omit `context_ref`;
- publishers emit `context_ref` in all shared-channel event paths;
- pollers dispatch shared-channel and mirror events only according to the explicit platform contract;
- Lark and Telegram consumers route only from explicit `context_ref` for shared-channel delivery;
- daemon entrypoints no longer import or construct `SessionBridgeRepository`;
- bridge repository imports are gone from runtime code;
- migrated schema does not contain `session_bridges`;
- cleanup and GC succeed without bridge-table access.

## 18. Open Questions Resolved

- `session_bridges` is fully removed rather than retained as a derived cache.
- fanout is transport only, not routing authority.
- `context_ref` is required for shared-channel routing.
- missing `context_ref` is a hard failure.
- mirror remains its own event kind.
- fallback attachment materialization, if retained, happens before fanout publication rather than during notification.

## 19. Recommendation Summary

The correct simplification is not “replace the bridge table with the queue.”

The correct simplification is:

- delete the bridge table;
- keep durable routing truth in root-session and platform-link state;
- align task intake, publishers, pollers, and consumers around one explicit `context_ref` contract;
- make fanout a pure transport;
- make consumers reject malformed shared-channel events instead of inferring destinations.

That gives a smaller and stricter system without pushing durable routing responsibility into RabbitMQ.
