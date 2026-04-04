# Design: Strict FIFO Per-Session Job Queues

**Date:** 2026-04-04
**Status:** Draft
**Depends on:** Task/Job Queue Refactor (implemented), Concurrent Session Execution (implemented), Session Lock Queueing Fixes (implemented)

## Problem

The current execution model keeps all enriched jobs in one shared `jobs` queue. When the task daemon receives a job whose `session_id` is already busy, it NACKs and requeues that message. This preserves the "only one active command per session" rule, but it does not preserve strict FIFO for multiple waiting messages in the same session. RabbitMQ may redeliver requeued messages ahead of earlier same-session work, so commands in a single thread can execute out of order.

This is now a correctness bug because the product contract is stricter than the current implementation:

- every job for a given `session_id` must run in submission order;
- only one job in that session may execute at a time;
- this applies uniformly to all task types, including `cleanup`.

## Goals

1. Guarantee strict FIFO ordering for all enriched jobs sharing the same `session_id`.
2. Preserve current cross-session concurrency.
3. Keep the raw `tasks` queue and enrichment intake path unchanged.
4. Let idle per-session job queues disappear automatically after one hour.
5. Assume a single `task-daemon` instance only.

## Non-Goals

- Backward compatibility for jobs already sitting in the legacy shared `jobs` queue.
- Multi-daemon coordination or distributed queue ownership.
- Reworking result fanout topology.
- Adding new user-facing queue inspection endpoints in this feature.

## Approaches Considered

### Approach 1: Keep one shared jobs queue and add more daemon-side sequencing

This would keep today’s topology and try to enforce FIFO with sequence numbers plus local waiting logic.

Why not chosen:

- strict FIFO would still depend on daemon scheduling rather than broker ordering;
- same-session blocked jobs would still need reinsertion or local buffering;
- it adds complexity without removing the root cause.

### Approach 2: Per-session RabbitMQ queues behind a jobs exchange

Publish each enriched job to a session-specific queue, with queue-level FIFO handling the ordering guarantee.

Why chosen:

- RabbitMQ queue order becomes the source of truth for same-session FIFO;
- cross-session concurrency is preserved naturally by consuming multiple session queues concurrently;
- blocked-job NACK/requeue logic is no longer part of same-session ordering.

### Approach 3: One shared queue plus an API-managed persisted session scheduler

The API would persist waiting jobs by session and expose the next eligible job to the daemon.

Why not chosen:

- it moves broker responsibilities into application code;
- larger refactor than needed;
- more stateful and harder to reason about than queue-per-session routing.

## Chosen Design

### 1. Replace the single jobs queue with a jobs exchange plus per-session queues

**Files:**
- `packages/shared/src/constants.ts`
- `packages/api/src/services/rabbitmq.ts`
- `packages/api/src/routes/jobs.ts`

The API stops publishing enriched jobs directly to one durable `jobs` queue. Instead it owns a durable direct exchange, for example `jobs`.

For each `session_id`, the API asserts a queue derived from that session, for example `jobs.session.<session_id>`, with:

- durable queue;
- `x-expires = 3600000` (1 hour);
- binding to the jobs exchange using the `session_id` as the routing key.

Publishing flow:

1. `POST /jobs` accepts a normal `JobSubmission`.
2. The API derives the per-session queue name from `session_id`.
3. The API asserts/binds that queue if needed.
4. The API publishes the job to the jobs exchange with routing key = `session_id`.

This preserves the current separation of concerns: daemons still talk only to the HTTP API, and the API remains the sole owner of RabbitMQ topology.

### 2. Add explicit session-queue operations to the API’s RabbitMQ wrapper

**File:** `packages/api/src/services/rabbitmq.ts`

The current `RabbitMQService` has one global jobs delivery map because it assumes one queue. That no longer fits.

Add session-aware helpers such as:

- `ensureSessionJobQueue(sessionId)`
- `publishJobToSession(job)`
- `getNextJobFromSession(sessionId)`
- `ackJobFromSession(sessionId, jobId)`
- `nackJobFromSession(sessionId, jobId, requeue)` if needed

Delivery tracking must be per queue, not global, mirroring the existing `queueDeliveryMaps` used for results.

The old `getNextJob()` / `ackJob()` API can be removed or replaced by session-aware variants. No compatibility path is needed for legacy shared-queue jobs.

### 3. Introduce API-managed session activation for the single daemon

**Files:**
- `packages/api/src/routes/jobs.ts`
- `packages/daemon/task/src/task-daemon.ts`
- `packages/daemon/task/src/task-poller.ts` or a renamed scheduler/consumer manager

Per-session queues solve ordering, but the daemon still needs to know which queues to consume.

For this feature, the runtime assumption is one `task-daemon` instance, so we can keep discovery simple:

- when the API publishes a job to a session queue, it also records that session queue as active in memory;
- the daemon can query the API for active session queue identities;
- the daemon starts exactly one consumer per active session.

Suggested API contract:

- `GET /jobs/sessions` returns active session IDs or queue descriptors;
- optionally `POST /jobs/sessions/:sessionId/touch` is internal-only if the daemon needs explicit reactivation, but the preferred flow is that publish already activates it.

Because session identity is already part of the job payload and publish path, no separate durable registry is needed. The API’s in-memory active-session set only exists to expose currently known queues to the single daemon process.

### 4. Replace poll-and-lock logic with one consumer per active session queue

**Files:**
- `packages/daemon/task/src/task-poller.ts`
- `packages/daemon/task/src/task-daemon.ts`
- `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`

Today the daemon repeatedly polls `GET /jobs/next` and uses `SessionLockManager` to reject conflicting same-session work. Under the new model, strict FIFO is already enforced by the broker, so same-session requeueing should disappear from the hot path.

New daemon behavior:

1. Discover active session queues via the API.
2. For each active session, start exactly one long-lived consume loop (through the API, not direct RabbitMQ access).
3. Respect the existing global `MAX_CONCURRENT_SESSIONS` limit by capping how many session consumers are actively executing at once.
4. Within a session, consume one job at a time, execute it, publish the result, ACK it, then request the next job from the same session queue.
5. Keep the consumer attached while work remains; stop tracking it when the session goes idle or the queue disappears.

The daemon still needs a small in-memory map of active consumer handles, but not a durable session registry.

### 5. Session lock behavior becomes a safety net, not the ordering mechanism

**Files:**
- `packages/daemon/task/src/services/session-lock.ts`
- `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`

With one consumer per session queue, same-session contention should not happen in normal operation. The lock file should remain as a defensive invariant for workspace/session ownership, but the design no longer depends on NACKing same-session jobs to get serialization.

That means:

- same-session lock conflicts become unexpected and should be logged as internal errors;
- `cleanup` and normal jobs all use the same FIFO path;
- the current requeue-based ordering behavior is removed from the design contract.

### 6. Queue lifecycle uses idle expiry, not explicit delete

**Files:**
- `packages/shared/src/constants.ts`
- `packages/api/src/services/rabbitmq.ts`

Session queues should use a 1-hour idle expiration. No explicit delete-on-empty path is added.

Rationale:

- simple operational model;
- avoids empty-check races in application code;
- consistent with the user preference to let RabbitMQ clean up unused queues automatically.

### 7. Migration and rollout

No compatibility path is required.

Implementation can assume:

- the old shared `jobs` queue may be ignored;
- all new deployments publish only to per-session queues;
- tests and docs are updated to the new topology in one cutover.

## Data / API Shape Changes

### Shared constants

Add new shared constants for:

- jobs exchange name;
- per-session queue prefix;
- session queue idle TTL in milliseconds.

### Job route contract

`POST /jobs` request shape does not need new user-facing fields. `session_id` already exists and is the routing key.

Add an internal route to expose active sessions to the single daemon, for example:

```ts
GET /jobs/sessions
-> 200 { sessions: [{ session_id: string, queue_name: string }] }
```

## Testing Strategy

### API / RabbitMQ service

Add tests for:

- asserting the jobs exchange;
- asserting/binding a session queue with 1-hour expiry;
- publishing a job to the exchange using `session_id` as routing key;
- reading and ACKing jobs from a specific session queue;
- tracking deliveries independently across session queues.

### Job routes

Add tests for:

- `POST /jobs` publishes to the correct session queue;
- `GET /jobs/sessions` returns activated sessions;
- session activation is idempotent when multiple jobs arrive for the same session.

### Task daemon

Replace requeue-oriented concurrency tests with session-queue FIFO tests:

- two jobs for the same session are consumed/executed in order;
- `cleanup` does not bypass earlier queued jobs;
- jobs from different sessions still execute concurrently up to the configured limit;
- idle session consumer handles are removed when the queue is drained or unavailable.

### Regression coverage

Retain targeted `SessionLockManager` tests, but update expectations to reflect that lock collisions are now exceptional rather than normal scheduling behavior.

## Risks

1. API-managed session activation could become stale if the daemon or API restarts between publish and consumption.
Mitigation: keep the activation structure derived directly from job publish events and rebuildable on new publishes; single-daemon scope keeps this acceptable.

2. One long-lived consumer per active session could grow if many sessions spike briefly.
Mitigation: idle queues expire after one hour, and the daemon should close local handles when a session drains.

3. The design introduces more queue topology management in the API.
Mitigation: keep all RabbitMQ operations centralized in `RabbitMQService`, with explicit session-queue helpers and unit tests.

## Open Review Notes

The `design-and-plan` skill references external reviewer prompt files, but those prompt assets were not available in this workspace. This document therefore received a manual self-review instead of the prescribed foreground reviewer prompt.
