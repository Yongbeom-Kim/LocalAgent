# Design: API Layer Bearer Authentication

**Date:** 2026-04-06
**Status:** Ready for implementation planning
**Depends on:** Existing Express API routes, shared env/config helpers, CLI task submission, daemon HTTP polling/publishing flows

## Problem

The API layer currently trusts every caller that can reach it.

Today:

1. `/tasks`, `/jobs`, and `/results` accept unauthenticated requests;
2. internal daemons poll and publish without credentials;
3. the CLI can submit tasks without proving caller identity;
4. `/health` is the only route that is suitable for unauthenticated infrastructure probing, but it is not isolated by policy from the rest of the API.

That makes the API effectively open to any local or network caller with access to the service address. For this system, that is enough surface area to enqueue arbitrary work, acknowledge queue deliveries, and inject task-result events.

## Goal

Add a small, explicit authentication layer around the API's operational routes by:

1. requiring a shared bearer token for `/tasks`, `/jobs`, and `/results`;
2. leaving `/health` unauthenticated for probes and local smoke checks;
3. updating all first-party HTTP clients to send the token;
4. supporting a deliberate local-development bypass switch;
5. failing fast when auth is expected but misconfigured.

## User Decisions

- First version scope is **all currently exposed API routes except `/health`** (i.e. everything mounted under `/tasks`, `/jobs`, and `/results`).
- Any future non-health API routes should be mounted **behind the auth middleware by default** unless explicitly documented as public.
- The auth scheme is a **single static bearer token** in the `Authorization` header.
- One shared token is sufficient for v1; there is no per-role or per-endpoint credential split.
- Auth failures should distinguish between **missing credentials (`401`)** and **wrong credentials (`403`)**.
- The API must support an explicit local-development bypass through **`API_AUTH_DISABLED=1`**.
- Rollout can **break fast**. There is no compatibility window with unauthenticated clients after this change lands.
- The CLI should support both an env-backed default and an explicit `--token` override.
- Auth error response bodies stay minimal.
- Env var names are **`API_AUTH_TOKEN`** and **`API_AUTH_DISABLED`**.
- If auth is enabled and `API_AUTH_TOKEN` is missing, API startup should fail fast.
- API-side auth failures should log at **debug** level only; queue-polling or publishing clients should log `401`/`403` failures at **warn** level.
- v1 does not need overlapping token rotation or runtime config reload.

## Non-Goals

- JWTs, OAuth, mTLS, signed service identities, or other stronger auth schemes.
- Per-daemon or per-user credentials.
- Authorization rules beyond “token present and correct”.
- Hot token rotation without restart.
- Protecting `/health`.
- Adding metrics, rate limiting, or audit persistence in this iteration.

## Existing Context

### 1. API route mounting is centralized

`packages/api/src/app.ts` constructs the Express app, applies JSON parsing, and mounts:

- `/tasks`
- `/jobs`
- `/results`
- `/health`

That is the natural insertion point for route-scoped middleware.

### 2. Shared config loading already exists

`packages/shared/src/config.ts` provides `loadApiConfig`, `loadDaemonConfig`, and `requireEnvValue`, and the package already loads `.env` from the repo root via `loadEnvFromRoot()`.

That means auth config can be introduced centrally and reused by API, daemons, and CLI without inventing a parallel config system.

### 3. First-party callers are all simple `fetch(...)` clients

Current internal callers include:

- `packages/cli/src/commands/submit.ts`
- `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- `packages/daemon/task-enrichment/src/adapters/task-phase-publisher.ts`
- `packages/daemon/task/src/task-poller.ts`
- `packages/daemon/task/src/adapters/task-phase-publisher.ts`
- `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
- `packages/daemon/lark-result/src/lark-poller.ts`
- `packages/daemon/telegram-result/src/telegram-poller.ts`

They currently send either no headers or only `Content-Type: application/json`.

### 4. Config validation style already prefers fail-fast startup

Several services already call `requireEnvValue(...)` during startup config loading. That established pattern matches the requested “auth enabled but token missing” behavior.

## Approaches Considered

### Approach 1: Shared bearer-token middleware at the API edge

Flow:

1. API startup reads `API_AUTH_DISABLED` and `API_AUTH_TOKEN`.
2. Express mounts an auth middleware for all routes except `/health`.
3. Middleware expects `Authorization: Bearer <token>`.
4. First-party callers include the same token in their requests.

Note: This uses one token shared by all first-party callers. It provides a hard gate against accidental exposure, but it is not intended to provide identity, per-caller attribution, or fine-grained authorization.

**Why chosen:**

- smallest change set that solves the actual problem;
- matches the user's explicit preference for one shared token;
- keeps auth logic easy to reason about and test;
- preserves `/health` simplicity for probes.

### Approach 2: Transitional optional-auth compatibility mode

Flow:

- API would accept both authenticated and unauthenticated requests during rollout, then later enforce auth.

**Why not chosen:**

- conflicts with the user's “break fast” rollout preference;
- adds transitional branches, extra config, and extra docs burden;
- increases the risk that optional mode becomes permanent.

### Approach 3: Per-role tokens for daemons and CLI

Flow:

- each daemon class and the CLI would use a separate credential.

**Why not chosen:**

- adds config and rollout complexity without a stated v1 requirement;
- does not improve correctness for the requested first version enough to justify the extra moving parts.

## Design

### 1. Auth configuration becomes explicit shared state

Add a small shared auth config contract in `packages/shared/src/config.ts` and export it through `packages/shared/src/index.ts`.

Recommended API-facing config:

```ts
interface ApiAuthConfig {
  enabled: boolean;
  token?: string;
}
```

Recommended behavior:

1. `API_AUTH_DISABLED === '1'` means auth is disabled;
2. otherwise auth is enabled (including when unset, `'0'`, `'true'`, etc.);
3. when auth is enabled, `API_AUTH_TOKEN` is required and must be non-empty after trimming;
4. when auth is disabled, missing token is acceptable.

This keeps the bypass deliberate. Merely forgetting to set a token must not disable auth implicitly.

### 2. Middleware enforces bearer auth on protected route groups only

Mount an authentication middleware in `packages/api/src/app.ts` so the order becomes conceptually:

1. JSON body parser
2. open `/health`
3. auth middleware for everything else
4. protected routes (`/tasks`, `/jobs`, `/results`)
5. error handler

This matches the v1 scope decision (“everything except `/health`”) and reduces the chance of accidentally adding a new unprotected route in the future.

Middleware contract:

- If auth is disabled, call `next()` immediately.
- If `Authorization` header is absent, return `401`.
- If header is present but not in bearer format, return `401`.
- If bearer token does not match configured token, return `403`.
- On success, call `next()`.

Bearer parsing rules (to keep behavior predictable across clients):

- Header name is treated case-insensitively per HTTP.
- Scheme must be `Bearer` (case-insensitive), followed by at least one space, then the token.
- Leading/trailing whitespace around the header value is ignored.

Minimal response bodies:

```json
{ "error": "Unauthorized" }
```

for missing/malformed credentials, and:

```json
{ "error": "Forbidden" }
```

for wrong credentials.

The exact strings can stay short; the important part is stable status-code semantics.

### 3. API logging stays quiet by default and safe by construction

The API should log auth failures at `debug` level only, with metadata such as:

- route path
- method
- failure class (`missing_header`, `invalid_scheme`, `token_mismatch`)

It must not log:

- the bearer token itself;
- the raw `Authorization` header;
- derived secret fragments.

This matches the user's request to avoid noisy server logs while preserving low-friction diagnostics.

### 4. First-party callers share one outbound auth helper contract

All existing HTTP clients should load the same `API_AUTH_TOKEN` value and, when present, send:

```http
Authorization: Bearer <token>
```

To avoid duplicated header logic, implementation should introduce a small shared helper in `packages/shared` that can:

- expose the token for non-API services;
- build auth headers for `fetch(...)` callers;
- optionally merge with existing headers such as `Content-Type`.

This keeps header formatting consistent across daemons and the CLI.

### 5. Client config contract remains strict but scoped

For non-API callers, the recommended contract is:

- no auth token required if they only talk to external services or never hit the LocalAgent API;
- fail fast when a service depends on `API_URL` and auth is enabled by policy for this environment, but keep config simple by reusing `API_AUTH_TOKEN` directly where needed.

In practice for this repo, the affected services all talk to the API.

- Clients should use the same `API_AUTH_DISABLED` / `API_AUTH_TOKEN` semantics as the API.
- If `API_AUTH_DISABLED=1`, clients must not require a token and may omit the auth header.
- Otherwise, clients should fail fast at startup if `API_AUTH_TOKEN` is missing/empty (same trim rule as the API).
- When a token is present, clients should always send it.

Because rollout is “break fast”, first-party clients should treat `401`/`403` responses as configuration problems worth warning loudly about.

### 6. CLI supports env default plus explicit override

`packages/cli/src/commands/submit.ts` should support both:

- `API_AUTH_TOKEN` from the environment
- an explicit `--token <value>` flag

Precedence should be:

1. explicit `--token`
2. `API_AUTH_TOKEN`
3. no auth header

Validation:

- If `API_AUTH_DISABLED=1`, `--token` is optional and may still be sent.
- Otherwise, require a token by configuration: if neither `--token` nor `API_AUTH_TOKEN` is present (or either is present but trims to empty), the CLI should fail fast with a clear error message.

This matches the user's preference for both mechanisms while keeping scripting easy.

### 7. `/health` stays open and intentionally separate

`/health` remains unauthenticated even when auth is enabled.

Reasoning:

- it is used for local smoke checks;
- it is suitable for infrastructure probes;
- it exposes only coarse status (`ok` and RabbitMQ connectivity), not mutation capability.

Keeping it open avoids needless credential coupling for readiness/liveness checks.

## Route-Level Impact

Protected routes in v1:

- `POST /tasks`
- `GET /tasks/next`
- `POST /tasks/:id/ack`
- `POST /jobs`
- `GET /jobs/sessions`
- `GET /jobs/next/:sessionId`
- `POST /jobs/:sessionId/:id/ack`
- `POST /jobs/:sessionId/:id/nack`
- `POST /results`
- `GET /results/next/:queueName`
- `POST /results/:queueName/:id/ack`

Unprotected route:

- `GET /health`

## Failure Semantics

### API-side

- Missing `Authorization` header: `401`
- Non-bearer or malformed `Authorization` header: `401`
- Bearer token mismatch: `403`
- Auth disabled via `API_AUTH_DISABLED=1`: protected routes behave as they do today
- Auth enabled with no `API_AUTH_TOKEN`: API startup fails before listening

### Client-side

First-party API clients should:

- log `401` and `403` as configuration/auth failures at warn level;
- treat `401`/`403` as non-retryable (exit or stop polling) to avoid hiding a bad token configuration behind retry loops;
- preserve current behavior for unrelated network or `503` failures.

## Testing Strategy

Required coverage:

1. API middleware unit/integration tests proving:
   - protected routes reject missing headers with `401`;
   - malformed headers reject with `401`;
   - wrong token rejects with `403`;
   - correct token succeeds;
   - `/health` stays open;
   - bypass mode disables auth checks.

2. Shared config tests proving:
   - auth-enabled config requires `API_AUTH_TOKEN`;
   - `API_AUTH_DISABLED=1` allows missing token;
   - env parsing/export remains stable.

3. Client tests proving:
   - CLI sends bearer header from env or `--token`;
   - explicit CLI flag overrides env;
   - affected daemons include headers when configured;
   - queue pollers surface `401`/`403` as warn-worthy failures.

## Risks and Mitigations

### Risk 1: Incomplete client rollout breaks internal automation

Because rollout is intentionally strict, any first-party caller left unmodified will start receiving `401`/`403` immediately.

**Mitigation:**

- enumerate every API client in the implementation plan;
- add test coverage for header attachment in each touched call path;
- update `.env.example` and local-development docs so operator setup is obvious.

### Risk 2: Accidental secret leakage in logs

Improper debugging could log the token.

**Mitigation:**

- restrict auth logs to classification metadata only;
- never serialize request headers in auth failure logs.

### Risk 3: Dev bypass becomes the default habit

An explicit bypass flag is useful, but it can become sticky in developer environments.

**Mitigation:**

- make bypass opt-in only via `API_AUTH_DISABLED=1`;
- document it as dev/test only;
- keep the API fail-fast behavior when auth is enabled but token is absent.

## Implementation Notes

- Prefer a small new API auth middleware module rather than embedding auth checks inside each route file.
- Prefer a small shared helper for authenticated fetch headers instead of duplicating bearer-header construction across daemons.
- Keep the design narrow: one token, one middleware, one bypass flag.

## Open Questions

None for v1. The user decisions are specific enough to proceed directly to implementation planning.
