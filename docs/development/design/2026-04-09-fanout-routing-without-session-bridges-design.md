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
- cleanup and GC still carry bridge-specific deletion branches.

The user wants to simplify the architecture by removing the bridging table and relying on the existing fanout queue model rather than maintaining redundant pairing state.

## 2. Goal

Remove `session_bridges` and simplify shared-channel routing so fanout remains the transport layer while explicit reporting-channel context becomes the contract boundary.

After this feature:

1. `session_bridges` no longer exists in schema or runtime code;
2. root-session ownership plus `session_platform_links` becomes the only persistent routing model;
3. fanout remains the delivery transport for phase, result, and mirror events;
4. every shared-channel event that expects Lark or Telegram delivery carries explicit `context_ref`;
5. result consumers hard-fail shared-channel routing when required `context_ref` is missing;
6. mirror remains a distinct event kind rather than being folded into phase/result;
7. cleanup and GC delete sessions, links, and per-platform history without any bridge-table path;
8. the overall routing model is easier to reason about because transport and persistence responsibilities are separated.

## 3. Non-Goals

- No redesign of RabbitMQ topology beyond the contract changes needed for routing.
- No replacement of fanout with topic-routing or per-destination exchanges.
- No introduction of a new generic `reporting_channels` table.
- No attempt to preserve backward compatibility for shared-channel events that omit `context_ref` after the cutover ships.
- No folding of mirror into phase/result payload semantics.
- No change to session execution identity, queue isolation, or workspace lifecycle.

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

### 5.3 The bridge table is now mostly a notifier fallback

Current implemented behavior:

- `session_bridges` is primarily referenced in `lark-result`, `telegram-outbound`, and cleanup/GC flows;
- `POST /results` publishes fanout events with optional `context_ref` for phase/result and no `context_ref` for mirror;
- result consumers currently compensate for missing routing anchors by inferring from `session_id`, `task_source`, platform history, and bridge rows.

This makes shared-channel delivery more implicit than it needs to be.

## 6. Scope Assessment

This is one coherent subsystem.

It spans:

- shared event contracts;
- API validation for fanout event submission;
- enrichment and task-daemon publishing responsibilities;
- Lark and Telegram result delivery;
- shared schema and repositories;
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

- Requires coordinated updates across publishers and consumers.
- A direct cutover means older event payloads must be eliminated before deployment.

### Approach B: Delete `session_bridges` but preserve consumer-side fallback inference

Remove the table, but let consumers keep guessing from `session_id`, `task_source`, and platform state when `context_ref` is absent.

**Pros**

- Smaller payload-surface change.
- Fewer API validation updates.

**Cons**

- Leaves the hardest part of the architecture implicit.
- Preserves the same class of routing ambiguity the bridge table was previously masking.
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
- fanout transports events;
- `context_ref` explicitly tells consumers which reporting channel an event is for.

This removes the redundant bridge layer without making the queue responsible for durable routing state.

## 9. Design Overview

### 9.1 Core invariants

V1 codifies these invariants:

1. A shared reporting channel still has exactly one root session per platform row.
2. Cross-platform pairing is derived from the root session's active platform links, not stored in `session_bridges`.
3. Fanout is transport only; it never becomes the durable source of routing truth.
4. Any phase/result/mirror event intended for shared-channel delivery must carry `context_ref`.
5. Consumers hard-fail shared-channel delivery when the event contract is violated.
6. Mirror remains semantically distinct from phase/result.
7. Per-platform thread/topic rows preserve root ownership even when child sessions emit output.
8. Cleanup and GC operate on session trees, platform links, and platform history only.

### 9.2 High-level architecture

```text
task / mirror producer
  -> emits fanout event with explicit context_ref
  -> API validates event contract
  -> RabbitMQ fanout exchange transports event

Lark consumer / Telegram consumer
  -> read event from platform queue
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
- no cleanup or GC deletion branch for bridge rows;
- any previous lookup of “peer platform by session id” must instead resolve via root session and `session_platform_links`.

### 10.2 Keep root-session ownership on platform tables

`lark_threads.root_session_id` and `telegram_threads.root_session_id` remain the canonical root-channel ownership fields.

Required semantics:

- root ownership is stable after materialization;
- child-session output must not rewrite the root owner;
- platform rows provide metadata for delivery and cleanup, not cross-platform pairing state.

### 10.3 Keep `session_platform_links` as the attachment table

`session_platform_links` becomes the only session-to-channel attachment abstraction.

Required semantics:

- each session may have at most one link per platform;
- multiple sessions may attach to the same reporting channel where the broader shared-channel design permits it;
- root session links provide the derived cross-platform pairing after bridge-table removal.

## 11. Event Contract Changes

### 11.1 Shared-channel events must carry `context_ref`

For `phase`, `result`, and `mirror` events:

- if the event is intended for shared-channel delivery, `context_ref` is required;
- `context_ref.platform` identifies the reporting platform anchor;
- `context_ref.root_key` identifies the platform-specific root reporting-channel key.

Interpretation:

- for Lark, `root_key` is the Lark root message id;
- for Telegram, `root_key` is the Telegram external thread key (`chat_id:topic_id`).

### 11.2 Hard failure on contract violation

Consumers must not silently infer shared-channel routing when `context_ref` is missing.

Expected behavior:

- invalid events are rejected at the API boundary whenever possible;
- if an invalid event reaches a consumer, the consumer should log and fail the delivery path instead of guessing.

This is deliberate. The purpose of the cutover is to eliminate implicit routing behavior.

### 11.3 Mirror remains distinct

Mirror events keep their own event kind because they represent user-authored cross-channel replication rather than task lifecycle output.

Required behavior:

- mirror payloads gain `context_ref` for deterministic destination resolution;
- loop prevention remains keyed by origin message identity and mirror metadata;
- mirror is not folded into result or phase semantics.

## 12. Publisher Changes

### 12.1 API validation

`POST /results` must be tightened so that:

- `phase` submissions that target shared-channel delivery require valid `context_ref`;
- `result` submissions that target shared-channel delivery require valid `context_ref`;
- `mirror` submissions require valid `context_ref`.

The API remains the first hard gate before fanout publication.

### 12.2 Enrichment and task daemon responsibilities

Publishers that already know the reporting channel must pass it forward instead of relying on downstream inference.

Required producers to emit explicit `context_ref`:

- Lark inbound resolution and enrichment for root and continuation tasks;
- Telegram inbound resolution and enrichment for root and continuation tasks;
- task-daemon final result publication;
- any synthetic failure or cleanup publication path;
- mirror publication paths.

### 12.3 CLI and internal submission surfaces

Internal and CLI submission surfaces should align with the stricter contract:

- explicit child-session work continues to accept separate `session_id` and `context_ref`;
- work intended to report into a shared channel must provide `context_ref` at submission time so the execution path can preserve it through to the result event.

## 13. Consumer Changes

### 13.1 Lark delivery

`LarkNotifier` and related polling code should resolve the destination primarily from `context_ref`.

Expected behavior:

- `context_ref.platform === 'lark'` means direct Lark routing;
- `context_ref.platform === 'telegram'` is not a cue to infer a peer Lark destination through bridge rows;
- if a Lark-visible event is intended for the shared Lark channel, the publishing path must already have provided the Lark `context_ref`;
- platform-specific history repositories are used to load thread metadata and persist output, not to derive missing contract data.

### 13.2 Telegram delivery

`TelegramNotifier` follows the same rule:

- resolve topic destination from explicit Telegram `context_ref`;
- use platform history and links to verify/persist state;
- do not infer Telegram routing via `session_bridges` or best-effort peer lookup when the contract is missing.

### 13.3 Dual-platform fanout

If a root session is attached to both Lark and Telegram, publishers should emit the distinct events needed for each reporting surface with the correct platform-specific `context_ref`.

This is the key architectural shift:

- a consumer should consume only the events addressed to its platform queue semantics;
- shared-channel duplication becomes an explicit publishing decision rather than a consumer-side inference trick.

## 14. Cleanup and GC

Cleanup and GC simplify after bridge removal.

They must delete:

- the root session and descendants;
- all `session_platform_links` for the deleted session set;
- all `lark_messages` / `telegram_messages` for the deleted session set;
- root-owned `lark_threads` / `telegram_threads` rows as appropriate.

They must not:

- query or delete `session_bridges`;
- depend on bridge rows for root resolution.

## 15. Migration Strategy

The rollout is a direct cutover.

Required order:

1. update publishers so emitted events include explicit `context_ref` for shared-channel routing;
2. update API validation and consumer logic to enforce the stricter contract;
3. remove bridge-table usage from runtime code;
4. ship the schema migration that drops `session_bridges`;
5. remove bridge repository exports and tests.

Operational assumption:

- no mixed long-lived deployment where old producers emit bridge-era payloads against new hard-fail consumers.

## 16. Risks and Mitigations

### Risk 1: Missing `context_ref` breaks valid deliveries after cutover

Mitigation:

- tighten API validation first;
- add explicit regression tests for every publishing path;
- treat contract violations as rollout blockers.

### Risk 2: Publishers emit only one platform context for dual-surface roots

Mitigation:

- make dual-platform fanout an explicit producer responsibility;
- test Lark and Telegram outputs separately rather than depending on notifier inference.

### Risk 3: Root ownership drifts on platform rows

Mitigation:

- keep root-session ownership stable in history repositories;
- verify child-session outputs do not rewrite root ownership.

### Risk 4: Cleanup leaves platform-specific orphan rows

Mitigation:

- ensure cleanup and GC are defined entirely in terms of session subtree deletion and root-owned thread/topic rows.

## 17. Test Strategy

Required coverage:

- API route validation rejects shared-channel `phase`, `result`, and `mirror` events that omit `context_ref`;
- publishers emit `context_ref` in all shared-channel event paths;
- Lark and Telegram result consumers route only from explicit `context_ref`;
- bridge repository imports are gone;
- migrated schema does not contain `session_bridges`;
- cleanup and GC succeed without bridge-table access.

## 18. Open Questions Resolved

- `session_bridges` is fully removed rather than retained as a derived cache.
- fanout is transport only, not routing authority.
- `context_ref` is required for shared-channel routing.
- missing `context_ref` is a hard failure.
- mirror remains its own event kind.

## 19. Recommendation Summary

The correct simplification is not “replace the bridge table with the queue.”

The correct simplification is:

- delete the bridge table;
- keep durable routing truth in root-session and platform-link state;
- make fanout a pure transport;
- make `context_ref` the explicit reporting-channel contract.

That gives a smaller and stricter system without pushing durable routing responsibility into RabbitMQ.
