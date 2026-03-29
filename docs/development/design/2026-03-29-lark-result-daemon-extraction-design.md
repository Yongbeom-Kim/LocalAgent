# Lark Result Daemon Extraction Design

**Date:** 2026-03-29
**Type:** Refactor / package extraction
**Packages affected:** `@local-agent/daemon` (renamed to `@local-agent/task-daemon`), `@local-agent/shared`, new `@local-agent/lark-result-daemon`

## 1. Context

The Lark notification system was initially built as a second entry point within the `@local-agent/daemon` package (see [2026-03-27 result reporting design](./2026-03-27-result-reporting-design.md)). This worked for the initial implementation, but the two daemons have different deployment lifecycles, different environment variable requirements, and different scaling characteristics. The daemon package currently houses both task execution code (task-daemon, task-poller, orchestrator, executors) and Lark notification code (lark-daemon, lark-poller, lark-notifier) — two unrelated concerns sharing a package.

Current state:
- `packages/daemon/` contains both `task-daemon.ts` and `lark-daemon.ts` entry points.
- `packages/daemon/src/lark-poller.ts` polls for results and delegates to `LarkNotifier`.
- `packages/daemon/src/adapters/lark-notifier.ts` handles Lark Bot API integration with retry logic.
- `@local-agent/shared` exports `loadLarkDaemonConfig()`, `LarkDaemonConfig`, and `DEFAULT_LARK_MAX_RETRIES` — all specific to the Lark daemon.
- The package name `@local-agent/daemon` is ambiguous now that there are two daemons.
- Docker-compose only has `rabbitmq` and `api` services — no daemon containers, no profiles.

## 2. Goal

Extract the Lark notification daemon into its own Rush package (`@local-agent/lark-result-daemon`) and rename the remaining daemon package to `@local-agent/task-daemon`, achieving:
1. Independent deployment and scaling of the Lark result notification daemon.
2. Clean package boundaries — each package has a single responsibility.
3. Symmetric naming (`task-daemon` / `lark-result-daemon`).
4. Complete Docker Compose setup with per-service profiles.
5. All environment variables documented in a single root `.env.example`.

## 3. Non-goals

- No functional changes to the Lark notification logic (same poller, same notifier, same retry behavior).
- No new notification channels (Slack, email, etc.) — no `NotificationAdapter` abstraction.
- No changes to the API package or RabbitMQ topology (queue setup stays in API).
- No changes to the CLI package.
- No migration of `DEFAULT_LARK_QUEUE_NAME` out of shared (it's used by both API and lark-result-daemon).

## 4. User Decisions Captured

- **Motivation:** Independent deployment — deploy/scale the Lark daemon separately from the task daemon.
- **Extraction scope:** Full daemon — move `lark-daemon.ts`, `lark-poller.ts`, `lark-notifier.ts`, and their tests.
- **Package name:** `@local-agent/lark-result-daemon` — emphasizes Lark + results + daemon role.
- **Daemon rename:** `@local-agent/daemon` becomes `@local-agent/task-daemon`, directory `packages/daemon/` becomes `packages/task-daemon/`.
- **Config migration:** Move `loadLarkDaemonConfig()`, `LarkDaemonConfig`, and `DEFAULT_LARK_MAX_RETRIES` from shared to lark-result-daemon. Keep `DEFAULT_LARK_QUEUE_NAME` in shared.
- **Cleanup:** Complete removal of lark code from the task-daemon package. No deprecated re-exports.
- **Dockerfile:** Yes, add a Dockerfile to the new package (follow API Dockerfile pattern).
- **Docker Compose:** Add all services with per-service profiles. RabbitMQ always runs (no profile). Profiles: `api`, `task-daemon`, `lark-result-daemon`, `full`.
- **Env file:** Single root `.env.example` with sections per component. Add placeholder Lark env vars (`LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_RECIPIENT_ID`).
- **Tests:** Move existing test files as-is with minimal path adjustments.
- **Env vars:** Keep the existing three Lark env vars (LARK_APP_ID, LARK_APP_SECRET, LARK_RECIPIENT_ID) plus the shared daemon vars (API_URL, POLL_INTERVAL_MS, LOG_LEVEL). No new configurability.

## 5. Approaches Considered

### Approach A: Single-pass extraction + rename (Selected)

Do everything in one coherent change:
1. Create `packages/lark-result-daemon/` with moved lark files.
2. Move lark-specific config and constants from shared to the new package.
3. Rename `packages/daemon/` to `packages/task-daemon/`, update package name.
4. Remove all lark-related code from the (now renamed) task-daemon.
5. Update rush.json, docker-compose.yml, .env.example, add Dockerfile.
6. Clean up shared package exports.

**Trade-offs:**
- (+) One coherent change — everything lands in the correct final state.
- (+) No intermediate inconsistent state.
- (-) Larger diff, more things can break at once.

### Approach B: Two-phase extraction

Phase 1: Create lark-result-daemon, remove lark code from daemon. Phase 2: Rename daemon to task-daemon.

**Trade-offs:**
- (+) Smaller, reviewable changes per phase.
- (-) Intermediate state where naming is inconsistent.
- (-) Two rounds of config file updates.

### Approach C: Extract with notification adapter abstraction

Like Approach A but introduce a `NotificationAdapter` interface in the new package.

**Trade-offs:**
- (-) YAGNI — premature abstraction for a single adapter.
- (-) More code to write and test for no immediate benefit.

**Decision:** Approach A selected. The extraction and rename are logically connected, the total diff is manageable, and there's no benefit to splitting phases or adding abstractions.

## 6. Detailed Design

### 6.1 New package: `packages/lark-result-daemon/`

**Directory structure:**
```
packages/lark-result-daemon/
├── package.json
├── tsconfig.json
├── Dockerfile
└── src/
    ├── index.ts              # Entry point (moved from lark-daemon.ts)
    ├── config.ts             # loadLarkDaemonConfig + LarkDaemonConfig (moved from shared)
    ├── constants.ts          # DEFAULT_LARK_MAX_RETRIES (moved from shared)
    ├── lark-poller.ts        # Moved from daemon
    ├── adapters/
    │   └── lark-notifier.ts  # Moved from daemon
    └── __tests__/
        ├── config.test.ts            # Moved from shared (loadLarkDaemonConfig tests only)
        ├── lark-poller.test.ts       # Moved from daemon
        └── lark-notifier.test.ts     # Moved from daemon (flattened out of adapters/__tests__/)
```

**package.json:**
```json
{
  "name": "@local-agent/lark-result-daemon",
  "version": "0.0.1",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "@local-agent/shared": "workspace:*",
    "dotenv": "~16.4.7"
  },
  "devDependencies": {
    "typescript": "~5.7.0",
    "vitest": "~1.6.0",
    "rimraf": "~5.0.0",
    "ts-node": "~10.9.0"
  }
}
```

**tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**/*"]
}
```

### 6.2 Source file changes

**`src/index.ts`** (moved from `lark-daemon.ts`):
- Import `loadLarkDaemonConfig` from local `./config` instead of `@local-agent/shared`.
- Import `DEFAULT_LARK_QUEUE_NAME` from `@local-agent/shared` (stays in shared).
- Import `LarkPoller` from `./lark-poller`.
- Import `LarkNotifier` from `./adapters/lark-notifier`.
- No logic changes.

**`src/config.ts`** (moved from `shared/src/config.ts`):
- Contains `LarkDaemonConfig` interface and `loadLarkDaemonConfig()` function.
- Imports `DEFAULT_API_URL`, `DEFAULT_POLL_INTERVAL_MS`, `DEFAULT_LOG_LEVEL` from `@local-agent/shared`.
- Imports `dotenv` and calls `dotenv.config()`.
- Add `dotenv` as a dependency in package.json.

**`src/constants.ts`** (moved from `shared/src/constants.ts`):
- Contains only `DEFAULT_LARK_MAX_RETRIES = 3`.

**`src/lark-poller.ts`** (moved from `daemon/src/lark-poller.ts`):
- Import path for `LarkNotifier` stays the same (`./adapters/lark-notifier`).
- No other changes.

**`src/adapters/lark-notifier.ts`** (moved from `daemon/src/adapters/lark-notifier.ts`):
- Import `DEFAULT_LARK_MAX_RETRIES` from `../constants` instead of `@local-agent/shared`.
- No other changes.

**Tests** move as-is with updated import paths:
- `lark-poller.test.ts` — update mock path from `../adapters/lark-notifier` to stay relative.
- `lark-notifier.test.ts` — flatten from `adapters/__tests__/` to `__tests__/`, update import path accordingly.

### 6.3 Shared package changes (`@local-agent/shared`)

**Remove from `src/config.ts`:**
- `LarkDaemonConfig` interface
- `loadLarkDaemonConfig()` function

**Remove from `src/constants.ts`:**
- `DEFAULT_LARK_MAX_RETRIES`

**Remove from `src/index.ts` exports:**
- `loadLarkDaemonConfig`
- `LarkDaemonConfig`
- `DEFAULT_LARK_MAX_RETRIES`

**Update `src/__tests__/config.test.ts`:**
- Remove the `loadLarkDaemonConfig` test block (tests move with the config to lark-result-daemon).

**Keep in shared (used by both API and lark-result-daemon):**
- `DEFAULT_LARK_QUEUE_NAME`

### 6.4 Daemon rename: `@local-agent/daemon` -> `@local-agent/task-daemon`

**Directory:** `packages/daemon/` -> `packages/task-daemon/`

**package.json changes:**
- `"name": "@local-agent/task-daemon"`
- Remove `start:lark-daemon` and `dev:lark-daemon` scripts.
- Keep `start:task-daemon` (rename to `start` for simplicity) and `dev:task-daemon` (rename to `dev`).

**Files to delete from task-daemon:**
- `src/lark-daemon.ts`
- `src/lark-poller.ts`
- `src/adapters/lark-notifier.ts`
- `src/__tests__/lark-poller.test.ts`
- `src/adapters/__tests__/lark-notifier.test.ts`

### 6.5 rush.json update

```json
{
  "projects": [
    {
      "packageName": "@local-agent/shared",
      "projectFolder": "packages/shared"
    },
    {
      "packageName": "@local-agent/api",
      "projectFolder": "packages/api"
    },
    {
      "packageName": "@local-agent/task-daemon",
      "projectFolder": "packages/task-daemon"
    },
    {
      "packageName": "@local-agent/lark-result-daemon",
      "projectFolder": "packages/lark-result-daemon"
    },
    {
      "packageName": "@local-agent/cli",
      "projectFolder": "packages/cli"
    }
  ]
}
```

### 6.6 Dockerfile for lark-result-daemon

Follow the same multi-stage pattern as the API Dockerfile:

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Copy package manifests for all projects Rush needs
COPY packages/shared/package.json packages/shared/package.json
COPY packages/lark-result-daemon/package.json packages/lark-result-daemon/package.json
# Rush requires all projects in rush.json to have manifests present
COPY packages/api/package.json packages/api/package.json
COPY packages/task-daemon/package.json packages/task-daemon/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/lark-result-daemon

COPY packages/shared/ packages/shared/
COPY packages/lark-result-daemon/ packages/lark-result-daemon/

RUN cd packages/shared && npx tsc
RUN cd packages/lark-result-daemon && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/lark-result-daemon/package.json packages/lark-result-daemon/package.json
COPY --from=builder /app/packages/lark-result-daemon/dist/ packages/lark-result-daemon/dist/
COPY --from=builder /app/packages/lark-result-daemon/node_modules/ packages/lark-result-daemon/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/lark-result-daemon

CMD ["node", "dist/index.js"]
```

### 6.7 Docker Compose update

```yaml
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: guest
      RABBITMQ_DEFAULT_PASS: guest
    healthcheck:
      test: rabbitmq-diagnostics -q ping
      interval: 10s
      timeout: 5s
      retries: 5

  api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
    ports:
      - "3000:3000"
    environment:
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
      QUEUE_NAME: tasks
      PORT: "3000"
      LOG_LEVEL: info
    depends_on:
      rabbitmq:
        condition: service_healthy
    profiles:
      - api
      - full

  task-daemon:
    build:
      context: .
      dockerfile: packages/task-daemon/Dockerfile
    environment:
      API_URL: http://api:3000
      POLL_INTERVAL_MS: "5000"
      LOG_LEVEL: info
    depends_on:
      rabbitmq:
        condition: service_healthy
      api:
        condition: service_started
    profiles:
      - task-daemon
      - full

  lark-result-daemon:
    build:
      context: .
      dockerfile: packages/lark-result-daemon/Dockerfile
    environment:
      API_URL: http://api:3000
      POLL_INTERVAL_MS: "5000"
      LOG_LEVEL: info
      LARK_APP_ID: ${LARK_APP_ID}
      LARK_APP_SECRET: ${LARK_APP_SECRET}
      LARK_RECIPIENT_ID: ${LARK_RECIPIENT_ID}
    depends_on:
      rabbitmq:
        condition: service_healthy
      api:
        condition: service_started
    profiles:
      - lark-result-daemon
      - full
```

### 6.8 .env.example update

```env
# API Configuration
PORT=3000
RABBITMQ_URL=amqp://guest:guest@localhost:5672
QUEUE_NAME=tasks
LOG_LEVEL=info

# Daemon Configuration (shared by task-daemon and lark-result-daemon)
API_URL=http://localhost:3000
POLL_INTERVAL_MS=5000

# Lark Result Daemon Configuration
LARK_APP_ID=your_lark_app_id
LARK_APP_SECRET=your_lark_app_secret
LARK_RECIPIENT_ID=your_lark_recipient_open_id
```

### 6.9 API Dockerfile update

The existing API Dockerfile references `packages/daemon/package.json` (Rush requires all project manifests). This must be updated to reference `packages/task-daemon/package.json` and add `packages/lark-result-daemon/package.json`.

### 6.10 Task-daemon Dockerfile

A new Dockerfile is needed for `packages/task-daemon/` (it didn't have one before). Follow the same pattern as the API and lark-result-daemon Dockerfiles.

## 7. Acceptance Criteria

1. `@local-agent/lark-result-daemon` package exists at `packages/lark-result-daemon/` with its own `package.json`, `tsconfig.json`, and `Dockerfile`.
2. `npm run dev` / `npm run start` in lark-result-daemon starts the Lark polling daemon.
3. `@local-agent/daemon` is renamed to `@local-agent/task-daemon` at `packages/task-daemon/`.
4. No lark-related source files remain in `packages/task-daemon/`.
5. `loadLarkDaemonConfig`, `LarkDaemonConfig`, and `DEFAULT_LARK_MAX_RETRIES` are no longer exported from `@local-agent/shared`.
6. `DEFAULT_LARK_QUEUE_NAME` remains in `@local-agent/shared`.
7. `rush.json` lists both `@local-agent/task-daemon` and `@local-agent/lark-result-daemon`.
8. `docker-compose.yml` has all four services with per-service profiles (`api`, `task-daemon`, `lark-result-daemon`, `full`). RabbitMQ always runs.
9. `.env.example` includes placeholder Lark env vars.
10. All existing Lark tests pass in the new package location.
11. `rush build` succeeds for all packages.

## 8. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Rush install/build breaks after directory rename | Run `rush update` after changing `rush.json`. Test `rush build` immediately. |
| Import paths break in moved files | Carefully update all relative and package imports. Tests will catch most issues. |
| API Dockerfile breaks due to changed manifest paths | Update all `COPY` lines referencing `packages/daemon/` to `packages/task-daemon/`. |
| Docker Compose profiles not supported by older Docker Compose versions | Profiles require Docker Compose v2.1+. Document minimum version. |
| `.env` file not loaded in new package | Ensure `dotenv` is a dependency of lark-result-daemon and `dotenv.config()` is called in config.ts. |
