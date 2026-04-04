# RabbitMQ Broker-Backed Session Queue Discovery Implementation Plan

**Goal:** Replace API-managed active session tracking with RabbitMQ management-backed session queue discovery for `GET /jobs/sessions`.

**Architecture:** The API continues to own all RabbitMQ integration. AMQP remains responsible for queue assertion, publish, fetch, and ack/nack; queue discovery moves to the RabbitMQ management HTTP API, with connection details derived from `RABBITMQ_URL`. The task daemon remains pull-based and continues polling `/jobs/sessions`, treating `503` as a transient empty cycle.

**Tech Stack:** TypeScript, Node.js 20, Express, RabbitMQ (`amqplib` + management HTTP API), Vitest, Supertest, Rush monorepo

---

## File Map

| File | Responsibility |
|------|----------------|
| `packages/shared/src/config.ts` | Parse `RABBITMQ_URL` and expose management-derivation helper(s) or config shape |
| `packages/shared/src/__tests__/config.test.ts` | Verify management derivation and invalid URL handling |
| `packages/shared/src/index.ts` | Export new config helper/type if needed |
| `packages/api/src/services/rabbitmq.ts` | Remove manual active-session tracking and add broker-backed session discovery via management HTTP API |
| `packages/api/src/routes/jobs.ts` | Return broker-derived session descriptors and map discovery failures to `503` |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Cover management-backed session discovery, filtering, sorting, and failure behavior |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Cover `GET /jobs/sessions` success and `503` behavior |
| `packages/daemon/task/src/task-poller.ts` | Keep poll model unchanged but handle `/jobs/sessions` `503` explicitly as a warning/empty cycle |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Verify daemon behavior when `/jobs/sessions` returns `503` and then recovers |

## Task 1: Add RabbitMQ management URL derivation in shared config

**Files:**
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/config.test.ts`

- [ ] Step 1: Write failing config tests for deriving management details from `RABBITMQ_URL`.

```ts
it('derives RabbitMQ management access from a standard amqp URL', () => {
  const management = deriveRabbitMqManagementConfig('amqp://guest:guest@rabbitmq:5672');
  expect(management.baseUrl).toBe('http://rabbitmq:15672');
  expect(management.username).toBe('guest');
  expect(management.password).toBe('guest');
  expect(management.vhost).toBe('/');
  expect(management.encodedVhost).toBe('%2F');
});

it('treats an explicit trailing slash as the default vhost', () => {
  const management = deriveRabbitMqManagementConfig('amqp://guest:guest@rabbitmq:5672/');
  expect(management.vhost).toBe('/');
  expect(management.encodedVhost).toBe('%2F');
});

it('derives encoded vhost when amqp URL includes a vhost path', () => {
  const management = deriveRabbitMqManagementConfig('amqp://guest:guest@rabbitmq:5672/my-vhost');
  expect(management.vhost).toBe('my-vhost');
  expect(management.encodedVhost).toBe('my-vhost');
});

it('throws when rabbitmq url does not include username/password (required for management discovery)', () => {
  expect(() => deriveRabbitMqManagementConfig('amqp://rabbitmq:5672/my-vhost')).toThrow();
});

it('throws when rabbitmq url is not parseable for management discovery', () => {
  expect(() => deriveRabbitMqManagementConfig('not-a-url')).toThrow();
});
```

- [ ] Step 2: Run the shared config test file to verify the new tests fail.

Run: `rush test --to @local-agent/shared -- --run src/__tests__/config.test.ts`
Expected: FAIL because the management derivation helper does not exist yet.

- [ ] Step 3: Add a focused helper in `packages/shared/src/config.ts` that parses `RABBITMQ_URL` and returns:

```ts
type RabbitMqManagementConfig = {
  baseUrl: string;
  username: string;
  password: string;
  vhost: string;
  encodedVhost: string;
};

Implementation notes (so callers don’t have to infer behavior):

- Host is taken from `RABBITMQ_URL` hostname.
- Management protocol is `http` and port is always `15672`.
- If the URL has no vhost segment (or is exactly `/`), vhost is `/`.
- If the URL includes a vhost segment, decode it first (RabbitMQ allows URL-encoded vhosts in URLs), then set:
  - `vhost` to the decoded value
  - `encodedVhost` to `encodeURIComponent(vhost)`
- If `RABBITMQ_URL` is missing username or password, throw (design requires discovery to fail in that case).
```

- [ ] Step 4: Export the helper/type from `packages/shared/src/index.ts` if the API package will import it from `@local-agent/shared`.

- [ ] Step 5: Re-run the shared config test file.

Run: `rush test --to @local-agent/shared -- --run src/__tests__/config.test.ts`
Expected: PASS.

- [ ] Step 6: Commit the shared config change.

```bash
git add packages/shared/src/config.ts packages/shared/src/index.ts packages/shared/src/__tests__/config.test.ts
git commit -m "feat(shared): derive rabbitmq management config from amqp url"
```

## Task 2: Replace manual session tracking with broker-backed discovery in RabbitMQService

**Files:**
- Modify: `packages/api/src/services/rabbitmq.ts`
- Test: `packages/api/src/__tests__/services/rabbitmq.test.ts`

- [ ] Step 1: Write failing service tests for broker-backed session discovery.

```ts
it('lists session queues from rabbitmq management sorted by queue_name', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve([
      { name: 'jobs.session.session-b' },
      { name: 'tasks' },
      { name: 'jobs.session.session-a' },
    ]),
  });

  const sessions = await service.listSessionQueues();

  expect(sessions).toEqual([
    { session_id: 'session-a', queue_name: 'jobs.session.session-a' },
    { session_id: 'session-b', queue_name: 'jobs.session.session-b' },
  ]);
});

it('throws when rabbitmq management returns non-2xx', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('unavailable') });
  await expect(service.listSessionQueues()).rejects.toThrow();
});
```

- [ ] Step 2: Run the RabbitMQ service test file to verify the new tests fail.

Run: `rush test --to @local-agent/api -- --run src/__tests__/services/rabbitmq.test.ts`
Expected: FAIL because broker-backed session discovery is not implemented.

- [ ] Step 3: Add broker-backed session discovery to `RabbitMQService` using `fetch()` against the derived management endpoint and HTTP Basic Auth.

  - Use Node 20 built-in `fetch()` (no new dependency).
  - Send `Authorization: Basic <base64(username:password)>`.
  - Set a short request timeout via `AbortController` (e.g. 2s-5s) so `/jobs/sessions` failure is prompt and deterministic.

- [ ] Step 4: Remove `activeSessionQueues` and any add/remove behavior tied to publish or empty queue reads.

- [ ] Step 5: Replace `listActiveSessions()` with a broker-backed method such as `listSessionQueues()` that:
  - queries `/api/queues/{encodedVhost}`
  - filters by `DEFAULT_SESSION_JOBS_QUEUE_PREFIX + '.'`
  - maps queue name back to `session_id`
  - sorts by `queue_name` ascending

  Success criteria:

  - The returned list includes *all existing* `jobs.session.*` queues (including empty queues).
  - Returned order is stable: strictly ascending by `queue_name`.

- [ ] Step 6: Preserve existing publish/get/ack/nack AMQP behavior unchanged apart from removing manual tracking side effects.

- [ ] Step 7: Re-run the RabbitMQ service test file.

Run: `rush test --to @local-agent/api -- --run src/__tests__/services/rabbitmq.test.ts`
Expected: PASS.

- [ ] Step 8: Commit the RabbitMQ service refactor.

```bash
git add packages/api/src/services/rabbitmq.ts packages/api/src/__tests__/services/rabbitmq.test.ts
git commit -m "feat(api): discover session queues from rabbitmq management"
```

## Task 3: Update `/jobs/sessions` to return broker-backed data and `503` on discovery failure

**Files:**
- Modify: `packages/api/src/routes/jobs.ts`
- Test: `packages/api/src/__tests__/routes/jobs.test.ts`

- [ ] Step 1: Write failing route tests for broker-backed discovery success and `503` failure.

```ts
it('returns broker-backed session queues', async () => {
  mockRabbitMQ.listSessionQueues.mockResolvedValueOnce([
    { session_id: 'session-a', queue_name: 'jobs.session.session-a' },
  ]);

  const res = await request(app).get('/jobs/sessions');

  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    sessions: [{ session_id: 'session-a', queue_name: 'jobs.session.session-a' }],
  });
});

it('returns 503 when broker-backed discovery fails', async () => {
  mockRabbitMQ.listSessionQueues.mockRejectedValueOnce(new Error('management unavailable'));

  const res = await request(app).get('/jobs/sessions');

  expect(res.status).toBe(503);
  expect(res.body).toEqual({ error: 'Session queue discovery unavailable' });
});
```

- [ ] Step 2: Run the jobs route test file to verify the new tests fail.

Run: `rush test --to @local-agent/api -- --run src/__tests__/routes/jobs.test.ts`
Expected: FAIL because the route still calls `listActiveSessions()` synchronously.

- [ ] Step 3: Update `GET /jobs/sessions` to await the new broker-backed service method and convert service errors into `503` with the explicit response body.

  Success criteria:

  - 200 response body matches `{ sessions: SessionJobDescriptor[] }`.
  - On any management query failure, route returns `503 { error: 'Session queue discovery unavailable' }`.

- [ ] Step 4: Keep `POST /jobs` behavior unchanged apart from no longer depending on any session-activation side effect.

- [ ] Step 5: Re-run the jobs route test file.

Run: `rush test --to @local-agent/api -- --run src/__tests__/routes/jobs.test.ts`
Expected: PASS.

- [ ] Step 6: Commit the route update.

```bash
git add packages/api/src/routes/jobs.ts packages/api/src/__tests__/routes/jobs.test.ts
git commit -m "feat(api): return 503 when session discovery is unavailable"
```

## Task 4: Keep task-daemon polling behavior but handle `/jobs/sessions` `503` explicitly

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts`
- Test: `packages/daemon/task/src/__tests__/task-poller.test.ts`

- [ ] Step 1: Write failing daemon tests for `503` handling and recovery on the next poll cycle.

```ts
it('treats 503 from /jobs/sessions as an empty cycle', async () => {
  mockFetch.mockResolvedValueOnce({ status: 503, json: () => Promise.resolve({ error: 'Session queue discovery unavailable' }) });

  await expect(poller.pollOnce()).resolves.toBeUndefined();
  expect(mockClaudeExecute).not.toHaveBeenCalled();
});

it('recovers on the next successful poll after a 503 discovery failure', async () => {
  mockFetch
    .mockResolvedValueOnce({ status: 503, json: () => Promise.resolve({ error: 'Session queue discovery unavailable' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ sessions: [{ session_id: 'session-789', queue_name: 'jobs.session.session-789' }] }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(job) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();
  await poller.pollOnce();
  await poller.drain();

  expect(mockClaudeExecute).toHaveBeenCalledTimes(1);
});
```

- [ ] Step 2: Run the task poller test file to verify the new tests fail or expose ambiguous handling.

Run: `rush test --to @local-agent/task-daemon -- --run src/__tests__/task-poller.test.ts`
Expected: FAIL or incomplete behavior around explicit `503` handling.

- [ ] Step 3: Update `fetchMessageQueueActiveSessions()` so `503` is treated as a warning and returns `[]`, while preserving the existing no-crash behavior for other fetch failures.

  Notes:

  - Existing code already treats any non-200 as an empty list; tighten logging so `503` is specifically called out as session discovery unavailable (warn level), while other statuses remain generic.

- [ ] Step 4: Keep the daemon pull cadence unchanged. Do not add retry or exponential backoff logic.

- [ ] Step 5: Re-run the task poller test file.

Run: `rush test --to @local-agent/task-daemon -- --run src/__tests__/task-poller.test.ts`
Expected: PASS.

- [ ] Step 6: Commit the daemon update.

```bash
git add packages/daemon/task/src/task-poller.ts packages/daemon/task/src/__tests__/task-poller.test.ts
git commit -m "feat(task-daemon): tolerate session discovery 503 responses"
```

## Task 5: Run focused verification across shared, API, and daemon packages

**Files:**
- Modify: none unless regressions are found
- Test: shared, API, and task-daemon suites

- [ ] Step 1: Run the shared package tests.

Run: `rush test --to @local-agent/shared`
Expected: PASS.

- [ ] Step 2: Run the API package tests.

Run: `rush test --to @local-agent/api`
Expected: PASS.

- [ ] Step 3: Run the task-daemon package tests.

Run: `rush test --to @local-agent/task-daemon`
Expected: PASS.

- [ ] Step 4: If Docker smoke testing is available, verify live broker-backed discovery manually.

Run: `docker compose up -d rabbitmq api task-daemon`
Expected: services start successfully.

- [ ] Step 4a: Create a session queue (so discovery has something to return).

Run: `curl -sS -X POST http://localhost:3000/jobs -H 'Content-Type: application/json' -d '{"task_id":"t1","task_type":"shell","payload":"echo hi","executors":[{"executor":"claude","executor_model":"sonnet"}],"submitted_at":"2026-04-04T00:00:00.000Z","session_id":"session-1"}'`
Expected: `201` and response JSON includes `session_id: "session-1"`.

- [ ] Step 5: If the stack is up, query the endpoint directly.

Run: `curl -sS http://localhost:3000/jobs/sessions`
Expected: `200` and `sessions` includes an entry with `queue_name: "jobs.session.session-1"`, or `503` only if the management endpoint is actually unreachable/misconfigured.

- [ ] Step 6: Commit any final verification-driven fixes.

```bash
git add <files if needed>
git commit -m "test: verify broker-backed session discovery"
```

## Review Notes

- This plan intentionally keeps the daemon’s polling model intact and does not add retry/backoff logic.
- The plan assumes `RABBITMQ_URL` includes credentials. If an environment omits them, `/jobs/sessions` is expected to return `503` by design.
- The plan is scoped to the configured vhost only and does not add separate management URL configuration.
