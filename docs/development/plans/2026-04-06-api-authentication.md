# API Layer Bearer Authentication Implementation Plan

**Goal:** Protect every LocalAgent API route except `/health` with shared bearer-token authentication, and update all first-party callers, tests, and docs to match the new contract.

**Architecture:** Add shared auth config and header helpers in `@local-agent/shared`, then enforce auth centrally in the API app with a dedicated Express middleware mounted for everything except `/health`. Update each CLI/daemon HTTP client to read the same env contract, attach `Authorization: Bearer ...`, and treat `401`/`403` as configuration failures instead of retryable transport errors.

**Tech Stack:** TypeScript, Express, Commander, Node `fetch`, Vitest, Supertest, existing LocalAgent monorepo packages.

---

## File Map

| File | Responsibility |
|------|----------------|
| `packages/shared/src/config.ts` | Add auth env parsing and fail-fast config helpers |
| `packages/shared/src/index.ts` | Export new auth config/helper APIs |
| `packages/shared/src/__tests__/config.test.ts` | Cover auth env parsing and fail-fast behavior |
| `packages/shared/src/api-auth.ts` | Shared bearer-token header builder and client token resolver |
| `packages/shared/src/__tests__/api-auth.test.ts` | Cover header formatting and client token precedence |
| `packages/api/src/app.ts` | Mount `/health` before auth and protect all remaining routes |
| `packages/api/src/index.ts` | Fail fast on missing token when auth is enabled |
| `packages/api/src/middleware/auth.ts` | Enforce bearer auth and log failures safely at debug level |
| `packages/api/src/__tests__/middleware/auth.test.ts` | Direct middleware coverage for `401`, `403`, bypass, and header parsing |
| `packages/api/src/__tests__/routes/*.test.ts` | Prove protected routes require auth while `/health` remains public |
| `packages/cli/src/commands/submit.ts` | Add `--token`, env fallback, fail-fast validation, and auth headers |
| `packages/cli/src/__tests__/submit.test.ts` | CLI coverage for token precedence and header emission |
| `packages/daemon/task-enrichment/src/config.ts` | Read API auth client config for enrichment daemon |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Attach auth headers to `/tasks`, `/jobs`, `/results`, and `/tasks/:id/ack` calls |
| `packages/daemon/task-enrichment/src/adapters/task-phase-publisher.ts` | Attach auth headers to phase publish calls |
| `packages/daemon/task-enrichment/src/__tests__/config.test.ts` | Cover auth-enabled and bypass config behavior |
| `packages/daemon/task/src/task-poller.ts` | Attach auth headers to all job/result/ack requests and warn on `401`/`403` |
| `packages/daemon/task/src/adapters/task-phase-publisher.ts` | Attach auth headers to phase publish calls |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Cover auth headers and `401`/`403` warning behavior |
| `packages/daemon/task/src/task-daemon.ts` | Load auth client config at startup (fail-fast unless disabled) and pass token into poller/publishers |
| `packages/daemon/lark-listener/src/config.ts` | Read API auth client config |
| `packages/daemon/lark-listener/src/adapters/task-submitter.ts` | Attach auth headers to `/tasks` and `/results` requests |
| `packages/daemon/lark-listener/src/__tests__/config.test.ts` | Cover auth-enabled and bypass config behavior |
| `packages/daemon/lark-result/src/config.ts` | Read API auth client config |
| `packages/daemon/lark-result/src/lark-poller.ts` | Attach auth headers to result poll/ack requests and warn on auth failures |
| `packages/daemon/lark-result/src/__tests__/config.test.ts` | Cover auth-enabled and bypass config behavior |
| `packages/daemon/lark-result/src/__tests__/lark-poller.test.ts` | Cover auth headers and auth-failure handling |
| `packages/daemon/telegram-result/src/config.ts` | Read API auth client config |
| `packages/daemon/telegram-result/src/telegram-poller.ts` | Attach auth headers to result poll/ack requests and warn on auth failures |
| `packages/daemon/telegram-result/src/__tests__/config.test.ts` | Cover auth-enabled and bypass config behavior |
| `packages/daemon/telegram-result/src/__tests__/telegram-poller.test.ts` | Cover auth headers and auth-failure handling |
| `.env.example` | Document `API_AUTH_TOKEN` and `API_AUTH_DISABLED` |
| `docs/LOCAL_DEVELOPMENT.md` | Document auth setup, bypass usage, and affected commands |
| `docs/development/design/2026-04-06-api-authentication-design.md` | Approved spec reference |

### Task 1: Add shared auth config and helper coverage first

**Files:**
- Create: `packages/shared/src/api-auth.ts`
- Create: `packages/shared/src/__tests__/api-auth.test.ts`
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/__tests__/config.test.ts`

- [ ] **Step 1: Write failing shared tests for auth env parsing and header construction**

Extend `packages/shared/src/__tests__/config.test.ts` and add `packages/shared/src/__tests__/api-auth.test.ts` with cases like:

```ts
it('enables auth by default and requires API_AUTH_TOKEN', () => {
  expect(() => loadApiAuthConfig({})).toThrow('API_AUTH_TOKEN is required');
});

it('allows missing token when API_AUTH_DISABLED is 1', () => {
  expect(loadApiAuthConfig({ API_AUTH_DISABLED: '1' })).toEqual({ enabled: false });
});

it('builds bearer headers only when a client token is configured', () => {
  expect(buildApiAuthHeaders('secret')).toEqual({ Authorization: 'Bearer secret' });
  expect(buildApiAuthHeaders(undefined)).toEqual({});
});
```

Also cover trim behavior and the client-side precedence helper that prefers an explicit token over env.

- [ ] **Step 2: Run the shared tests to verify failure**

Run: `npm test --prefix packages/shared -- src/__tests__/config.test.ts src/__tests__/api-auth.test.ts`
Expected: FAIL because auth config exports and helper module do not exist yet.


- [ ] **Step 3: Implement shared auth config and header helpers**

Add shared auth env parsing in `packages/shared/src/config.ts`, and keep client header helpers in a focused `packages/shared/src/api-auth.ts`.

```ts
export interface ApiAuthConfig {
  enabled: boolean;
  token?: string;
}

// packages/shared/src/config.ts
export function loadApiAuthConfig(env: Record<string, string | undefined> = process.env): ApiAuthConfig {
  if (env.API_AUTH_DISABLED?.trim() === '1') {
    return { enabled: false };
  }

  const token = requireEnvValue(env, 'API_AUTH_TOKEN');
  return { enabled: true, token };
}

// packages/shared/src/api-auth.ts
export function resolveApiClientToken(opts: {
  explicitToken?: string;
  env: Record<string, string | undefined>;
}): string | undefined {
  const fromFlag = opts.explicitToken?.trim();
  if (fromFlag) return fromFlag;

  const fromEnv = opts.env.API_AUTH_TOKEN?.trim();
  return fromEnv || undefined;
}

export function buildApiAuthHeaders(token?: string): Record<string, string> {
  const trimmed = token?.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}
```

Export the new APIs through `packages/shared/src/index.ts`. Keep helper responsibilities narrow: env parsing/validation (config) and header/precedence construction (api-auth).

Note: the design spec does not mandate a specific helper name or exact signature for client token precedence. The intent is to standardize header construction and keep precedence logic shared. If `resolveApiClientToken(...)` is unnecessary for the existing call sites, it can be skipped.

- [ ] **Step 4: Run the shared tests to verify they pass**

Run: `npm test --prefix packages/shared -- src/__tests__/config.test.ts src/__tests__/api-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api-auth.ts packages/shared/src/__tests__/api-auth.test.ts packages/shared/src/config.ts packages/shared/src/index.ts packages/shared/src/__tests__/config.test.ts
git commit -m "feat(shared): add api auth config helpers"
```

### Task 2: Add API auth middleware and protect everything except `/health`

**Files:**
- Create: `packages/api/src/middleware/auth.ts`
- Create: `packages/api/src/__tests__/middleware/auth.test.ts`
- Modify: `packages/api/src/app.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`
- Modify: `packages/api/src/__tests__/routes/jobs.test.ts`
- Modify: `packages/api/src/__tests__/routes/results.test.ts`
- Modify: `packages/api/src/__tests__/routes/health.test.ts`

- [ ] **Step 1: Write failing API tests for protected and public routes**

Add direct middleware tests in `packages/api/src/__tests__/middleware/auth.test.ts` covering:

```ts
it('returns 401 when authorization header is missing', async () => {});
it('returns 401 when scheme is not bearer', async () => {});
it('returns 403 when bearer token does not match', async () => {});
it('calls next when token matches', async () => {});
it('bypasses auth when API_AUTH_DISABLED is 1', async () => {});
```

Then update route tests so protected endpoints fail without auth and succeed with a valid bearer token, while `/health` still returns `200` without credentials.

- [ ] **Step 2: Run API route and middleware tests to verify failure**

Run: `npm test --prefix packages/api -- src/__tests__/middleware/auth.test.ts src/__tests__/routes/health.test.ts src/__tests__/routes/tasks.test.ts src/__tests__/routes/jobs.test.ts src/__tests__/routes/results.test.ts`
Expected: FAIL because the middleware and protected-route wiring do not exist yet.

- [ ] **Step 3: Implement auth middleware and app wiring**

Create `packages/api/src/middleware/auth.ts` with a constructor like:

```ts
export function createApiAuthMiddleware(config: ApiAuthConfig): RequestHandler {
  return (req, res, next) => {
    if (!config.enabled) return next();
    const header = req.header('authorization')?.trim();
    if (!header) return res.status(401).json({ error: 'Unauthorized' });

    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return res.status(401).json({ error: 'Unauthorized' });
    if (match[1] !== config.token) return res.status(403).json({ error: 'Forbidden' });
    return next();
  };
}
```

Use `createLogger('api')` or a local logger to emit debug-only failure-class logs without leaking the header value. Update `packages/api/src/app.ts` so `/health` is mounted before the auth middleware and all remaining routes are mounted behind it. In `packages/api/src/index.ts`, call the shared auth config loader before starting the server so missing tokens fail fast.

Also make the auth wiring explicit and testable by injecting auth config:

- Change `createApp(rabbitmq: RabbitMQService)` to `createApp(rabbitmq: RabbitMQService, auth: ApiAuthConfig)`.
- In `packages/api/src/index.ts`, load `const auth = loadApiAuthConfig(process.env)` (or the defaulted helper) before constructing the app, and pass it into `createApp(rabbitmq, auth)`.
- In API tests, build apps by passing `{ enabled: true, token: 'secret' }` (or `{ enabled: false }`) rather than relying on global `process.env` mutation.

- [ ] **Step 4: Run the API tests to verify they pass**

Run: `npm test --prefix packages/api -- src/__tests__/middleware/auth.test.ts src/__tests__/routes/health.test.ts src/__tests__/routes/tasks.test.ts src/__tests__/routes/jobs.test.ts src/__tests__/routes/results.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/middleware/auth.ts packages/api/src/__tests__/middleware/auth.test.ts packages/api/src/app.ts packages/api/src/index.ts packages/api/src/__tests__/routes/health.test.ts packages/api/src/__tests__/routes/tasks.test.ts packages/api/src/__tests__/routes/jobs.test.ts packages/api/src/__tests__/routes/results.test.ts
git commit -m "feat(api): protect non-health routes with bearer auth"
```

### Task 3: Update CLI token handling and submission headers

**Files:**
- Modify: `packages/cli/src/commands/submit.ts`
- Modify: `packages/cli/src/__tests__/submit.test.ts`

- [ ] **Step 1: Write failing CLI tests for token precedence and fail-fast validation**

Add cases like:

```ts
it('sends Authorization bearer header from explicit --token', async () => {});
it('uses API_AUTH_TOKEN when --token is omitted', async () => {});
it('prefers --token over API_AUTH_TOKEN', async () => {});
it('fails fast when auth is enabled and no token is configured', async () => {});
```

Verify the expected request shape includes both `Content-Type` and `Authorization` when auth is enabled.

- [ ] **Step 2: Run CLI tests to verify failure**

Run: `npm test --prefix packages/cli -- src/__tests__/submit.test.ts`
Expected: FAIL because the command has no `--token` option and does not emit auth headers.

- [ ] **Step 3: Implement CLI token support**

Update `registerSubmitCommand(...)` and `submitTask(...)` so:

- `--token <value>` is accepted;
- token precedence is `--token` then `API_AUTH_TOKEN`;
- missing token is rejected unless `API_AUTH_DISABLED=1`;
- outbound headers merge `Content-Type` with the shared bearer header helper.

Implementation sketch:

```ts
const token = resolveApiClientToken({
  explicitToken: opts.token,
  env: process.env,
});

headers: {
  'Content-Type': 'application/json',
  ...buildApiAuthHeaders(token),
}
```

- [ ] **Step 4: Run CLI tests to verify they pass**

Run: `npm test --prefix packages/cli -- src/__tests__/submit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/submit.ts packages/cli/src/__tests__/submit.test.ts
git commit -m "feat(cli): send api bearer token on submit"
```

### Task 4: Update enrichment daemon config and HTTP callers

**Files:**
- Modify: `packages/daemon/task-enrichment/src/config.ts`
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/task-enrichment/src/adapters/task-phase-publisher.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/config.test.ts`

- [ ] **Step 1: Write failing enrichment config tests for auth-enabled and bypass modes**

Extend `packages/daemon/task-enrichment/src/__tests__/config.test.ts` with cases that prove:

- auth-enabled mode requires a non-empty `API_AUTH_TOKEN`;
- `API_AUTH_DISABLED=1` allows startup without a token;
- the parsed config exposes the client token for request builders.

- [ ] **Step 2: Run enrichment config tests to verify failure**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/config.test.ts`
Expected: FAIL because auth client config is not parsed yet.

- [ ] **Step 3: Implement auth-aware config and outbound headers**

Update the daemon config type to include auth state/token. Then update every API `fetch(...)` call in `enrichment-poller.ts` and `adapters/task-phase-publisher.ts` to merge the shared auth headers.

Expected pattern:

```ts
const headers = {
  'Content-Type': 'application/json',
  ...buildApiAuthHeaders(this.apiAuthToken),
};
```

Also add explicit warn-level logging when an API response is `401` or `403` so a bad token is obvious to the operator, and treat those statuses as non-retryable (stop polling / throw) to avoid hiding misconfiguration behind retry loops.

- [ ] **Step 4: Re-run enrichment tests relevant to config and polling**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/config.test.ts src/__tests__/enrichment-poller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/config.ts packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/adapters/task-phase-publisher.ts packages/daemon/task-enrichment/src/__tests__/config.test.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): authenticate api requests"
```

### Task 5: Update task-daemon config consumers and HTTP callers

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts`
- Modify: `packages/daemon/task/src/adapters/task-phase-publisher.ts`
- Modify: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Modify: `packages/daemon/task/src/task-daemon.ts`

- [ ] **Step 1: Write failing task-daemon tests for auth headers and auth-failure warnings**

Extend `packages/daemon/task/src/__tests__/task-poller.test.ts` to assert:

```ts
expect(mockFetch).toHaveBeenNthCalledWith(
  1,
  'http://localhost:3000/jobs/sessions',
  expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
  }),
);
```

Add a case where one of the polling endpoints returns `401` or `403`, then assert the poller does not treat it as a normal empty cycle and emits a warn-worthy path.

- [ ] **Step 2: Run task-daemon tests to verify failure**

Run: `npm test --prefix packages/daemon/task -- src/__tests__/task-poller.test.ts src/__tests__/task-poller-concurrent.test.ts`
Expected: FAIL because no auth headers are attached yet.

- [ ] **Step 3: Implement bearer headers and non-retryable auth handling**

Update `task-poller.ts` and `adapters/task-phase-publisher.ts` to:

- accept or construct auth headers through the shared helper;
- attach auth headers to session discovery, job fetch, ack, nack, result publish, and phase publish requests;
- log `401` and `403` responses at warn level and stop treating them as transient transport failures.

Keep existing behavior for `204`, `503`, and network errors.

Also ensure the daemon fails fast when auth is enabled but misconfigured:

- In `packages/daemon/task/src/task-daemon.ts`, call `loadApiAuthConfig(process.env)` at startup.
- If auth is enabled, pass `auth.token` (or the resolved client token) into the poller/publisher constructors so every request can attach `Authorization`.
- If auth is disabled (`API_AUTH_DISABLED=1`), allow startup without a token and omit the auth header.

- [ ] **Step 4: Run task-daemon tests to verify they pass**

Run: `npm test --prefix packages/daemon/task -- src/__tests__/task-poller.test.ts src/__tests__/task-poller-concurrent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/task-poller.ts packages/daemon/task/src/adapters/task-phase-publisher.ts packages/daemon/task/src/__tests__/task-poller.test.ts packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts
git commit -m "feat(task-daemon): authenticate api polling and publishes"
```

### Task 6: Update lark-listener API client paths

**Files:**
- Modify: `packages/daemon/lark-listener/src/config.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/config.test.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`

- [ ] **Step 1: Write failing lark-listener tests for auth config and request headers**

Add config cases for enabled/bypass auth and request tests that assert `/tasks` and `/results` calls include the bearer header.

- [ ] **Step 2: Run listener tests to verify failure**

Run: `npm test --prefix packages/daemon/lark-listener -- src/__tests__/config.test.ts src/__tests__/task-submitter.test.ts`
Expected: FAIL because the listener does not parse or send auth credentials yet.

- [ ] **Step 3: Implement auth-aware config and headers**

Update `config.ts` to expose auth state/token and `task-submitter.ts` to merge auth headers with existing JSON headers. Add warn-level handling for `401`/`403` and treat them as non-retryable (throw / stop retries) so bad credentials do not trigger misleading exponential retries.

- [ ] **Step 4: Run listener tests to verify they pass**

Run: `npm test --prefix packages/daemon/lark-listener -- src/__tests__/config.test.ts src/__tests__/task-submitter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/config.ts packages/daemon/lark-listener/src/adapters/task-submitter.ts packages/daemon/lark-listener/src/__tests__/config.test.ts packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts
git commit -m "feat(lark-listener): authenticate api submissions"
```

### Task 7: Update lark-result and telegram-result pollers

**Files:**
- Modify: `packages/daemon/lark-result/src/config.ts`
- Modify: `packages/daemon/lark-result/src/lark-poller.ts`
- Modify: `packages/daemon/lark-result/src/__tests__/config.test.ts`
- Modify: `packages/daemon/lark-result/src/__tests__/lark-poller.test.ts`
- Modify: `packages/daemon/telegram-result/src/config.ts`
- Modify: `packages/daemon/telegram-result/src/telegram-poller.ts`
- Modify: `packages/daemon/telegram-result/src/__tests__/config.test.ts`
- Modify: `packages/daemon/telegram-result/src/__tests__/telegram-poller.test.ts`

- [ ] **Step 1: Write failing poller tests for auth headers and `401`/`403` handling**

Extend both poller test suites to assert headers on `/results/next/...` and `/results/.../ack` calls, and add a case like:

```ts
it('logs and stops normal processing when the api returns 401', async () => {
  mockFetch.mockResolvedValueOnce({ status: 401 });
});
```

Add config tests for auth-enabled and bypass modes in both packages.

- [ ] **Step 2: Run poller and config tests to verify failure**

Run: `npm test --prefix packages/daemon/lark-result -- src/__tests__/config.test.ts src/__tests__/lark-poller.test.ts`

Run: `npm test --prefix packages/daemon/telegram-result -- src/__tests__/config.test.ts src/__tests__/telegram-poller.test.ts`

Expected: FAIL because neither poller emits auth headers yet.

- [ ] **Step 3: Implement auth-aware config and authenticated polling/acking**

Update both configs to expose client auth state/token, then update both pollers to send the bearer header on queue poll and ack requests. Add warn-level handling for `401`/`403` and treat them as non-retryable (throw / stop polling), so operator/configuration issues are not masked as transient queue emptiness.

- [ ] **Step 4: Run poller tests to verify they pass**

Run: `npm test --prefix packages/daemon/lark-result -- src/__tests__/config.test.ts src/__tests__/lark-poller.test.ts`

Run: `npm test --prefix packages/daemon/telegram-result -- src/__tests__/config.test.ts src/__tests__/telegram-poller.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-result/src/config.ts packages/daemon/lark-result/src/lark-poller.ts packages/daemon/lark-result/src/__tests__/config.test.ts packages/daemon/lark-result/src/__tests__/lark-poller.test.ts packages/daemon/telegram-result/src/config.ts packages/daemon/telegram-result/src/telegram-poller.ts packages/daemon/telegram-result/src/__tests__/config.test.ts packages/daemon/telegram-result/src/__tests__/telegram-poller.test.ts
git commit -m "feat(result-daemons): authenticate api polling"
```

### Task 8: Update environment and developer docs

**Files:**
- Modify: `.env.example`
- Modify: `docs/LOCAL_DEVELOPMENT.md`

- [ ] **Step 1: Write the doc changes in-place**

Update `.env.example` with:

```bash
API_AUTH_TOKEN=replace_me
API_AUTH_DISABLED=
```

Update `docs/LOCAL_DEVELOPMENT.md` to document:

- auth is enabled by default for all API routes except `/health`;
- all LocalAgent daemons and the CLI need `API_AUTH_TOKEN` when auth is enabled;
- `API_AUTH_DISABLED=1` is dev/test only;
- example `curl` commands with `Authorization: Bearer ...` for protected endpoints.

- [ ] **Step 2: Run targeted smoke tests for the changed packages**

Run:

```bash
node common/scripts/run-rush-project-tests.js --to @local-agent/shared --to @local-agent/api --to @local-agent/cli --to @local-agent/task-enrichment-daemon --to @local-agent/task-daemon --to @local-agent/lark-listener-daemon --to @local-agent/lark-result-daemon --to @local-agent/telegram-result-daemon
```

Expected: PASS.

- [ ] **Step 3: Run the full PR gate if practical**

Run:

```bash
node common/scripts/install-run-rush.js build
node common/scripts/run-rush-project-tests.js
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .env.example docs/LOCAL_DEVELOPMENT.md
git commit -m "docs: describe api bearer auth setup"
```
