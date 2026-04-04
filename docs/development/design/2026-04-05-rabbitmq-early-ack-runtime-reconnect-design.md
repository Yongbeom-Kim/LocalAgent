# Design: RabbitMQ Early Job ACK and API Runtime Reconnect Recovery

**Date:** 2026-04-05
**Status:** Ready for implementation planning
**Depends on:** Per-session job queues, API-owned RabbitMQ topology setup, task-daemon HTTP polling flow

## Problem

Long-running jobs currently keep the original RabbitMQ delivery unacknowledged for the full execution lifetime.

Today the flow is:

1. task-daemon calls `GET /jobs/next/:sessionId`;
2. API reads a job from RabbitMQ and keeps the delivery open in memory;
3. task-daemon executes the job;
4. task-daemon posts `/results`;
5. task-daemon calls `/jobs/:sessionId/:id/ack`.

That creates two operational problems:

1. **consumer ACK timeout risk:** long-running jobs can exceed RabbitMQ's delivery ACK timeout, which causes RabbitMQ to close the channel;
2. **fragile API broker session:** when RabbitMQ closes the channel or connection, the API currently nulls its references but does not rebuild them, so subsequent publish/get calls fail until process restart.

## Goal

Make job execution resilient to long runtimes and routine RabbitMQ disconnects by:

1. acknowledging session-job deliveries as soon as the task-daemon accepts them from the API;
2. adding API-side runtime reconnect logic that recreates the RabbitMQ connection/channel on demand when requests hit a dead broker session;
3. ensuring concurrent API requests share the same reconnect attempt instead of racing;
4. returning temporary `503` responses when the API cannot re-establish RabbitMQ access in time.

## User Decisions

- Job execution becomes **fire-and-forget after fetch**. Once the task-daemon receives a job from `/jobs/next/:sessionId`, the system may ACK the broker delivery immediately rather than waiting for execution completion.
- Execution outcome is still reported back to the user through the existing result exchange.
- The reconnect scope is limited to the API package's existing `RabbitMQService`.
- Runtime recovery should happen **when the API receives a RabbitMQ-dependent request**, not via an always-on background retry loop.
- When multiple requests arrive during broker recovery, they should wait on the **same shared reconnect attempt**.
- If reconnect does not succeed for that request path, the API should return `503`.
- Startup behavior should stay as-is. The existing initial connect loop remains; only runtime recovery changes in this feature.
- If a channel dies after a message has already been returned to a client but before the later ACK endpoint is called, that trade-off is acceptable. The design should document the redelivery/idempotency implications clearly.

## Non-Goals

- Adding a new durable handoff store between API dequeue and daemon execution.
- Retrying failed job execution by reconstructing jobs after early ACK.
- Refactoring daemons to use RabbitMQ directly or to share a reconnect helper in this iteration.
- Changing result-exchange topology or notification-daemon architecture.
- Replacing the startup-time RabbitMQ connect loop in `packages/api/src/index.ts`.

## Existing Context

### 1. The API owns RabbitMQ topology and in-memory delivery tracking

`packages/api/src/services/rabbitmq.ts` is the single RabbitMQ abstraction used by API routes. It creates the connection/channel, asserts queues/exchanges, and stores outstanding deliveries in memory so later HTTP ACK endpoints can call `channel.ack(...)` or `channel.nack(...)`.

Relevant current state:

- `getNextJobFromSession(sessionId)` uses `channel.get(queueName, { noAck: false })`, stores the message in `queueDeliveryMaps`, and returns the parsed `Job`.
- `ackJobFromSession(sessionId, jobId)` and `nackJobFromSession(...)` later look up that in-memory delivery.
- `connection.on('error' | 'close')` only clears `this.connection` and `this.channel`; it does not reconnect.

### 2. The task-daemon currently ACKs jobs after execution and result publish attempt

`packages/daemon/task/src/task-poller.ts` currently:

1. fetches active sessions;
2. fetches the next job for one session;
3. executes the job via `TaskOrchestrator`;
4. posts `/results`;
5. finally calls `/jobs/:sessionId/:id/ack`.

This means RabbitMQ delivery lifetime is coupled to execution duration.

### 3. API handlers currently fail by exception when RabbitMQ is disconnected

Most RabbitMQ entry points throw `Error('Not connected')` when `this.channel` is null. Route handlers do not special-case that condition, so requests fall through to the generic Express error middleware and become `500` responses instead of a temporary-unavailable contract.

## Approaches Considered

### Approach 1: ACK immediately in the daemon after fetch, add API runtime reconnect-on-demand

Flow:

1. `GET /jobs/next/:sessionId` still dequeues a RabbitMQ message with manual ACK semantics.
2. task-daemon immediately calls `/jobs/:sessionId/:id/ack` before execution.
3. if execution later fails, task-daemon still posts a failure result to `/results`.
4. API-side RabbitMQ operations call a shared "ensure connected" path that can perform a single in-flight reconnect attempt.

**Why chosen:**

- directly solves the ACK-timeout problem without changing topology;
- keeps the change localized to existing API + task-daemon code paths;
- preserves current result-reporting behavior for success/failure;
- minimizes moving parts compared with durable handoff or background reconnect loops.

### Approach 2: ACK inside the API before returning `/jobs/next/:sessionId`

Flow:

- the API would ACK the RabbitMQ message before returning the HTTP response body.

**Why not chosen:**

- if the HTTP response fails after the ACK but before the daemon receives the payload, the job is lost without even being accepted by the worker;
- it weakens the handoff boundary too much by treating API dequeue as worker acceptance.

### Approach 3: Keep late ACK, but add a 60-second delayed ACK heuristic

Flow:

- hold the broker delivery open briefly, ACK only after a grace window or successful process start.

**Why not chosen:**

- it still retains a timeout-sensitive open delivery window;
- it adds timer/state complexity without eliminating the core channel-timeout class;
- the user explicitly reverted to fire-and-forget ACK.

## Design

### 1. Early ACK becomes the task-daemon's acceptance contract

The acceptance boundary moves from "execution finished" to "task-daemon successfully received the job payload from the API and accepted responsibility for executing it."

Revised job flow:

1. task-daemon calls `GET /jobs/next/:sessionId`;
2. API returns the next job and keeps the RabbitMQ delivery in memory, exactly as today;
3. task-daemon immediately calls `POST /jobs/:sessionId/:id/ack`;
4. only after that ACK succeeds does the daemon proceed with execution;
5. execution outcome is posted to `/results` as success or failure;
6. there is no later `/jobs/.../ack` call at the end of execution.

This removes long-running executions from RabbitMQ's delivery-timeout path.

#### Failure handling at the new boundary

- If `GET /jobs/next/:sessionId` returns `204`, nothing changes.
- If immediate ACK succeeds, the job is considered accepted even if execution later fails.
- If execution later fails, the daemon still posts a failure result through `/results` so the user sees the failure.
- If immediate ACK fails, the daemon must **not execute the job**. It should log the failure, release session bookkeeping, and rely on the broker/API state for later redelivery or re-fetch.

That last point is important: once ACK becomes the acceptance handshake, execution must not start unless the handshake completed.

### 2. Late job ACK endpoint remains because the API still needs a manual ACK boundary

The `/jobs/:sessionId/:id/ack` route stays, but its caller timing changes.

The API still needs to:

- fetch with `noAck: false`;
- remember the delivery until the daemon confirms acceptance;
- ACK the exact delivery on the later HTTP request.

The change is therefore behavioral, not topological: the ACK endpoint stays, but the daemon calls it immediately instead of after execution.

### 3. `RabbitMQService` gains an on-demand reconnect gate

`RabbitMQService` should own a single reconnection coordinator so all RabbitMQ-dependent operations can safely ask for a usable channel.

Recommended state additions:

- `private reconnectPromise: Promise<void> | null = null;`
- `private closing = false;`
- `private connectionGeneration = 0;` or equivalent generation token used to invalidate stale deliveries after reconnect

Recommended public helper:

```ts
async ensureConnected(): Promise<boolean>
```

Behavior:

1. If a live connection/channel already exists, return `true` immediately.
2. If the service is closing, return `false`.
3. If no reconnect is in progress, create one shared `reconnectPromise` that:
   - opens a fresh AMQP connection;
   - attaches `error` and `close` listeners;
   - creates a fresh channel;
   - re-asserts all API-owned queues/exchanges/bindings;
   - swaps `this.connection` and `this.channel` atomically only after setup succeeds;
   - clears stale in-memory delivery bookkeeping that is no longer safe across channel generations;
   - finally clears `reconnectPromise`.
4. If another request arrives while reconnect is in progress, it awaits the same `reconnectPromise`.
5. If reconnect succeeds, the caller retries its broker operation on the new channel.
6. If reconnect fails, the caller returns a temporary-unavailable outcome to the route layer.

This keeps reconnect request-driven and race-free.

#### Method signature impact

Because reconnect is request-driven and may require awaiting a fresh AMQP connection/channel, RabbitMQ publish methods that are currently synchronous must become asynchronous.

Specifically:

- `publish(task)` becomes `async publish(task): Promise<boolean>`
- `publishToExchange(exchange, result)` becomes `async publishToExchange(...): Promise<boolean>`

That allows API routes such as `POST /tasks` and `POST /results` to wait briefly for a shared reconnect attempt before deciding whether to return `201` or `503`.

ACK/NACK helpers do not need the same async reconnect behavior because they must not attempt to reuse stale deliveries on a replacement channel.

### 4. Reconnect is triggered by broker operations, not by a perpetual background loop

The current startup connect loop in `packages/api/src/index.ts` remains unchanged.

At runtime, the new contract is:

- route handlers call RabbitMQ service methods;
- service methods first ensure a usable channel exists;
- if the channel was torn down by RabbitMQ, the first request that needs RabbitMQ starts reconnect;
- concurrent requests wait on the same reconnect promise;
- requests either proceed on the fresh channel or receive a failure that routes translate to `503`.

The user explicitly does not want a budget-heavy background retry scheme here. The request path drives recovery.

### 5. RabbitMQ operation methods retry once through `ensureConnected`

Each broker-facing method in `RabbitMQService` should follow one of two patterns.

#### Pattern A: publish/get methods

Methods such as:

- `publish`
- `publishJob`
- `getNext`
- `getNextJobFromSession`
- `publishToExchange`
- `getNextFromQueue`
- `ensureSessionJobQueue`

should:

1. call `ensureConnected()` before using the channel;
2. attempt the broker operation;
3. if the operation throws a channel/connection-closed error, clear connection state, run `ensureConnected()` again, and retry once;
4. if reconnect still fails, surface a typed temporary-unavailable error to the route layer.

This is the part that handles the RabbitMQ timeout-induced channel error explicitly.

#### Pattern B: ACK/NACK methods

Methods such as:

- `ack`
- `ackJobFromSession`
- `nackJobFromSession`
- `ackFromQueue`

must remain conservative.

An ACK/NACK can only be executed against the exact channel generation that received the delivery. If the channel died and the API reconnected, the old in-memory delivery reference is invalid.

Therefore:

- ACK/NACK should **not** reconnect and then attempt to ACK the stale message on a fresh channel;
- instead, if the underlying channel generation changed or the delivery record was cleared, these methods return `false` (not found / already unavailable);
- routes keep returning `404` for "delivery not available to ACK anymore," and the design documents why that can happen.

This avoids pretending a stale delivery can be safely acknowledged after reconnect.

### 6. In-memory delivery maps must be invalidated on reconnect

When RabbitMQ closes the channel/connection, every stored `GetMessage` tied to that channel becomes stale.

On disconnect or successful reconnect, `RabbitMQService` should clear:

- `deliveryMap`
- `queueDeliveryMaps`

It may keep `activeSessionQueues`, because that set is derived from asserted/bound queues rather than individual deliveries, but it must be kept consistent with any queue-assert logic.

Why clearing is correct:

- a delivery object from a dead channel cannot be ACKed on a replacement channel;
- leaving stale deliveries in memory would produce false-positive `ack(...) === true` behavior or misleading route responses.

### 7. Introduce a typed temporary-unavailable error for API routes

The API currently turns disconnected-broker issues into generic `500`s. That should become explicit temporary-unavailable behavior.

Recommended addition in `packages/api/src/services/rabbitmq.ts` or a nearby API-local error module:

```ts
export class RabbitMQUnavailableError extends Error {}
```

Route contract:

- if a RabbitMQ operation throws `RabbitMQUnavailableError`, respond with `503` and a short transient error message;
- preserve existing `400` / `404` semantics for validation and missing-delivery cases;
- reserve the generic error middleware for unexpected bugs.

This applies to task, job, and result routes for publish/get operations.

### 8. Task poller execution order changes slightly

`packages/daemon/task/src/task-poller.ts` should change `executeJob(job)` to:

1. acquire the session lock;
2. immediately call `/jobs/:sessionId/:jobId/ack`;
3. if ACK fails or returns non-200, log and abort execution for that job instance;
4. if ACK succeeds, continue with orchestrator execution;
5. post `/results` exactly as today.

Early ACK does mean the next message in the session queue can become visible sooner. Per-session FIFO is still preserved by the existing daemon-side controls:

- each poller instance keeps a session marked active until the current job finishes;
- cross-process/session concurrency is guarded by `SessionLockManager`;
- if another worker fetches the next job too early and cannot acquire the session lock, it requeues that job instead of executing it out of order.

Operationally, this also means FIFO now tracks **acceptance order**, not **completion order**. That is acceptable because the daemon already serializes by session lock and only fetches one active job per session at a time.

### 9. Explicitly document the accepted post-fetch disconnect trade-off

There is one accepted edge case:

1. API returns a task/result message to a client;
2. RabbitMQ closes the channel before the later ACK HTTP request arrives;
3. the API clears stale delivery state during reconnect;
4. the later ACK request returns `404` because that delivery no longer exists in memory.

Consequence:

- RabbitMQ may redeliver the message because the original ACK never reached the broker.

Why this is acceptable in this feature:

- it already matches at-least-once message delivery reality;
- trying to "rescue" a stale delivery across reconnect would be incorrect;
- current consumers already have duplicate-handling behavior in several paths (`Duplicate ... received while an earlier delivery is still outstanding`).

Implementation comments should call this out directly near delivery-map invalidation and ACK route behavior so future maintainers do not misinterpret the `404` as a bug.

## File-Level Changes

| File | Change | Purpose |
|------|--------|---------|
| `packages/api/src/services/rabbitmq.ts` | Modify | Add shared reconnect gate, reconnect-aware operation wrappers, stale-delivery invalidation, typed temporary-unavailable errors |
| `packages/api/src/routes/tasks.ts` | Modify | Map RabbitMQ temporary-unavailable errors to `503` for task publish/get routes |
| `packages/api/src/routes/jobs.ts` | Modify | Map RabbitMQ temporary-unavailable errors to `503` for job publish/get routes; keep ACK/NACK semantics explicit |
| `packages/api/src/routes/results.ts` | Modify | Map RabbitMQ temporary-unavailable errors to `503` for result publish/get routes |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Modify | Cover reconnect sharing, reconnect-on-operation, stale delivery invalidation, and unavailable error cases |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Modify | Cover `503` responses for reconnect failures and unchanged `404` ACK behavior |
| `packages/api/src/__tests__/routes/results.test.ts` | Modify | Cover `503` responses for RabbitMQ temporary unavailability |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Cover `503` responses for RabbitMQ temporary unavailability |
| `packages/daemon/task/src/task-poller.ts` | Modify | ACK job immediately after fetch and before execution |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Modify | Update expected request order so ACK precedes execution result publish |
| `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` | Modify | Preserve session FIFO/concurrency guarantees under early ACK behavior |

## Testing Strategy

### API service tests

Add unit coverage for:

- reconnect triggered when channel is absent at request time;
- multiple callers sharing one reconnect attempt;
- reconnect clearing stale delivery maps;
- publish/get methods throwing `RabbitMQUnavailableError` when reconnect fails;
- ACK methods returning `false` after reconnect invalidates the prior delivery;
- channel `error` / `close` listeners nulling active handles and making the next request reconnect.

### Route tests

Add route coverage for:

- `503` from `/tasks`, `/tasks/next`, `/jobs`, `/jobs/next/:sessionId`, `/results`, `/results/next/:queueName` when the service reports temporary broker unavailability;
- `404` remaining the response for ACK endpoints when a delivery is no longer available.

### Task-daemon tests

Add/update coverage for:

- ACK request happening immediately after job fetch and before result publication;
- no execution when the immediate ACK fails;
- existing per-session concurrency/FIFO tests continuing to pass with the new ordering.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Reconnect races create multiple channels or partially initialized topology | Use one shared `reconnectPromise`; only publish the new `connection/channel` after queue/exchange setup succeeds |
| Stale delivery objects survive reconnect and produce invalid ACK attempts | Clear all in-memory delivery maps on disconnect/reconnect and document why |
| API routes still return `500` for broker outages | Introduce a typed temporary-unavailable error and map it explicitly to `503` in routes |
| Early ACK causes jobs to be lost if daemon crashes after ACK but before completion | Accept as an intentional fire-and-forget trade-off and preserve failure reporting through `/results` when execution reaches that point |
| Daemon executes work without actually owning the delivery | Require immediate ACK success before execution starts |

## Acceptance Criteria

1. `TaskPoller` acknowledges a fetched job before execution begins.
2. The task-daemon does not execute a fetched job if the immediate ACK request fails.
3. Long-running job execution no longer depends on a broker delivery remaining unacknowledged until completion.
4. At runtime, if the API's RabbitMQ channel/connection dies, the next RabbitMQ-dependent request triggers reconnect.
5. Concurrent requests during runtime recovery wait on the same reconnect attempt.
6. If reconnect succeeds, the original request proceeds on the fresh channel.
7. If reconnect fails, publish/get routes return `503` instead of generic `500`.
8. ACK endpoints do not attempt to reuse stale deliveries after reconnect; they return the existing "not found/already processed" style response.
9. Tests cover the reconnect gate, temporary-unavailable responses, stale-delivery invalidation, and early-ACK task-daemon ordering.
