# Design: Multi-Machine Task Routing via API Registration and Per-Machine Queues

**Date:** 2026-04-07
**Status:** Ready for implementation planning
**Depends on:** Channel boundary split, API authentication, per-session FIFO job queues, broker-backed queue discovery

## Problem

The current system assumes one `task-daemon` owns all execution. Jobs are published into RabbitMQ queues keyed by `session_id`, and one daemon discovers those queues through the API.

That model cannot support the next requirement:

1. multiple machines run task daemons at the same time;
2. each machine supports a disjoint set of `/task <task_type>` values;
3. registration must fail entirely if even one requested task type collides with another live machine;
4. once a session starts, all follow-up jobs for that session must keep routing to the same machine;
5. ordering must be preserved without queue shuffling or requeue-based filtering.

The recent channel-boundary work already moved command classification earlier, so inbound services now know canonical task type before enrichment publishes jobs. That makes API-side routing feasible.

## Goal

Support multiple task-daemon machines by introducing:

1. API-owned machine registration with lease renewal;
2. strict disjoint business-task ownership across live machines;
3. one durable RabbitMQ queue per machine;
4. durable session-to-machine pinning for follow-up routing;
5. machine-specific polling/ACK/NACK routes for task daemons;
6. explicit special handling for control flows that do not fit normal ownership, especially `gc` fan-out.

## Non-Goals

- No live reload of supported task types without daemon restart.
- No persistent machine-registration database; registration remains API-memory only.
- No automatic failover or session reassignment when a machine disappears.
- No support for sharing one business task type across multiple machines.
- No worker-direct RabbitMQ access.

## User Decisions Captured

- Scope is end-to-end: API, broker topology, and task-daemon consumption all change together.
- One daemon instance is one stable machine identity from required env var `MACHINE_ID`.
- Registration is all-or-nothing on task-type collision.
- Queue topology is one queue per machine.
- Supported task types are fixed at startup; changing them requires daemon restart.
- Session affinity is whole-session pinning, not per-job re-routing.
- If a machine lease expires, pinned sessions still publish to that machine queue and wait for it to come back.
- Registration ownership is ephemeral API memory, not durable state.
- New root work with no registered owner is rejected immediately.
- `gc` is a top-level command with no session context, so it must fan out one job per live machine.
- Session/task-type mismatch later in a session is illegal behavior and not supported.
- After API restart, machines recover by normal re-registration heartbeat.
- `status` and `cleanup` should participate in this feature rather than staying outside it.

## Existing Context

### Inbound services now classify early enough for routing

Relevant current code:

- `packages/daemon/lark-listener/src/adapters/lark-canonical-task-builder.ts`
- `packages/daemon/telegram-inbound/src/adapters/telegram-task-submitter.ts`
- `packages/daemon/task-enrichment/src/enrichment-poller.ts`

### The API already owns RabbitMQ topology and delivery bookkeeping

Relevant current code:

- `packages/api/src/services/rabbitmq.ts`
- `packages/api/src/routes/jobs.ts`

### Canonical session metadata already exists in SQLite

Relevant current code:

- `packages/shared/src/db/schema.ts`
- `packages/shared/src/db/session-repository.ts`

This feature needs durable session-owner pinning. The cleanest place for that is canonical session metadata, while live machine registration itself remains API-memory only.

### The current `/status` implementation is single-machine only

`task-enrichment` currently calls one configured task-daemon status server directly. That only works with one execution machine, so `/status` must become a routed job.

## Approaches Considered

### Approach A: Per-machine queues + API-memory registration + durable session pinning (recommended)

- API keeps live machine registration in memory.
- Each live machine owns a disjoint set of business task types.
- API writes chosen `owner_machine_id` into canonical session metadata when a session is first accepted.
- RabbitMQ uses one durable queue per machine.
- Task daemons poll only their own machine queue.

Why chosen:

- matches the user’s exact operational model;
- preserves ordering without requeue shuffling;
- survives API restart because session ownership is durable even though registration is not;
- keeps RabbitMQ access centralized in the API.

### Approach B: Keep per-session queues and add owner metadata

Why not chosen:

- conflicts with the explicit “one queue per machine” decision;
- forces every machine to keep discovering many session queues;
- adds coordination cost without product value.

### Approach C: Route by task type only and re-evaluate every job

Why not chosen:

- breaks session continuity;
- risks queue shuffling and ordering loss;
- directly conflicts with the pinned-session requirement.

## Chosen Design

### 1. Separate ephemeral registration from durable session ownership

The feature relies on two different ownership concepts.

**Ephemeral machine registration**

- stored only in API memory;
- says which live machine owns which business task types;
- expires by lease if the daemon stops heartbeating;
- is rebuilt by daemon startup/heartbeat after API restart.

**Durable session ownership**

- stored in SQLite canonical session metadata;
- says which machine a session is pinned to;
- survives API restart;
- does not disappear just because the machine lease expires.

This split preserves the user’s “ephemeral registration” rule without making follow-up routing impossible after API restart.

### 2. Core invariants

1. One `machine_id` maps to one durable queue `jobs.machine.<machine_id>`.
2. A live business task type can be owned by at most one machine.
3. A registration request with any colliding task type fails entirely.
4. Once a session has an `owner_machine_id`, all follow-up jobs route to that machine queue.
5. Existing pinned sessions continue publishing to their owner queue even if registration has expired.
6. A new-session business task with no live owner is rejected immediately.
7. Session-scoped control tasks route by pinned session owner, not fresh task-type ownership lookup.
8. `gc` has no session context and therefore cannot be session-routed; it fans out to every live registered machine.

### 3. Queue topology

RabbitMQ keeps the existing durable `jobs` direct exchange.

New durable per-machine queues:

- `jobs.machine.<machine_id>`

Each queue is bound to the `jobs` exchange with routing key `<machine_id>`.

Important consequences:

- these queues do not use session idle-expiry semantics;
- queue lifetime is tied to machine identity, not transient session activity;
- queues survive disconnects and API restart.

### 4. Why one machine queue still preserves per-session FIFO

One machine queue mixes jobs from many sessions. Ordering is preserved by the task daemon’s local scheduler, not by separate per-session broker queues.

Required behavior:

1. fetch the next delivery from the machine queue;
2. if its `session_id` is inactive, ACK immediately before execution and start it;
3. if that session is already active, hold the delivery locally without ACKing yet;
4. when the active job for that session finishes, ACK the deferred delivery and execute it next.

The daemon must not requeue same-session deferred work, because that would reshuffle messages.

### 5. Shared contract changes

Add shared types for machine registration.

Recommended shapes:

```ts
export interface MachineRegistrationRequest {
  task_types: string[];
  lease_ttl_ms?: number;
}

export interface MachineRegistrationResponse {
  machine_id: string;
  queue_name: string;
  task_types: string[];
  lease_expires_at_ms: number;
}
```

Add shared constants/helpers:

- `DEFAULT_MACHINE_JOBS_QUEUE_PREFIX = 'jobs.machine'`
- `DEFAULT_MACHINE_REGISTRATION_TTL_MS`
- `DEFAULT_MACHINE_REGISTRATION_HEARTBEAT_MS`
- `getMachineQueueName(machineId: string)`
- required env parsing for `MACHINE_ID`
- startup parsing for supported business task types, for example `TASK_DAEMON_TASK_TYPES`

### 6. Session schema extension

Extend `sessions` with durable owner metadata:

- `owner_machine_id TEXT`
- `owner_assigned_at_ms INTEGER`

Recommended index:

- `idx_sessions_owner_machine_id`

This is intentionally small. There is no durable machine-registry table.

### 7. API registration design

Add routes:

```text
PUT /machines/:machineId/registration
DELETE /machines/:machineId/registration
```

`PUT /machines/:machineId/registration` responsibilities:

1. validate non-empty normalized `machineId`;
2. validate `task_types` is a non-empty unique list;
3. prune expired registrations before collision checks;
4. reject the whole request if any requested business task type is owned by another live machine;
5. assert the machine queue in RabbitMQ;
6. upsert the in-memory registration with refreshed lease expiry;
7. return queue name and lease metadata.

Collision response should be `409` and identify colliding task types plus current owners.

`DELETE /machines/:machineId/registration` is best-effort graceful deregistration only. It does not delete the machine queue.

### 8. In-memory registration state

The API keeps two indexes:

- `machineId -> MachineRegistrationRecord`
- `taskType -> machineId`

Recommended record fields:

- `machineId`
- `taskTypes`
- `queueName`
- `leaseExpiresAtMs`
- `registeredAtMs`
- `updatedAtMs`

Expired records are pruned lazily before registration checks and routing decisions.

### 9. Job routing contract

`POST /jobs` remains the job entrypoint, but routing changes.

#### New-session business task

1. If the session already has `owner_machine_id`, route there.
2. Otherwise look up the live owner for `job.task_type`.
3. If no live owner exists, return `409` with clear routing error.
4. If an owner exists, persist `owner_machine_id` in `sessions` and publish to that machine queue.

#### Follow-up job for existing session

1. Load `owner_machine_id` from canonical session metadata.
2. Publish to that queue even if the machine is currently not registered.
3. If the job implies a different business task type than the pinned session invariant, reject it as invalid.

#### Session-scoped control tasks

These route by pinned session owner rather than fresh task-type ownership lookup:

- `thread_reply`
- `new_instance`
- `cleanup`
- `status`

This is correct specifically because `cleanup` and `status` are session-specific commands.

#### `gc`

`gc` is special because it is a top-level command without any session context:

1. enumerate all live machine registrations;
2. clone one `gc` job per registered machine queue;
3. publish each clone to that queue;
4. return success only if all fan-out publishes succeed.

Expired or absent registrations do not receive new `gc` jobs.

### 10. Routing rejection responses

New explicit `POST /jobs` failure modes:

- `409` no live owner for a new-session business task type;
- `409` required pinned session owner is missing;
- `409` task type conflicts with pinned session invariant;
- `503` RabbitMQ unavailable or buffering failure.

These rejections are expected product outcomes. `task-enrichment` must publish them as visible user replies and ACK the source task.

### 11. Machine polling endpoints

Replace session polling with machine polling:

```text
GET /machines/:machineId/jobs/next
POST /machines/:machineId/jobs/:jobId/ack
POST /machines/:machineId/jobs/:jobId/nack
```

The old session-specific job polling endpoints become obsolete for `task-daemon` after this feature.

### 12. Task-daemon startup and heartbeat

Required startup config:

- `MACHINE_ID`
- `TASK_DAEMON_TASK_TYPES`
- optional heartbeat/TTL overrides

Startup order:

1. load config and API auth;
2. acquire existing machine lock;
3. register `machine_id` and supported task types with the API;
4. start periodic heartbeat/renewal;
5. start polling only the machine-specific job route.

If registration fails on collision, startup exits non-zero.

### 13. Task-daemon local scheduler

Recommended internal structures:

- `activeSessions: Set<string>`
- deferred unacked deliveries grouped by `session_id`
- in-flight execution map bounded by `MAX_CONCURRENT_SESSIONS`

Required behavior:

- preserve FIFO within one session;
- allow concurrency across sessions;
- never requeue same-session deferred work as the normal path.

### 14. `/status` becomes a routed job

The current synchronous enrichment-time `/status` HTTP lookup only works with one execution machine. It must move onto the normal machine-routed job plane.

Effects:

- `task-enrichment` no longer calls one configured task-daemon status URL for user-visible `/status`;
- `/status` becomes a normal job routed by pinned session owner;
- the owning task daemon executes local status collection and returns the result through the existing result pipeline.

### 15. `cleanup`, `status`, and `new_instance`

- `cleanup` routes to the pinned owner machine because it acts on machine-local workspace state.
- `status` routes to the pinned owner machine because it is a session-specific status lookup rather than a global command.
- `new_instance` remains session-scoped and also routes to the pinned owner machine.

### 16. API restart and lease expiry semantics

After API restart:

- live registration indexes are empty until daemons re-register;
- machine queues still exist in RabbitMQ;
- session owner pinning still exists in SQLite;
- follow-up jobs for pinned sessions can still publish immediately;
- brand-new sessions cannot be assigned until at least one machine re-registers.

When a machine lease expires:

- remove it from live registration/task-type indexes for new-session assignment;
- keep its queue untouched;
- keep routing pinned sessions there.

This exactly matches the user’s “have faith the machine will come back” rule.

## Risks and Mitigations

### Risk 1: API-memory registration disappears on restart

Mitigation:

- keep durable session pinning in SQLite;
- require daemon heartbeat to re-register live ownership;
- reject new-session roots cleanly until ownership is restored.

### Risk 2: One machine queue can block behind a hot session

Mitigation:

- preserve current cross-session concurrency once jobs are ACKed into local execution slots;
- use local per-session deferred holding rather than requeueing;
- keep `MAX_CONCURRENT_SESSIONS` as the machine-local fairness bound.

### Risk 3: `/status` still assumes one machine

Mitigation:

- remove enrichment-time direct status lookup from the user path;
- run `status` through normal routed job execution.

### Risk 4: Control-task semantics drift from business-task ownership

Mitigation:

- document and test that `status`, `cleanup`, `new_instance`, and `thread_reply` route by pinned session owner;
- document and test that `gc` fans out to live machines only.

## Testing Strategy

Add coverage for:

- registration collision failure and whole-request rejection;
- lease refresh and expiry pruning;
- machine queue assertion and publish routing by `machine_id`;
- durable `owner_machine_id` persistence in session metadata;
- new-session rejection when no owner exists;
- `gc` fan-out publish to all live machines;
- task-daemon startup failure on registration collision;
- task-daemon polling/ACK/NACK against machine routes;
- per-session FIFO preservation inside one machine queue;
- `/status` routed through owning machine rather than direct HTTP lookup.

## Review Notes

- `design-spec-document-reviewer-prompt.md` was not present in this workspace.
- I completed the design review step manually against the current codebase and the clarified product decisions.
