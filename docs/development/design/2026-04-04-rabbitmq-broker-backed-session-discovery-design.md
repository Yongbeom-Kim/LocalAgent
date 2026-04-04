# Design: RabbitMQ Broker-Backed Session Queue Discovery

**Date:** 2026-04-04
**Status:** Draft
**Depends on:** Strict FIFO Per-Session Job Queues (implemented)

## Problem

The current per-session queue design exposes `GET /jobs/sessions` from the API so the single task daemon can discover session queues to poll. That endpoint does not query RabbitMQ. Instead, it returns an API-owned in-memory `activeSessionQueues` set populated on publish and pruned opportunistically when a session queue is observed empty.

That creates an unnecessary source-of-truth split:

- RabbitMQ already owns the real queue topology.
- The API keeps a second, partial copy of session queue state in memory.
- API restarts lose the set even though the session queues still exist in RabbitMQ.
- The daemon’s discovery contract depends on API-local bookkeeping rather than broker state.

The user wants session discovery to be broker-backed instead of manually tracked.

## Goals

1. Make `GET /jobs/sessions` return session queues by querying RabbitMQ, not API memory.
2. Keep RabbitMQ access centralized in the API; the task daemon should continue calling only the API.
3. Preserve the current daemon pull model and poll cadence.
4. Define a clear failure contract when broker-backed discovery cannot be performed.
5. Remove manual active-session tracking from the API job path.

## Non-Goals

- Replacing the daemon polling model with push-based consumption.
- Filtering session queues by pending-message counts.
- Adding a retry layer beyond the daemon’s existing repeated polling behavior.
- Introducing separate management API environment variables in this refactor.
- Supporting multi-daemon coordination or distributed queue ownership.

## Clarified Product Decisions

The design is based on these explicit choices:

- `GET /jobs/sessions` means all existing `jobs.session.*` queues in RabbitMQ, even if they are currently empty.
- Broker querying stays in the API layer; the task daemon continues to call `/jobs/sessions`.
- If broker-backed discovery fails, `/jobs/sessions` returns `503`.
- No manual-tracking fallback is retained.
- No additional retry/backoff behavior is added to the task daemon beyond its normal poll loop.
- Management endpoint location and credentials are derived from `RABBITMQ_URL`.

Operational prerequisite:

- RabbitMQ must have the management plugin enabled, and the API service must be able to reach the management HTTP endpoint.

## Approaches Considered

### Approach 1: Keep the current API-managed in-memory session registry

The API would continue maintaining `activeSessionQueues` and `GET /jobs/sessions` would continue returning that set.

Why not chosen:

- duplicates broker topology in application state;
- drifts on API restart;
- requires custom activation/deactivation logic that RabbitMQ already supersedes.

### Approach 2: Query RabbitMQ Management API inside the API service

The API derives management connection details from `RABBITMQ_URL`, calls the RabbitMQ HTTP management API to list queues, filters by the session queue prefix, and returns those descriptors from `GET /jobs/sessions`.

Why chosen:

- broker state becomes the source of truth for queue discovery;
- preserves the existing architectural boundary that daemons interact with RabbitMQ only through the API;
- removes restart-sensitive in-memory bookkeeping without changing daemon scheduling semantics.

### Approach 3: Let task-daemon query RabbitMQ management directly

The daemon would derive RabbitMQ management credentials and list queues itself.

Why not chosen:

- spreads RabbitMQ topology and credential logic into another service;
- weakens the existing API-as-broker-facade boundary;
- adds no product value over Approach 2.

## Chosen Design

### 1. Replace API-managed active-session tracking with broker-backed discovery

**Files:**
- `packages/api/src/services/rabbitmq.ts`
- `packages/api/src/routes/jobs.ts`
- `packages/api/src/__tests__/services/rabbitmq.test.ts`
- `packages/api/src/__tests__/routes/jobs.test.ts`

`RabbitMQService` will stop treating session discovery as an in-memory concern. The `activeSessionQueues` set and `listActiveSessions()` implementation based on that set will be removed.

Instead, `RabbitMQService` will expose a broker-backed session listing method that:

1. computes RabbitMQ management API connection details from `RABBITMQ_URL`;
2. calls the management API queue-list endpoint for the configured vhost (defaulting to `/`);
3. filters queue names beginning with `jobs.session.`;
4. sorts the resulting descriptors stably by `queue_name` ascending;
5. returns `{ session_id, queue_name }[]`.

No message-count filtering is applied. Empty session queues remain visible until RabbitMQ expires them.

### 2. Derive management API access from `RABBITMQ_URL`

**Files:**
- `packages/shared/src/config.ts`
- `packages/shared/src/__tests__/config.test.ts`
- `packages/shared/src/index.ts` if new helpers/types need export

This refactor does not introduce separate management URL credentials. Instead, the API derives them from the existing `RABBITMQ_URL`.

Assumptions for this version:

- management host is the same as the AMQP host;
- management credentials are the same as the AMQP credentials;
- management port is `15672` (regardless of the AMQP port);
- management protocol is `http`.

Vhost handling rules for this version:

- If `RABBITMQ_URL` includes a vhost path segment (e.g. `amqp://user:pass@host:5672/my-vhost`), session discovery queries that vhost.
- If `RABBITMQ_URL` does not include a vhost path segment, session discovery queries the default vhost `/`.
- The vhost must be URL-encoded in the management API path.

This matches the current development topology and keeps configuration minimal. If deployment environments later need different credentials, TLS, or a different port, that can be a follow-up refactor.

The config layer should validate that `RABBITMQ_URL` is parseable enough to derive management details cleanly, so failures are deterministic and testable.

### 3. Keep publish/get/ack job flow on AMQP, add a separate management-query path

**Files:**
- `packages/api/src/services/rabbitmq.ts`

AMQP remains the mechanism for:

- asserting queues and exchanges;
- publishing jobs;
- fetching the next job from a session queue;
- acknowledging or NACKing deliveries.

The management API is used only for queue discovery.

This split matters because AMQP and management are separate surfaces. The API may remain AMQP-connected but still be unable to perform session discovery if management is down or misconfigured. The code should model this explicitly rather than hiding it behind stale in-memory data.

### 4. `/jobs/sessions` returns `503` when broker-backed discovery fails

**Files:**
- `packages/api/src/routes/jobs.ts`
- `packages/api/src/middleware/error-handler.ts` if shared error mapping is used
- `packages/api/src/__tests__/routes/jobs.test.ts`

When the management query fails, `GET /jobs/sessions` should return:

```json
{ "error": "Session queue discovery unavailable" }
```

with HTTP status `503`.

This is intentionally different from the generic route error path because the failure is not an internal programming error. It is a temporary upstream dependency failure while trying to discover broker state.

No fallback to manual tracking is allowed.

### 5. Task daemon behavior remains pull-based with normal poll cadence

**Files:**
- `packages/daemon/task/src/task-poller.ts`
- `packages/daemon/task/src/__tests__/task-poller.test.ts`

The task daemon already polls `/jobs/sessions` on each cycle. That architecture stays unchanged.

When `/jobs/sessions` returns `503`, the daemon should:

- log a warning;
- treat the cycle as yielding no sessions;
- continue normally on the next scheduled poll.

No extra exponential backoff or per-call retry wrapper is added because the daemon is already pull-based and will naturally try again on the next loop.

### 6. Session queue semantics remain “existing queues,” not “queues with work”

**Files:**
- `packages/api/src/services/rabbitmq.ts`
- `packages/daemon/task/src/task-poller.ts`

The API will not filter by `messages`, `messages_ready`, or `messages_unacknowledged`.

This means `/jobs/sessions` may include:

- queues with pending messages;
- queues with in-flight unacked messages;
- empty queues waiting for `x-expires` cleanup.

That is acceptable because:

- it is the simplest broker-backed definition;
- it matches the chosen product meaning of “all existing session queues”;
- the daemon already tolerates empty sessions by calling `GET /jobs/next/:sessionId` and receiving `204`.

### 7. Remove no-longer-needed activation semantics from the design contract

**Files:**
- `packages/api/src/services/rabbitmq.ts`
- `packages/api/src/routes/jobs.ts`
- related tests/docs

Publishing a job should still assert the per-session queue and publish to it, but it no longer has any responsibility to “activate” a session in API memory. Queue existence in RabbitMQ is sufficient.

Similarly, observing an empty queue should no longer “deactivate” a session in API memory. Queue disappearance is left entirely to RabbitMQ idle expiry.

## API Shape

The route shape does not change:

```ts
GET /jobs/sessions
-> 200 { sessions: [{ session_id: string, queue_name: string }] }
```

New explicit failure response:

```ts
GET /jobs/sessions
-> 503 { error: 'Session queue discovery unavailable' }
```

No response field is added for queue stats in this refactor.

## RabbitMQ Management Query Details

The API should query the RabbitMQ management endpoint that lists queues for the configured vhost (defaulting to `/`).

Expected derivation from `amqp://guest:guest@rabbitmq:5672`:

- management base URL: `http://rabbitmq:15672`
- username: `guest`
- password: `guest`
- queue listing path: `/api/queues/%2F` for vhost `/`

If the configured vhost is `my-vhost`, the queue listing path becomes `/api/queues/my-vhost` (URL-encoded as needed).

The design intent is to query only the configured/default vhost (via `GET /api/queues/{vhost}`), not all vhosts.

Authentication and failure rules:

- The API uses HTTP Basic Auth with the derived username/password.
- If `RABBITMQ_URL` does not include a username/password, session discovery fails (the API returns `503` from `GET /jobs/sessions`).
- Any non-2xx response or network error from the management endpoint causes session discovery to fail (the API returns `503` from `GET /jobs/sessions`).

The response should be mapped minimally. Only queue names are needed for this feature.

## Testing Strategy

### Shared config

Add tests that verify management access derivation from `RABBITMQ_URL`, including:

- standard hostname URL;
- localhost URL;
- invalid URL handling if a helper is introduced.

### API RabbitMQ service

Add tests for:

- deriving session descriptors from management API queue payloads;
- filtering only `jobs.session.*` queues;
- stable sorting of returned session descriptors;
- propagating management-query failure distinctly from AMQP behavior.

The service tests should stub HTTP fetch separately from AMQP channel mocks so the split between queue discovery and message transport is explicit.

### Job routes

Add tests for:

- `GET /jobs/sessions` returning broker-backed session descriptors;
- `GET /jobs/sessions` returning `503` with the expected error body when queue discovery fails;
- `POST /jobs` continuing to publish correctly without any active-session registration side effect.

### Task daemon

Add or update tests for:

- `pollOnce()` handling `503` from `/jobs/sessions` without crashing;
- subsequent successful poll cycles still processing jobs normally;
- no retry/backoff logic is introduced into the daemon path.

## Risks

1. AMQP can be healthy while management discovery fails.
Mitigation: make that state explicit with a `503` response rather than masking it.

2. Deriving management URL from `RABBITMQ_URL` is intentionally narrow.
Mitigation: document the assumptions and keep the derivation helper isolated so a later env-based override can be added cleanly.

3. `/jobs/sessions` may return many empty queues during the one-hour expiry window.
Mitigation: accepted by design because “existing queues” is the intended semantics for this refactor.

4. The API adds an outbound HTTP dependency to RabbitMQ management for one route.
Mitigation: scope the dependency to session discovery only; all job transport continues over AMQP.

## Open Questions

No open product questions remain for this refactor. Future follow-ups may revisit:

- separate management API config;
- HTTPS/TLS management endpoints;
- filtering discovery results by queue depth;
- richer broker-derived observability for session queues.
