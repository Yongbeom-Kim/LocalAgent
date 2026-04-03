# Per-Session FIFO Job Queues Implementation Plan

**Goal:** Replace the shared jobs queue with per-session job queues so all jobs in one session run in strict FIFO order while different sessions still run concurrently.

**Architecture:** The API will own a jobs exchange plus ephemeral per-session queues keyed by `session_id`, with a 1-hour idle expiry. The single task daemon will discover active sessions via the API and process one ordered stream per session, so all job types share the same FIFO path without same-session requeueing.

**Tech Stack:** TypeScript, Node.js 20, RabbitMQ (amqplib), Express, Vitest, Rush monorepo, Docker

---

## File Map

| File | Responsibility |
|------|----------------|
| `packages/shared/src/constants.ts` | Add jobs exchange, session queue prefix, idle TTL constants |
| `packages/shared/src/index.ts` | Export the new constants |
| `packages/api/src/services/rabbitmq.ts` | Own per-session queue assertion, publish, get, ack/nack, active-session tracking |
| `packages/api/src/routes/jobs.ts` | Publish jobs to session queues and expose active-session discovery endpoint |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Cover exchange + per-session queue operations |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Cover session-routed publish and session discovery |
| `packages/daemon/task/src/task-poller.ts` | Replace shared-queue polling with per-session processing/scheduling |
| `packages/daemon/task/src/task-daemon.ts` | Wire daemon startup to session discovery / scheduling loop |
| `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` | Verify FIFO within session and concurrency across sessions |
| `packages/daemon/task/src/services/session-lock.ts` | Keep lock as safety net, not normal scheduling path |
| `packages/daemon/task/src/services/__tests__/session-lock.test.ts` | Adjust expectations for exceptional contention |
| `docker-compose.yml` | No topology config change required, but verify comments/envs if needed |

## Task 1: Add shared session-queue constants

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/index.ts`
- Test: existing shared constant/type consumers via package build

- [ ] Step 1: Add `DEFAULT_JOBS_EXCHANGE_NAME`, `DEFAULT_SESSION_JOBS_QUEUE_PREFIX`, and `DEFAULT_SESSION_QUEUE_IDLE_TTL_MS = 3600000` to `packages/shared/src/constants.ts`.
- [ ] Step 2: Export those constants from `packages/shared/src/index.ts`.
- [ ] Step 3: Run `pnpm --filter @local-agent/shared exec tsc --noEmit`.
Expected: shared package compiles with the new constants.
- [ ] Step 4: Commit.
```bash
git add packages/shared/src/constants.ts packages/shared/src/index.ts
git commit -m "feat(shared): add session job queue constants"
```

## Task 2: Refactor RabbitMQService for per-session jobs

**Files:**
- Modify: `packages/api/src/services/rabbitmq.ts`
- Test: `packages/api/src/__tests__/services/rabbitmq.test.ts`

- [ ] Step 1: Write failing tests for asserting the jobs exchange, asserting a per-session queue with 1-hour expiry, and publishing with `session_id` as routing key.
- [ ] Step 2: Add session-queue naming helper(s) inside `rabbitmq.ts`.
- [ ] Step 3: Replace global jobs-queue methods with session-aware methods: ensure queue, publish, get-next, ack, nack.
- [ ] Step 4: Track in-flight deliveries per session queue, not in one global jobs map.
- [ ] Step 5: Run `pnpm --filter @local-agent/api test -- --run src/__tests__/services/rabbitmq.test.ts`.
Expected: new session-queue tests pass.
- [ ] Step 6: Commit.
```bash
git add packages/api/src/services/rabbitmq.ts packages/api/src/__tests__/services/rabbitmq.test.ts
git commit -m "feat(api): add session-scoped RabbitMQ job queues"
```

## Task 3: Add active-session discovery to job routes

**Files:**
- Modify: `packages/api/src/routes/jobs.ts`
- Modify: `packages/api/src/app.ts` if route wiring changes are needed
- Test: `packages/api/src/__tests__/routes/jobs.test.ts`

- [ ] Step 1: Write failing route tests for `POST /jobs` publishing to the session queue and `GET /jobs/sessions` returning active sessions.
- [ ] Step 2: Update `POST /jobs` to call the new session-aware publish path and mark the session active.
- [ ] Step 3: Add `GET /jobs/sessions` returning stable session descriptors for the daemon.
- [ ] Step 4: Make activation idempotent so repeated posts for one session do not duplicate entries.
- [ ] Step 5: Run `pnpm --filter @local-agent/api test -- --run src/__tests__/routes/jobs.test.ts`.
Expected: job-route tests cover session discovery and session-routed publishing.
- [ ] Step 6: Commit.
```bash
git add packages/api/src/routes/jobs.ts packages/api/src/app.ts packages/api/src/__tests__/routes/jobs.test.ts
git commit -m "feat(api): expose active session job queues"
```

## Task 4: Replace daemon shared-queue polling with per-session scheduling

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts`
- Modify: `packages/daemon/task/src/task-daemon.ts`
- Test: `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`
- Test: `packages/daemon/task/src/__tests__/task-poller.test.ts` if any shared-queue assumptions remain

- [ ] Step 1: Write failing daemon tests that prove strict FIFO within one session and preserved concurrency across different sessions.
- [ ] Step 2: Add API calls for discovering active sessions.
- [ ] Step 3: Refactor the daemon so it processes one stream per active session instead of one shared `/jobs/next` stream.
- [ ] Step 4: Enforce `MAX_CONCURRENT_SESSIONS` across active session processors.
- [ ] Step 5: Remove same-session NACK requeue scheduling from the normal path.
- [ ] Step 6: Run `pnpm --filter @local-agent/task-daemon test -- --run src/__tests__/task-poller.test.ts src/__tests__/task-poller-concurrent.test.ts`.
Expected: same-session FIFO tests pass and cross-session concurrency remains intact.
- [ ] Step 7: Commit.
```bash
git add packages/daemon/task/src/task-poller.ts packages/daemon/task/src/task-daemon.ts packages/daemon/task/src/__tests__/task-poller.test.ts packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts
git commit -m "feat(task-daemon): process per-session FIFO job queues"
```

## Task 5: Downgrade session lock from scheduler to safety net

**Files:**
- Modify: `packages/daemon/task/src/services/session-lock.ts`
- Test: `packages/daemon/task/src/services/__tests__/session-lock.test.ts`

- [ ] Step 1: Update tests so lock conflicts are treated as defensive failures, not the expected same-session queueing path.
- [ ] Step 2: Adjust implementation/logging only if needed to match the new role.
- [ ] Step 3: Run `pnpm --filter @local-agent/task-daemon test -- --run src/services/__tests__/session-lock.test.ts`.
Expected: lock tests still pass and document the reduced responsibility.
- [ ] Step 4: Commit.
```bash
git add packages/daemon/task/src/services/session-lock.ts packages/daemon/task/src/services/__tests__/session-lock.test.ts
git commit -m "test(task-daemon): redefine session lock as safety net"
```

## Task 6: Run targeted integration verification

**Files:**
- Modify: none unless regressions are found
- Test: API and task-daemon suites

- [ ] Step 1: Run `pnpm --filter @local-agent/api test`.
Expected: API tests pass with the new queue topology.
- [ ] Step 2: Run `pnpm --filter @local-agent/task-daemon test`.
Expected: daemon tests pass with strict per-session FIFO behavior.
- [ ] Step 3: If available, run a local smoke check with `docker compose up --build api task-enrichment-daemon task-daemon rabbitmq` and submit two same-session jobs plus one different-session job.
Expected: same-session jobs execute in submission order; different-session job can overlap.
- [ ] Step 4: Commit final fixes if any verification uncovered regressions.

## Review Notes

- The design-skill reviewer prompt files were not present in this workspace, so the document review step was completed as a manual self-review.
- This plan intentionally assumes a single `task-daemon` instance and no compatibility for legacy jobs already in the old shared `jobs` queue.
