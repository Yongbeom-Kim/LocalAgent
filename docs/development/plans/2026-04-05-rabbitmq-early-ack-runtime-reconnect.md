# RabbitMQ Early ACK and Runtime Reconnect Implementation Plan

**Goal:** Eliminate long-job RabbitMQ ACK timeouts by acknowledging jobs immediately after daemon acceptance, while making the API recover RabbitMQ connections/channels on demand during runtime outages.

**Architecture:** Keep the existing startup connect loop, but harden `RabbitMQService` with a shared reconnect gate that lazily recreates the connection/channel and reasserts topology when runtime requests hit a dead broker session. Move job ACK timing in the task-daemon from post-execution to pre-execution so the queue delivery lifetime ends at worker acceptance instead of job completion, and surface broker-reconnect failures from API publish/get routes as `503`.

**Tech Stack:** TypeScript, Express, amqplib, Vitest, Supertest, existing LocalAgent API/task-daemon packages.

---

## File Map

| File | Responsibility |
|------|----------------|
| `packages/api/src/services/rabbitmq.ts` | Shared runtime reconnect gate, reconnect-aware operation wrappers, stale-delivery invalidation, typed temporary-unavailable error |
| `packages/api/src/routes/tasks.ts` | Translate RabbitMQ temporary-unavailable errors to `503` for task publish/get requests |
| `packages/api/src/routes/jobs.ts` | Translate RabbitMQ temporary-unavailable errors to `503` for job publish/get requests; preserve `404` ACK/NACK semantics |
| `packages/api/src/routes/results.ts` | Translate RabbitMQ temporary-unavailable errors to `503` for result publish/get requests |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Unit coverage for reconnect sharing, reconnect retries, stale-delivery invalidation, and unavailable errors |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Route coverage for `503` task publish/get behavior |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Route coverage for `503` job publish/get behavior and unchanged `404` ACK semantics |
| `packages/api/src/__tests__/routes/results.test.ts` | Route coverage for `503` result publish/get behavior and unchanged `404` ACK semantics |
| `packages/daemon/task/src/task-poller.ts` | ACK immediately after job fetch and before execution/result publish |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Verify new request ordering and "do not execute when ACK fails" behavior |
| `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` | Preserve per-session FIFO/concurrency guarantees under early ACK ordering |
| `docs/development/design/2026-04-05-rabbitmq-early-ack-runtime-reconnect-design.md` | Approved design reference |

### Task 1: Add RabbitMQ temporary-unavailable and reconnect state coverage first

**Files:**
- Modify: `packages/api/src/__tests__/services/rabbitmq.test.ts`

- [ ] **Step 1: Add failing tests for reconnect-on-demand and shared reconnect gating**

Extend `packages/api/src/__tests__/services/rabbitmq.test.ts` with focused failing tests that describe the desired service contract before implementation.

Add coverage for:

```ts
it('reconnects on demand when a publish is attempted after connection loss', async () => {
  // connect once, simulate close/error clearing state, then ensure publish triggers a fresh connect
});

it('shares one reconnect attempt across concurrent callers', async () => {
  // publish() and getNext() race while disconnected, but amqplib.connect is only called once
});

it('clears stale delivery maps when reconnecting after channel loss', async () => {
  // fetch a message, simulate channel death, reconnect, then ack returns false
});

it('throws RabbitMQUnavailableError when reconnect cannot establish a channel', async () => {
  // amqplib.connect rejects for the operation-triggered reconnect path
});
```

Test-shape requirements:

- keep using the existing `vi.mock('amqplib', ...)` harness;
- add enough mock connection/channel instances to simulate a second successful connect after the first one dies;
- assert that stale ACKs are rejected after reconnect instead of being applied to the replacement channel;
- assert that concurrent reconnect callers share a single in-flight reconnect promise.

- [ ] **Step 2: Run the API RabbitMQ service tests to verify failure**

Run: `npm test --prefix packages/api -- src/__tests__/services/rabbitmq.test.ts`
Expected: new tests fail because reconnect gating and typed temporary-unavailable behavior do not exist yet.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/__tests__/services/rabbitmq.test.ts
git commit -m "test(api): cover rabbitmq runtime reconnect behavior"
```

### Task 2: Implement `RabbitMQService` runtime reconnect gate

**Files:**
- Modify: `packages/api/src/services/rabbitmq.ts`

- [ ] **Step 1: Introduce explicit reconnect state and a typed unavailable error**

In `packages/api/src/services/rabbitmq.ts`, add:

```ts
export class RabbitMQUnavailableError extends Error {
  constructor(message = 'RabbitMQ temporarily unavailable') {
    super(message);
    this.name = 'RabbitMQUnavailableError';
  }
}
```

Add service state for:

- `reconnectPromise`
- `closing`
- a delivery/channel generation token or equivalent stale-delivery invalidation mechanism

Add small private helpers for:

- attaching connection listeners
- clearing live handles and stale deliveries
- asserting the queue/exchange topology on a newly created channel

Implementation constraints:

- do not change the external queue/exchange names or binding topology;
- do not change startup callers yet;
- keep comments short but explicit around stale-delivery invalidation so future maintainers understand the accepted `404`/redelivery trade-off.

- [ ] **Step 2: Implement `ensureConnected()` and single-attempt operation retry wrappers**

Refactor the service so publish/get operations go through a small reconnect-aware wrapper.

Target behavior:

1. if a valid channel exists, use it;
2. if not, await `ensureConnected()`;
3. if the broker call throws a connection/channel-closed error, clear state, reconnect once, and retry once;
4. if reconnect still fails, throw `RabbitMQUnavailableError`.

Apply this pattern to:

- `publish` (change signature to `Promise<boolean>`)
- `publishJob`
- `ensureSessionJobQueue`
- `getNext`
- `getNextJobFromSession`
- `publishToExchange` (change signature to `Promise<boolean>`)
- `getNextFromQueue`

For ACK/NACK methods, keep them conservative:

- do not reconnect to ACK stale deliveries;
- return `false` if the delivery map entry is gone or invalid after reconnect.

- [ ] **Step 3: Run the service tests to verify they pass**

Run: `npm test --prefix packages/api -- src/__tests__/services/rabbitmq.test.ts`
Expected: all RabbitMQ service tests pass, including the new reconnect and stale-delivery coverage.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/services/rabbitmq.ts packages/api/src/__tests__/services/rabbitmq.test.ts
git commit -m "feat(api): reconnect rabbitmq on demand at runtime"
```

### Task 3: Add API route-level `503` handling for runtime broker outages

**Files:**
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/api/src/routes/jobs.ts`
- Modify: `packages/api/src/routes/results.ts`
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`
- Modify: `packages/api/src/__tests__/routes/jobs.test.ts`
- Modify: `packages/api/src/__tests__/routes/results.test.ts`

- [ ] **Step 1: Write failing route tests for `503` temporary-unavailable responses**

Update the route tests so the mocked RabbitMQ service can throw `RabbitMQUnavailableError` from publish/get paths.

Add cases like:

```ts
it('returns 503 when task publish cannot reconnect to RabbitMQ', async () => {
  mockRabbitMQ.publish.mockImplementationOnce(() => {
    throw new RabbitMQUnavailableError();
  });
});

it('returns 503 when job fetch cannot reconnect to RabbitMQ', async () => {
  mockRabbitMQ.getNextJobFromSession.mockRejectedValueOnce(new RabbitMQUnavailableError());
});

it('returns 503 when result fetch cannot reconnect to RabbitMQ', async () => {
  mockRabbitMQ.getNextFromQueue.mockRejectedValueOnce(new RabbitMQUnavailableError());
});
```

Preserve the existing ACK/NACK expectations:

- `404` remains the response when `ackJobFromSession`, `nackJobFromSession`, or `ackFromQueue` returns `false`.

Because `publish(...)` and `publishToExchange(...)` become async in Task 2, update the route mocks and assertions accordingly:

- use `mockResolvedValue(...)` for successful publish paths where the route now awaits the RabbitMQ call;
- keep the temporary-unavailable cases as thrown/rejected `RabbitMQUnavailableError` values;
- make sure the route tests still prove that non-broker exceptions fall through to the normal error path rather than being mislabeled as `503`.

- [ ] **Step 2: Update the route implementations to map only the typed broker error to `503`**

Modify each route file to catch `RabbitMQUnavailableError` locally and return:

```json
{ "error": "RabbitMQ temporarily unavailable" }
```

or an equivalent short transient message.

Implementation constraints:

- do not route all exceptions to `503`;
- validation errors remain `400`;
- missing delivery ACKs remain `404`;
- unknown bugs still flow to the generic error handler.

- [ ] **Step 3: Run the route tests to verify they pass**

Run: `npm test --prefix packages/api -- src/__tests__/routes/tasks.test.ts src/__tests__/routes/jobs.test.ts src/__tests__/routes/results.test.ts`
Expected: route suites pass with new `503` coverage and unchanged validation/ACK semantics.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/tasks.ts packages/api/src/routes/jobs.ts packages/api/src/routes/results.ts packages/api/src/__tests__/routes/tasks.test.ts packages/api/src/__tests__/routes/jobs.test.ts packages/api/src/__tests__/routes/results.test.ts
git commit -m "feat(api): return 503 during rabbitmq runtime recovery"
```

### Task 4: Move task-daemon job ACK to pre-execution acceptance

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts`
- Modify: `packages/daemon/task/src/__tests__/task-poller.test.ts`

- [ ] **Step 1: Write failing task-poller tests for early ACK ordering**

Update `packages/daemon/task/src/__tests__/task-poller.test.ts` so the expected request order becomes:

1. `GET /jobs/sessions`
2. `GET /jobs/next/:sessionId`
3. `POST /jobs/:sessionId/:jobId/ack`
4. executor runs
5. `POST /results`

Add a new failing test for the refusal-to-execute case:

```ts
it('does not execute a fetched job when the immediate ACK request fails', async () => {
  // fetch succeeds, ACK returns 404 or 500, executor should not be called
});
```

Update any existing tests that currently assume ACK happens after result publish.

- [ ] **Step 2: Implement the acceptance-before-execution ordering in `TaskPoller`**

Change `executeJob(job)` so it:

1. acquires the session lock;
2. calls `/jobs/${sessionId}/${jobId}/ack` immediately;
3. if ACK fails or is non-200, logs and exits without calling `orchestrator.handle(job)`;
4. if ACK succeeds, continues with execution and then posts `/results`.

Implementation constraints:

- remove the old final ACK request after result publish;
- keep existing result-post behavior otherwise intact;
- preserve lock release and session cleanup in `finally`.

- [ ] **Step 3: Run the task-poller unit tests**

Run: `npm test --prefix packages/daemon/task -- src/__tests__/task-poller.test.ts`
Expected: early-ACK ordering tests pass and the daemon no longer executes jobs when the acceptance ACK fails.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/task/src/task-poller.ts packages/daemon/task/src/__tests__/task-poller.test.ts
git commit -m "feat(task-daemon): ack jobs before execution"
```

### Task 5: Revalidate per-session FIFO and concurrency under early ACK ordering

**Files:**
- Modify: `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`

- [ ] **Step 1: Adjust concurrent tests to reflect the new ACK-before-results sequence**

Update `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` so any mocked fetch sequence that previously expected result-post then ACK now expects ACK to happen before execution completes.

Keep the behavioral assertions focused on:

- different sessions can still run concurrently;
- the same session still processes jobs FIFO across repeated polls;
- cleanup jobs still respect the same session ordering.

Add at least one explicit assertion that early ACK does not cause a second job from the same session to start before the first session lock is released. Note in the test name or a short comment that ordering is protected by `activeSessions` plus `SessionLockManager`, not by leaving the broker delivery unacked.

- [ ] **Step 2: Run the concurrent task-poller tests**

Run: `npm test --prefix packages/daemon/task -- src/__tests__/task-poller-concurrent.test.ts`
Expected: concurrency and FIFO tests pass with the new request ordering.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts
git commit -m "test(task-daemon): preserve fifo semantics with early ack"
```

### Task 6: Run package-level verification and inspect the diff

**Files:**
- Modify: `packages/api/src/services/rabbitmq.ts`
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/api/src/routes/jobs.ts`
- Modify: `packages/api/src/routes/results.ts`
- Modify: `packages/api/src/__tests__/services/rabbitmq.test.ts`
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`
- Modify: `packages/api/src/__tests__/routes/jobs.test.ts`
- Modify: `packages/api/src/__tests__/routes/results.test.ts`
- Modify: `packages/daemon/task/src/task-poller.ts`
- Modify: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Modify: `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`

- [ ] **Step 1: Run the full API test suite**

Run: `npm test --prefix packages/api`
Expected: all API tests pass, including route and RabbitMQ service coverage.

- [ ] **Step 2: Run the full task-daemon test suite**

Run: `npm test --prefix packages/daemon/task`
Expected: task-daemon tests pass with no regression in locking, FIFO, or result reporting.

- [ ] **Step 3: Review the final diff carefully**

Run: `git diff -- packages/api/src/services/rabbitmq.ts packages/api/src/routes/tasks.ts packages/api/src/routes/jobs.ts packages/api/src/routes/results.ts packages/api/src/__tests__/services/rabbitmq.test.ts packages/api/src/__tests__/routes/tasks.test.ts packages/api/src/__tests__/routes/jobs.test.ts packages/api/src/__tests__/routes/results.test.ts packages/daemon/task/src/task-poller.ts packages/daemon/task/src/__tests__/task-poller.test.ts packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`

Review checklist:

- reconnect comments clearly explain why stale deliveries are cleared and why post-reconnect ACK can return `404`;
- only RabbitMQ temporary-unavailable paths map to `503`;
- task-daemon no longer ACKs after result posting;
- immediate ACK failure prevents execution.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/services/rabbitmq.ts packages/api/src/routes/tasks.ts packages/api/src/routes/jobs.ts packages/api/src/routes/results.ts packages/api/src/__tests__/services/rabbitmq.test.ts packages/api/src/__tests__/routes/tasks.test.ts packages/api/src/__tests__/routes/jobs.test.ts packages/api/src/__tests__/routes/results.test.ts packages/daemon/task/src/task-poller.ts packages/daemon/task/src/__tests__/task-poller.test.ts packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts
git commit -m "feat: add rabbitmq runtime recovery and early job ack"
```
