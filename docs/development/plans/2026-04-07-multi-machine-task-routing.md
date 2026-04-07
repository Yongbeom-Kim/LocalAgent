# Multi-Machine Task Routing Implementation Plan

**Goal:** Add API-managed multi-machine task execution with disjoint task-type registration, one durable queue per machine, durable session-to-machine pinning, and `gc` fan-out.

**Architecture:** The API remains the RabbitMQ facade and gains a lease-based machine registry in memory plus durable session-owner metadata in SQLite. The task daemon registers one stable `MACHINE_ID`, polls only its own queue, and preserves FIFO within a session by locally deferring same-session deliveries instead of requeueing them.

**Tech Stack:** TypeScript, Node.js 20, Express, RabbitMQ/amqplib, Drizzle/libsql, Vitest, Rush monorepo

---

## File Map

| File | Responsibility |
|------|----------------|
| `packages/shared/src/constants.ts` | Add machine queue, registration TTL, and heartbeat constants |
| `packages/shared/src/config.ts` | Parse `MACHINE_ID` and supported task-type config for task-daemon |
| `packages/shared/src/types.ts` | Add machine registration request/response types |
| `packages/shared/src/index.ts` | Export new shared contracts |
| `packages/shared/src/db/schema.ts` | Add durable `owner_machine_id` and `owner_assigned_at_ms` to `sessions` |
| `packages/shared/src/db/session-repository.ts` | Read/write session owner machine metadata |
| `packages/shared/src/__tests__/db/session-repository.test.ts` | Verify owner persistence and reads |
| `packages/migrator/src/migrations/0002_session_owner_machine.sql` | Add session owner columns/index |
| `packages/api/src/services/machine-registration.ts` | New in-memory lease registry for machine/task-type ownership |
| `packages/api/src/services/rabbitmq.ts` | Assert per-machine queues and publish/fetch/ack by machine id |
| `packages/api/src/routes/machines.ts` | Registration, deregistration, and machine job polling routes |
| `packages/api/src/routes/jobs.ts` | Route job publish by live owner or pinned session owner; fan out `gc` |
| `packages/api/src/app.ts` | Wire machine routes |
| `packages/api/src/index.ts` | Compose machine registration service and DB-backed routing deps |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Verify per-machine queue behavior |
| `packages/api/src/__tests__/routes/machines.test.ts` | Verify registration, collision handling, and machine job routes |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Verify routing by owner machine, new-session rejections, and `gc` fan-out |
| `packages/daemon/task/src/task-daemon.ts` | Register machine identity before polling and renew lease on heartbeat |
| `packages/daemon/task/src/task-poller.ts` | Poll machine-specific jobs and defer same-session deliveries locally |
| `packages/daemon/task/src/services/machine-registration-heartbeat.ts` | New heartbeat helper for periodic renewal |
| `packages/daemon/task/src/services/status-executor.ts` | New local status job executor/helper |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Route `status` jobs through local status executor |
| `packages/daemon/task/src/__tests__/task-daemon.test.ts` | Verify startup registration and collision failure |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Verify machine polling and delivery error handling |
| `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` | Verify per-session FIFO inside one machine queue |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Verify `status` job handling |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Treat API routing rejections as user-visible results; stop direct `/status` calls |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Verify routing rejection handling and job-based `status` flow |

## Task 1: Add shared contracts for machine routing

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/config.test.ts`

- [ ] **Step 1: Write failing config/type tests**

Add tests for:

- required `MACHINE_ID` parsing;
- parsing startup task types from env into a unique non-empty list;
- new machine queue helper/constants exports.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @local-agent/shared test -- --run src/__tests__/config.test.ts`
Expected: FAIL because machine-routing config contracts do not exist yet.

- [ ] **Step 3: Add shared constants and types**

Implement:

- `DEFAULT_MACHINE_JOBS_QUEUE_PREFIX`
- `DEFAULT_MACHINE_REGISTRATION_TTL_MS`
- `DEFAULT_MACHINE_REGISTRATION_HEARTBEAT_MS`
- `getMachineQueueName(machineId)`
- machine registration request/response types
- machine config parsing helpers in `config.ts`

- [ ] **Step 4: Run tests and typecheck**

Run:

- `pnpm --filter @local-agent/shared test -- --run src/__tests__/config.test.ts`
- `pnpm --filter @local-agent/shared exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/config.ts packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/src/__tests__/config.test.ts
git commit -m "feat(shared): add multi-machine routing contracts"
```

## Task 2: Persist durable session owner machine metadata

**Files:**
- Modify: `packages/shared/src/db/schema.ts`
- Modify: `packages/shared/src/db/session-repository.ts`
- Test: `packages/shared/src/__tests__/db/session-repository.test.ts`
- Create: `packages/migrator/src/migrations/0002_session_owner_machine.sql`

- [ ] **Step 1: Write failing session-repository tests**

Cover:

- assigning `owner_machine_id` to a session;
- reading owner machine back;
- preserving existing session fields while updating owner metadata.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @local-agent/shared test -- --run src/__tests__/db/session-repository.test.ts`
Expected: FAIL because owner-machine columns/methods do not exist.

- [ ] **Step 3: Add schema, migration, and repository methods**

Implement:

- new columns on `sessions`;
- index on `owner_machine_id`;
- repository methods such as `assignOwnerMachine` and `getOwnerMachineId`.

- [ ] **Step 4: Run tests**

Run:

- `pnpm --filter @local-agent/shared test -- --run src/__tests__/db/session-repository.test.ts`
- `pnpm --filter @local-agent/migrator exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/shared/src/db/session-repository.ts packages/shared/src/__tests__/db/session-repository.test.ts packages/migrator/src/migrations/0002_session_owner_machine.sql
git commit -m "feat(shared): persist session owner machine metadata"
```

## Task 3: Add API in-memory machine registration service

**Files:**
- Create: `packages/api/src/services/machine-registration.ts`
- Test: `packages/api/src/__tests__/services/machine-registration.test.ts`

- [ ] **Step 1: Write failing registration-service tests**

Cover:

- successful registration of one machine;
- whole-request rejection on one colliding task type;
- lease refresh for same machine;
- lazy pruning of expired registrations;
- listing live machine ids for `gc` fan-out.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @local-agent/api test -- --run src/__tests__/services/machine-registration.test.ts`
Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement machine registration service**

Store:

- `machineId -> record`
- `taskType -> machineId`

Implement methods for register, deregister, prune-expired, lookup owner, and list live machines.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @local-agent/api test -- --run src/__tests__/services/machine-registration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/machine-registration.ts packages/api/src/__tests__/services/machine-registration.test.ts
git commit -m "feat(api): add in-memory machine registration service"
```

## Task 4: Refactor RabbitMQ service for per-machine queues

**Files:**
- Modify: `packages/api/src/services/rabbitmq.ts`
- Test: `packages/api/src/__tests__/services/rabbitmq.test.ts`

- [ ] **Step 1: Write failing RabbitMQ tests**

Cover:

- asserting durable queue `jobs.machine.<machine_id>`;
- publishing jobs with routing key `<machine_id>`;
- fetching/acking/nacking by machine queue;
- queue helper reuse for deterministic queue names.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @local-agent/api test -- --run src/__tests__/services/rabbitmq.test.ts`
Expected: FAIL because per-machine queue behavior does not exist.

- [ ] **Step 3: Implement machine queue support**

Add methods equivalent to:

- `ensureMachineJobQueue(machineId)`
- `publishJobToMachine(machineId, job)`
- `getNextJobFromMachine(machineId)`
- `ackJobFromMachine(machineId, jobId)`
- `nackJobFromMachine(machineId, jobId)`

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @local-agent/api test -- --run src/__tests__/services/rabbitmq.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/rabbitmq.ts packages/api/src/__tests__/services/rabbitmq.test.ts
git commit -m "feat(api): route jobs through per-machine RabbitMQ queues"
```

## Task 5: Add machine registration and polling routes

**Files:**
- Create: `packages/api/src/routes/machines.ts`
- Modify: `packages/api/src/app.ts`
- Test: `packages/api/src/__tests__/routes/machines.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover:

- `PUT /machines/:machineId/registration` success;
- whole-request `409` collision failure;
- `DELETE /machines/:machineId/registration` success;
- `GET /machines/:machineId/jobs/next` job fetch;
- machine ACK/NACK routes.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @local-agent/api test -- --run src/__tests__/routes/machines.test.ts`
Expected: FAIL because machine routes do not exist.

- [ ] **Step 3: Implement routes and wire them**

Use the registration service plus new RabbitMQ machine methods. Keep auth behavior aligned with existing API routes.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @local-agent/api test -- --run src/__tests__/routes/machines.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/machines.ts packages/api/src/app.ts packages/api/src/__tests__/routes/machines.test.ts
git commit -m "feat(api): add machine registration and polling routes"
```

## Task 6: Route `POST /jobs` by live owner, pinned owner, and `gc` fan-out

**Files:**
- Modify: `packages/api/src/routes/jobs.ts`
- Modify: `packages/api/src/index.ts`
- Test: `packages/api/src/__tests__/routes/jobs.test.ts`

- [ ] **Step 1: Write failing job-route tests**

Cover:

- new-session routing by live task-type owner;
- durable `owner_machine_id` assignment on first accepted job;
- follow-up routing by pinned owner even when registration is absent;
- `409` when no live owner exists for a new-session task;
- `409` when a pinned-session invariant is violated;
- `gc` fan-out to all live machines.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @local-agent/api test -- --run src/__tests__/routes/jobs.test.ts`
Expected: FAIL because current routes still assume session queues.

- [ ] **Step 3: Implement routing logic**

Inject registration service and session repository into job routes. Route normal jobs by owner machine and clone `gc` publishes per live machine.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @local-agent/api test -- --run src/__tests__/routes/jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/jobs.ts packages/api/src/index.ts packages/api/src/__tests__/routes/jobs.test.ts
git commit -m "feat(api): route jobs by machine ownership and gc fan-out"
```

## Task 7: Register task-daemon identity before polling

**Files:**
- Modify: `packages/daemon/task/src/task-daemon.ts`
- Create: `packages/daemon/task/src/services/machine-registration-heartbeat.ts`
- Test: `packages/daemon/task/src/__tests__/task-daemon.test.ts`

- [ ] **Step 1: Write failing startup tests**

Cover:

- startup fails if `MACHINE_ID` or supported task types are missing;
- startup registers successfully before poller start;
- registration collision causes non-zero startup failure;
- heartbeat renews registration while running;
- graceful shutdown deregisters best-effort.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @local-agent/task-daemon test -- --run src/__tests__/task-daemon.test.ts`
Expected: FAIL because daemon registration flow does not exist.

- [ ] **Step 3: Implement startup registration and heartbeat**

Add a small heartbeat helper that `PUT`s the full registration payload on a fixed interval. Wire it into startup after machine lock acquisition and before poller start.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @local-agent/task-daemon test -- --run src/__tests__/task-daemon.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/task-daemon.ts packages/daemon/task/src/services/machine-registration-heartbeat.ts packages/daemon/task/src/__tests__/task-daemon.test.ts
git commit -m "feat(task-daemon): register machine identity before polling"
```

## Task 8: Replace session polling with machine polling and local same-session deferral

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts`
- Test: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Test: `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`

- [ ] **Step 1: Write failing poller tests**

Cover:

- polling `GET /machines/:machineId/jobs/next` instead of session discovery;
- ACK/NACK against machine routes;
- deferring same-session deliveries locally without requeueing;
- preserving FIFO for one session inside one machine queue;
- preserving concurrency across different sessions.

- [ ] **Step 2: Run test to verify failure**

Run:

- `pnpm --filter @local-agent/task-daemon test -- --run src/__tests__/task-poller.test.ts src/__tests__/task-poller-concurrent.test.ts`

Expected: FAIL because the poller still assumes session queue discovery.

- [ ] **Step 3: Implement machine-queue polling and deferred scheduling**

Remove the normal-path dependence on `/jobs/sessions`. Poll only the current machine queue and maintain a per-session deferred unacked-delivery structure.

- [ ] **Step 4: Run tests**

Run:

- `pnpm --filter @local-agent/task-daemon test -- --run src/__tests__/task-poller.test.ts src/__tests__/task-poller-concurrent.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/task-poller.ts packages/daemon/task/src/__tests__/task-poller.test.ts packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts
git commit -m "feat(task-daemon): poll per-machine queue and defer same-session deliveries"
```

## Task 9: Move `/status` onto the routed job path

**Files:**
- Create: `packages/daemon/task/src/services/status-executor.ts`
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
- Test: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

- task-daemon executes `status` locally and returns a normal result;
- enrichment no longer calls one configured status server for user-visible `/status`;
- `/status` becomes a normal routed job submission against pinned session owner.

- [ ] **Step 2: Run test to verify failure**

Run:

- `pnpm --filter @local-agent/task-daemon test -- --run src/core/__tests__/task-orchestrator.test.ts`
- `pnpm --filter @local-agent/task-enrichment test -- --run src/__tests__/enrichment-poller.test.ts`

Expected: FAIL because `/status` is still synchronous in enrichment.

- [ ] **Step 3: Implement status executor and remove direct lookup path**

Keep the existing status summary semantics, but execute them inside task-daemon as a normal job.

- [ ] **Step 4: Run tests**

Run:

- `pnpm --filter @local-agent/task-daemon test -- --run src/core/__tests__/task-orchestrator.test.ts`
- `pnpm --filter @local-agent/task-enrichment test -- --run src/__tests__/enrichment-poller.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/services/status-executor.ts packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(status): route status through owning machine queue"
```

## Task 10: Make enrichment surface routing rejections cleanly

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing enrichment tests**

Cover:

- `POST /jobs` `409` with “no machine available” becomes a visible user-facing rejection result;
- session-routing invariant errors also become visible rejection results;
- source task is ACKed after rejection is published.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @local-agent/task-enrichment test -- --run src/__tests__/enrichment-poller.test.ts`
Expected: FAIL because routing rejections are not modeled yet.

- [ ] **Step 3: Implement explicit rejection handling**

Map structured API routing failures to the existing rejection publish path instead of treating them as transport failures.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @local-agent/task-enrichment test -- --run src/__tests__/enrichment-poller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): surface machine-routing rejections to users"
```

## Task 11: Run targeted verification across packages

**Files:**
- Modify: none unless regressions are found

- [ ] **Step 1: Run API tests**

Run: `pnpm --filter @local-agent/api test`
Expected: PASS.

- [ ] **Step 2: Run shared tests**

Run: `pnpm --filter @local-agent/shared test`
Expected: PASS.

- [ ] **Step 3: Run task-daemon tests**

Run: `pnpm --filter @local-agent/task-daemon test`
Expected: PASS.

- [ ] **Step 4: Run enrichment tests**

Run: `pnpm --filter @local-agent/task-enrichment test`
Expected: PASS.

- [ ] **Step 5: Optional smoke check**

Bring up API/RabbitMQ and run two task-daemon instances with disjoint task sets and distinct `MACHINE_ID`s. Submit:

- a new root task for machine A’s type;
- a follow-up in the same session;
- a new root task for machine B’s type;
- one `/gc` command.

Expected:

- new roots route to owning machines;
- follow-up stays on pinned machine;
- `/gc` creates one job per live machine;
- no same-session requeue shuffling occurs.

- [ ] **Step 6: Commit final fixes if needed**

## Review Notes

- `implementation-spec-document-reviewer-prompt.md` was not present in this workspace.
- I completed the implementation-plan review step manually against the design doc and current codebase.
