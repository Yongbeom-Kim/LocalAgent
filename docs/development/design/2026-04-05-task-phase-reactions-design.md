# Design: Task Phase Reactions for Lark Threads

**Date:** 2026-04-05
**Status:** Ready for implementation planning
**Depends on:** API-owned RabbitMQ topology, per-session job queues, Lark listener/result daemons, SQLite-backed Lark thread history

## Problem

The current Lark UX only exposes a single coarse-grained in-flight signal.

Today the flow is:

1. `lark-listener` receives a Lark message and submits a task.
2. `MessageHandler` currently adds one `OnIt` reaction to the source message.
3. `task-enrichment` rewrites or enriches the task with no user-visible progress signal.
4. `task-daemon` executes the job with no user-visible phase updates.
5. `lark-result` replies with the final text result and removes reactions.

This produces poor observability for users following a thread:

- the user cannot tell whether the task is still being enriched, merely queued, or actively executing;
- `/status` only reports whether the executor is running, which is narrower than the actual lifecycle;
- the reaction logic is currently Lark-specific and tied to task acceptance, so it does not provide a clean path for future channel-specific progress UX.

## Goal

Introduce an extensible task-phase model and use it to drive intermediate Lark reactions for the task lifecycle.

The feature should:

1. define a shared, channel-agnostic set of task phases;
2. emit phase transitions from the daemons that already own those lifecycle boundaries;
3. implement only the Lark reaction consumer in this first slice;
4. show intermediate reactions for all four in-flight phases;
5. clear **bot-owned phase reactions** before the final success or failure reply so there is no final-state reaction;
6. log and persist **Lark reaction update** failures for observability without blocking task execution.

## User Decisions

- The long-term design should be cross-channel and extensible, but this iteration only implements Lark reactions.
- Reactions are only for intermediate states. There is **no** final success/failure reaction.
- The intermediate states to show in V1 are all four lifecycle stages.
- The technical phase names are:
  - `received`
  - `enriching`
  - `queued`
  - `executing`
  - `completed`
- In runtime semantics, the user's earlier "waiting" phase maps to `queued`: the job has been enriched and published to a session queue but execution has not started yet.
- On task failure, the system should clear any intermediate reaction and rely on the normal reply text only.
- Phase emission is best-effort for UX, but failures should be logged. Persisted failure tracking in V1 applies to Lark reaction update attempts (not to every emitter publish failure).
- Reaction updates must not remove or mutate user reactions; only the bot’s own phase reactions should be added/removed.

## Non-Goals

- No Telegram implementation in this feature.
- No web UI or dashboard for task-phase timelines.
- No final success/failure emoji reactions.
- No durable reconciler that backfills missed reactions after process restart.
- No change to executor output formatting in the final reply beyond existing result content.
- No expansion of `/status` in this feature beyond what is already returned today.

## Existing Context

### 1. Lifecycle ownership is already distributed across daemons

The boundaries for the desired phases already exist, but they live in separate packages:

- `packages/daemon/lark-listener/src/message-handler.ts`
  - accepts inbound Lark messages and currently adds the first reaction;
- `packages/daemon/task-enrichment/src/enrichment-poller.ts`
  - dequeues raw tasks, performs thread lookup/routing, and publishes jobs;
- `packages/daemon/task/src/task-poller.ts`
  - dequeues per-session jobs and starts execution;
- `packages/daemon/lark-result/src/adapters/lark-notifier.ts`
  - sends the final reply and currently clears reactions after replying.

That means the design must coordinate phase ownership explicitly rather than inferring progress from one service.

### 2. Lark reaction logic is split across two services and is currently hardcoded

Current Lark-specific behavior:

- `LarkReactor.react(messageId)` always posts the `OnIt` emoji.
- `LarkNotifier.removeAllReactions(messageId, token)` clears all reactions after a successful thread reply (this will be removed/changed in V1; see below).

V1 change:

- the listener should stop writing reactions directly and instead emit `received`, letting the Lark phase consumer own all phase reaction updates.
- the result notifier should stop clearing all reactions; it should clear only bot-owned phase reactions.

There is no shared concept of a "current task phase", no mapping from lifecycle stages to reaction types, and no abstraction that another channel could subscribe to later.

### 3. The API already owns RabbitMQ topology and event fan-out patterns

`packages/api/src/services/rabbitmq.ts` already owns queue/exchange setup for:

- task submission;
- per-session job queues;
- result fan-out to Lark and Telegram consumers.

That existing architecture is the right integration point for a new task-phase event stream because it avoids direct RabbitMQ access from the daemons and preserves the current API-owned topology pattern.

### 4. SQLite history already stores outbound metadata for Lark threads

`packages/shared/src/db/lark-history-repository.ts` records outbound Lark messages with `metadataJson`, and `lark_messages` already stores event metadata such as `usage_reply`, `reply`, and `new_instance_reply`.

That gives this design a place to persist phase update attempts and failures without introducing a new observability store in V1.

## Approaches Considered

### Approach A: Shared phase enum with direct Lark updates from each daemon

Each daemon would import the shared phase names and call a Lark reaction helper directly when it crosses its boundary.

**Pros**

- Smallest code change to get visible progress.
- Minimal API and RabbitMQ expansion.

**Cons**

- Spreads Lark-specific behavior across multiple services.
- Future Telegram or UI consumers would require touching every emitter again.
- Harder to reason about phase consistency, retries, and observability.

### Approach B: Shared phase events with a centralized Lark phase consumer

Daemons emit channel-agnostic task-phase events through the API. A Lark-specific consumer maps the current phase to reactions and owns reaction cleanup.

**Pros**

- Clean extensibility boundary for future channels.
- One place owns Lark reaction semantics.
- Matches the existing API-owned messaging pattern.

**Cons**

- Adds one new message flow and consumer.
- Requires explicit phase-event contracts and routing keys.

### Approach C: Persist canonical phase state in SQLite and reconcile reactions from stored state

Each daemon would update canonical phase state in SQLite, and a separate reconciler would poll state and apply reactions.

**Pros**

- Strong recoverability and easy introspection.
- Useful if a later UI needs historical timelines.

**Cons**

- Slower visible updates.
- More operational and schema complexity than needed for the first slice.
- Introduces a state reconciler before the event contract is proven.

## Recommended Approach

Adopt **Approach B**.

Use a shared task-phase event contract carried through the existing API/RabbitMQ boundary, then implement a Lark-specific consumer that converts those events into reactions.

This keeps the domain model channel-agnostic while limiting V1 implementation to the Lark path. It also preserves an obvious upgrade path for Telegram or a future web UI without revisiting every daemon.

## Design

### 1. Shared phase model

Add a task-phase contract in `@local-agent/shared`.

Recommended types:

```ts
export const TASK_PHASES = ['received', 'enriching', 'queued', 'executing', 'completed'] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

export interface TaskPhaseEvent {
  event_id: string;
  task_id: string;
  session_id?: string;
  task_type: string;
  phase: TaskPhase;
  emitted_at: string;
  task_source?: TaskSource;
  executor?: TaskExecutorType;
  executor_model?: string;
  metadata?: {
    thread_id?: string;
    emitted_by: 'lark-listener' | 'task-enrichment' | 'task-daemon';
    note?: string;
  };
}
```

Key points:

- `completed` is part of the shared model even though Lark does not show a final reaction.
- The event contract is channel-agnostic; it does not mention emoji or Lark message APIs.
- `task_source` remains the link that lets a channel-specific consumer determine whether the event applies to that channel.
- For Lark-sourced tasks, `task_source` must be present and must include the `message_id` of the source message to react on.

### 2. Phase ownership and exact emission points

Each phase should be emitted by the daemon that already owns the lifecycle boundary.

| Phase | Emitter | Emission point |
|-------|---------|----------------|
| `received` | `lark-listener` | After successful task submission from the inbound Lark message (and **instead of** directly adding an `OnIt` reaction in the listener) |
| `enriching` | `task-enrichment` | After dequeuing a task and deciding it will be processed rather than rejected |
| `queued` | `task-enrichment` | After `POST /jobs` succeeds |
| `executing` | `task-daemon` | After immediate job ACK succeeds and just before executor orchestration begins |
| `completed` | `task-daemon` and `task-enrichment` | When a terminal result is published to the existing results flow (success or failure). `task-daemon` emits for jobs; `task-enrichment` emits for enrichment-time rejections that never become jobs. |

Design note:

- `completed` is emitted for both success and failure terminal results. The outcome itself remains in the existing result payload.
- Lark reaction cleanup must not depend on the `completed` event arriving “before” the reply (see terminal flow), because phase consumption is asynchronous and may lag.

### 3. Generalize the existing results exchange and routes into a task-event transport

Refactor the existing results fanout exchange/queue flow into a generalized task-event transport instead of introducing a parallel phase-specific stream.

Recommended topology:

- reuse the existing `results` fanout exchange as the transport for both terminal result events and intermediate phase events;
- reuse the existing Lark-bound consumer queue rather than creating a separate `lark-task-phases` queue;
- future consumers can subscribe to the same transport and branch on event kind.

API changes:

- refactor the existing `/results` publish/poll/ack contract so it carries a discriminated `TaskEvent` union rather than only terminal `TaskResult` payloads;
- phase emitters publish `TaskPhaseEventSubmission` through that existing transport;
- consumers poll the same queue and branch on `event_kind` (`phase` vs `result`).

This deliberately reuses the existing results transport so phase updates become part of the same task-lifecycle event backbone instead of creating a second parallel pipeline.

`TaskPhaseEventSubmission` (V1) is the phase-event payload without server-assigned fields. It is carried inside the generalized results transport as `event_kind: "phase"`:

```ts
export interface TaskPhaseEventSubmission {
  task_id: string;
  session_id?: string;
  task_type: string;
  phase: TaskPhase;
  task_source?: TaskSource;
  executor?: TaskExecutorType;
  executor_model?: string;
  metadata?: {
    thread_id?: string;
    emitted_by: 'lark-listener' | 'task-enrichment' | 'task-daemon';
    note?: string;
  };
}
```

### 4. Lark-specific phase consumer

Add a new consumer path inside the Lark side of the system that reads phase events from the existing Lark-bound results queue and applies reactions.

Refactor the existing Lark result consumer so it reads the generalized task-event stream from the existing Lark queue and applies either phase reactions or final replies based on `event_kind`.

Two viable placements were considered:

- add phase polling to `packages/daemon/lark-result`
- create a new small `packages/daemon/lark-phase`

Recommendation: keep V1 inside `packages/daemon/lark-result` as a second poller.

Why:

- the package already owns Lark outbound API credentials;
- it already contains best-effort reaction cleanup logic;
- it avoids introducing an additional deployable service before the event contract is proven.

Suggested internal split:

- `lark-poller.ts`
  - continues polling the existing Lark queue from `/results/next/:queueName`
  - dispatches `phase` events to a phase notifier and `result` events to the existing final notifier
  - ACKs deliveries after processing
- `adapters/lark-phase-notifier.ts`
  - maps `TaskPhaseEvent` to reaction behavior
  - owns remove/replace semantics
- `phase-reaction-mapper.ts`
  - centralizes phase-to-emoji mapping

### 5. Reaction semantics in Lark

Lark behavior should be intentionally simple:

1. For `received`, `enriching`, `queued`, and `executing`, show exactly one current bot reaction on the source message.
2. Before adding the new intermediate reaction, remove any existing **bot-owned phase reaction** previously applied by this feature.
3. For `completed`, remove any existing **bot-owned phase reaction** and do not add a replacement.
4. If the source is not Lark, the event is ignored by the Lark consumer.

“Source message” definition (V1):

- the Lark phase consumer applies reactions to `task_source.message_id`.

Implementation constraint:

- “Remove bot-owned phase reaction” means: remove only reactions in the configured phase-emoji set (e.g. `OnIt`, `Eye`, `Hourglass`, `Runner`) that were added by the bot, without removing user reactions.
- Implementation must use a Lark API call that removes a reaction for the bot actor (the bot token / operator context), not a blanket “remove all reactions” call. If our current Lark SDK wrapper cannot do bot-scoped reaction removal, V1 must first add that capability; do not ship a version that risks deleting user reactions.

This yields a single current-state indicator without a visible timeline.

### 6. Recommended intermediate naming and emoji mapping

Keep the shared names technical and stable, then map them to Lark emoji locally.

Suggested V1 mapping:

| Phase | Lark reaction |
|-------|---------------|
| `received` | `OnIt` |
| `enriching` | `Eye` |
| `queued` | `Hourglass` |
| `executing` | `Runner` |
| `completed` | no reaction |

The exact emoji names should be confirmed against what the bot is allowed to use in the workspace. If one of the suggested emoji types is unavailable, the implementation should substitute a supported equivalent without changing the shared phase names.

Important separation:

- phase names are part of the shared contract;
- emoji selection is a Lark adapter detail.

### 7. Best-effort failure handling with persisted observability

Phase emission and Lark reaction updates are best-effort side effects.

Desired behavior:

- if a phase event cannot be published, log a warning with the task/session identifiers and continue the main flow;
- if the Lark consumer cannot apply or clear a reaction, log a warning, optionally retry using the existing in-process retry pattern, then ACK or drop according to the same best-effort philosophy used for final notifications;
- record outbound Lark phase reaction attempts (success and failure) in `lark_messages.metadataJson` using the `phase_reactions` structure below.

This satisfies the user requirement that failures be visible for debugging without turning reaction updates into workflow blockers.

Persistence detail (V1):

- Record a compact structured object in `metadataJson`, keyed by a stable namespace, for example:

```json
{
  "phase_reactions": {
    "last": { "phase": "queued", "applied_at": "2026-04-05T12:34:56.000Z", "event_id": "..." },
    "attempts": [
      { "phase": "queued", "action": "set", "ok": true, "at": "...", "event_id": "..." },
      { "phase": "executing", "action": "set", "ok": false, "at": "...", "event_id": "...", "error": "..." }
    ]
  }
}
```

- Cap `attempts` growth (e.g. keep last N=20) to avoid unbounded metadata.

### 8. Relationship to final result replies

The final result path stays text-first.

Updated terminal flow for Lark-sourced tasks:

1. the result exists;
2. `LarkNotifier` synchronously clears any bot-owned phase reaction (best-effort) **before** posting the final text reply;
3. `LarkNotifier` posts the existing text reply;
4. there is no final reaction.

Separately (best-effort):

- `task-daemon` emits `completed` into the same generalized results transport when publishing the final result so other (future) consumers can react, and so the Lark consumer can converge if it was behind.

Implementation note:

To avoid duplicate cleanup logic, the phase-reaction cleanup helper used by the final reply path should be reusable by the Lark phase poller. This helper must clear only bot-owned phase reactions (not all reactions on the message).

As part of V1, the existing `LarkNotifier.removeAllReactions(...)` behavior should be replaced or constrained so the system no longer attempts to clear all reactions on the source message as a side effect of replying.

### 9. Interaction with rejections and thread-only command failures

Rejected tasks published directly from `task-enrichment` already flow through the results path without becoming jobs.

For V1:

- `received` may already have been emitted by `lark-listener`;
- if enrichment rejects the task, `task-enrichment` should emit `completed` when it publishes the rejection result (since no `task-daemon` job will exist);
- there is no need for a distinct `rejected` phase because the user explicitly does not want final-state reactions.

### 10. Idempotency and ordering

The design does not require exactly-once phase application.

Expected guarantees:

- consumers are best-effort and may see duplicate deliveries after reconnects;
- applying the same phase twice should be harmless because the Lark adapter always clears and re-adds the current reaction;
- phase ordering should normally be monotonic because the emitters follow the existing pipeline order, but the implementation should ignore impossible regressions if they arrive late.

Recommended simple guard:

V1 scope: rely on idempotent “remove bot phase reaction then add current” semantics, plus a small in-memory guard (per `task_source.message_id`) inside the refactored Lark poller to ignore obvious regressions within a short TTL window.

If flicker becomes a real problem, upgrade to a persisted monotonic guard using the `metadataJson` structure above (or a dedicated DB field) in a follow-up iteration.

This is lightweight insurance against duplicate or delayed deliveries without needing a durable reconciler.

## Files Expected to Change

| File | Change |
|------|--------|
| `packages/shared/src/types.ts` | Add shared phase constants/types and phase event interfaces |
| `packages/shared/src/constants.ts` | Add queue/exchange constants for task phases |
| `packages/shared/src/index.ts` | Export new shared phase types/constants |
| `packages/api/src/services/rabbitmq.ts` | Refactor the existing results exchange/queue contract so it carries discriminated task events while preserving current queue ownership and polling/ACK behavior |
| `packages/api/src/routes/results.ts` | Generalize the existing results route contract from terminal results to discriminated task events |
| `packages/api/src/app.ts` | Keep the existing results route wired while its contract is generalized |
| `packages/api/src/__tests__/routes/results.test.ts` | Route coverage for generalized task-event publish/poll/ack behavior |
| `packages/daemon/lark-listener/src/message-handler.ts` | Emit `received` phase after successful submission and remove the direct `OnIt` reaction side-effect |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Emit `enriching`, `queued`, and `completed` on rejection |
| `packages/daemon/task/src/task-poller.ts` | Emit `executing` before orchestration |
| `packages/daemon/lark-result/src/*` | Refactor the existing Lark result poller to handle both phase and terminal events, plus update final reply cleanup to clear only bot-owned phase reactions |
| `packages/shared/src/db/lark-history-repository.ts` | Record phase reaction metadata (`phase_reactions.last` and bounded `phase_reactions.attempts`) in `metadataJson` |
| `packages/shared/src/db/schema.ts` and migrator files | No DB schema changes required for V1 (avoid persisted monotonic guard) |

## Risks and Mitigations

### Risk 1: Duplicate or out-of-order phase deliveries cause reaction flicker

**Mitigation:** in V1, keep a small in-memory monotonic guard (per `task_source.message_id`, short TTL) in the Lark phase poller to ignore obvious regressions.

### Risk 2: Emoji names differ across Lark workspaces

**Mitigation:** isolate emoji mapping in one adapter and treat exact emoji choice as configuration-level implementation detail.

### Risk 3: Phase events fail silently and observability stays poor

**Mitigation:** log structured warnings and persist phase-update metadata/failures in Lark history rows.

### Risk 4: Terminal cleanup races with the final reply

**Mitigation:** reuse one cleanup helper and keep the terminal path simple: clear reactions, then send the reply. Because there is no final reaction, a short gap is acceptable.

## Test Strategy

### Unit tests

- shared type validation and helper tests for phase names/order
- API route tests for generalized `/results` task-event publish/poll/ack behavior
- emitter tests in listener/enrichment/task pollers asserting the right phase is published at the right point
- Lark phase notifier tests for:
  - adding the correct reaction per phase
  - replacing a prior reaction
  - clearing reactions on `completed`
  - ignoring non-Lark sources
  - logging/persisting failures

### Integration-style tests within existing daemon suites

- a Lark task that is accepted, enriched, queued, executed, and completed produces the expected sequence of phase publish calls
- an enrichment rejection emits `completed` cleanup and still posts the normal rejection reply

## Transport Refactor Note

The review feedback requested reuse of the existing result exchange/queue rather than introducing a second task-phase stream. This design therefore treats phase updates as another task-lifecycle event carried by the refactored results transport. A later cleanup can rename the route/exchange from `results` to something more neutral, such as `task-events`, if the team wants semantics to match the broader payload contract.

## Open Implementation Choices Intentionally Deferred

- whether a later iteration upgrades the in-memory monotonic guard to a persisted guard (via `metadataJson` or a dedicated DB field) if reaction flicker becomes a real problem;
- whether the Lark phase consumer lives permanently inside `lark-result` or is split into its own daemon later;
- whether emoji mapping becomes config-driven in a later iteration.

These do not block the current feature because the shared event contract and Lark adapter boundary remain valid under either choice.
