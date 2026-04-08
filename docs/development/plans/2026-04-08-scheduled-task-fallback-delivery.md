# Scheduled Task Fallback Delivery Implementation Plan

**Goal:** Add a Supercronic-backed scheduler that submits normal canonical tasks from merged YAML config, and implement lazy Lark/Telegram outbound fallback that creates a new root message or forum topic only when phase/result delivery cannot resolve an existing destination.

**Architecture:** Introduce a new `@local-agent/task-scheduler` daemon that loads a directory of YAML schedules, renders a Supercronic crontab that invokes named schedule entries, and submits canonical `/tasks` requests with an explicit `session_id` plus optional fallback seed metadata. Extend the API and shared session persistence to store that metadata, then update Lark and Telegram outbound notifiers to lazily create and persist a destination anchor on first fallback delivery while leaving enrichment, execution, and event publishing unaware of scheduling.

**Tech Stack:** TypeScript monorepo, Express API, SQLite + Drizzle schema/migrations, Supercronic, Docker Compose, Vitest.

---

## File Structure

- Create: `LocalAgent/packages/daemon/task-scheduler/`
  - New scheduler package/service.
- Create: `LocalAgent/packages/daemon/task-scheduler/package.json`
  - Scheduler package manifest and runtime scripts.
- Create: `LocalAgent/packages/daemon/task-scheduler/tsconfig.json`
  - Scheduler TypeScript config aligned with other daemons.
- Create: `LocalAgent/packages/daemon/task-scheduler/src/index.ts`
  - Scheduler entrypoint and mode dispatch.
- Create: `LocalAgent/packages/daemon/task-scheduler/src/config.ts`
  - Scheduler env/config loading.
- Create: `LocalAgent/packages/daemon/task-scheduler/src/schedule-config.ts`
  - YAML directory merge + validation.
- Create: `LocalAgent/packages/daemon/task-scheduler/src/cron-renderer.ts`
  - Render Supercronic crontab from validated schedules.
- Create: `LocalAgent/packages/daemon/task-scheduler/src/submitter.ts`
  - Canonical `/tasks` submission with auth headers and fallback metadata.
- Create: `LocalAgent/packages/daemon/task-scheduler/src/__tests__/config.test.ts`
  - Scheduler env/config tests.
- Create: `LocalAgent/packages/daemon/task-scheduler/src/__tests__/schedule-config.test.ts`
  - YAML merge/validation tests.
- Create: `LocalAgent/packages/daemon/task-scheduler/src/__tests__/cron-renderer.test.ts`
  - Crontab rendering tests.
- Create: `LocalAgent/packages/daemon/task-scheduler/src/__tests__/submitter.test.ts`
  - Scheduler submission tests.
- Create: `LocalAgent/packages/daemon/task-scheduler/config/schedules.yaml`
  - Example/default scheduler config.
- Modify: `LocalAgent/docker-compose.yml`
  - Add scheduler service and config mount.
- Modify: `LocalAgent/rush.json`
  - Register the new scheduler package.
- Modify: `LocalAgent/packages/shared/src/types.ts`
  - Add optional task/session fallback metadata types used by `/tasks` intake.
- Modify: `LocalAgent/packages/shared/src/index.ts`
  - Export any new shared types/helpers.
- Modify: `LocalAgent/packages/shared/src/db/schema.ts`
  - Add fallback metadata columns to `sessions`.
- Modify: `LocalAgent/packages/shared/src/db/session-repository.ts`
  - Persist/read fallback metadata.
- Modify: `LocalAgent/packages/shared/src/__tests__/db/session-repository.test.ts`
  - Session repository coverage for fallback metadata.
- Modify: `LocalAgent/packages/migrator/src/migrations/meta/_journal.json`
  - Register the new migration.
- Create: `LocalAgent/packages/migrator/src/migrations/0004_scheduler_fallback_metadata.sql`
  - Schema migration for new session columns.
- Modify: `LocalAgent/packages/migrator/src/__tests__/migrate.test.ts`
  - Migration assertions for new session columns.
- Modify: `LocalAgent/packages/api/src/routes/tasks.ts`
  - Accept and validate optional fallback metadata on canonical task submission.
- Modify: `LocalAgent/packages/api/src/__tests__/routes/tasks.test.ts`
  - Route coverage for new optional fields.
- Modify: `LocalAgent/packages/daemon/lark-result/src/index.ts`
  - Inject session repository access needed for fallback anchor resolution.
- Modify: `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`
  - Lazy fallback root creation + reuse.
- Modify: `LocalAgent/packages/daemon/lark-result/src/adapters/lark-phase-notifier.ts`
  - Phase delivery fallback resolution.
- Modify: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
  - Lark fallback tests.
- Modify: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-phase-notifier.test.ts`
  - Lark phase fallback tests.
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/index.ts`
  - Inject topic manager and session repository access needed for fallback creation.
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
  - Lazy topic creation + reuse.
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts`
  - Telegram fallback tests.
- Create or Modify: `LocalAgent/packages/shared/src/platform-fallback-seed.ts`
  - Optional shared helper for fallback seed truncation/normalization if needed.

### Task 1: Add the Scheduler Package Skeleton and Compose Wiring

**Files:**
- Create: `LocalAgent/packages/daemon/task-scheduler/package.json`
- Create: `LocalAgent/packages/daemon/task-scheduler/tsconfig.json`
- Create: `LocalAgent/packages/daemon/task-scheduler/src/index.ts`
- Create: `LocalAgent/packages/daemon/task-scheduler/src/config.ts`
- Create: `LocalAgent/packages/daemon/task-scheduler/config/schedules.yaml`
- Modify: `LocalAgent/docker-compose.yml`
- Modify: `LocalAgent/rush.json`

- [ ] **Step 1: Write the failing scheduler config test**

Create `LocalAgent/packages/daemon/task-scheduler/src/__tests__/config.test.ts` asserting that the scheduler config loader:
- requires `API_URL`;
- requires auth unless `API_AUTH_DISABLED=1`;
- exposes a schedule config directory;
- exposes a path for rendered crontab/snapshot artifacts.

- [ ] **Step 2: Run the scheduler config test to verify failure**

Run: `pnpm --dir LocalAgent --filter @local-agent/task-scheduler test -- src/__tests__/config.test.ts`
Expected: FAIL because the package and config loader do not exist yet.

- [ ] **Step 3: Scaffold the scheduler package and config loader**

Create the new package with scripts matching other daemons (`build`, `start`, `dev`, `test`, `clean`), a minimal `src/index.ts`, and `src/config.ts` that loads env from repo root and exposes:
- API URL;
- auth token/disabled state;
- schedule config directory;
- generated crontab path;
- config snapshot path;
- log level.

- [ ] **Step 4: Wire the scheduler into Rush and Docker Compose**

Register `@local-agent/task-scheduler` in `LocalAgent/rush.json` and add a new `task-scheduler` service to `LocalAgent/docker-compose.yml` that runs both:
- a one-time render step (`node dist/index.js render`) to generate the crontab + `config.snapshot.json`; then
- Supercronic to execute the rendered crontab.

Use a single container approach (recommended for v1) where the scheduler image contains both Node and the `supercronic` binary, with a `command` like `sh -c "node dist/index.js render && supercronic $SCHEDULER_CRONTAB_PATH"`. Mount the schedule config directory read-only and mount an artifacts directory read-write for the rendered crontab + snapshot.

- [ ] **Step 5: Run the scheduler config test to verify it passes**

Run: `pnpm --dir LocalAgent --filter @local-agent/task-scheduler test -- src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit the scheduler skeleton**

```bash
git add LocalAgent/packages/daemon/task-scheduler LocalAgent/docker-compose.yml LocalAgent/rush.json
git commit -m "feat(scheduler): add scheduler package skeleton"
```

### Task 2: Implement YAML Schedule Loading and Crontab Rendering

**Files:**
- Create: `LocalAgent/packages/daemon/task-scheduler/src/schedule-config.ts`
- Create: `LocalAgent/packages/daemon/task-scheduler/src/cron-renderer.ts`
- Create: `LocalAgent/packages/daemon/task-scheduler/src/__tests__/schedule-config.test.ts`
- Create: `LocalAgent/packages/daemon/task-scheduler/src/__tests__/cron-renderer.test.ts`
- Modify: `LocalAgent/packages/daemon/task-scheduler/src/index.ts`
- Modify: `LocalAgent/packages/daemon/task-scheduler/config/schedules.yaml`

- [ ] **Step 1: Write failing schedule-config tests**

Add tests proving the loader:
- merges multiple YAML files from a directory;
- rejects duplicate schedule names across files;
- rejects missing `task_type`, `executor`, `executor_model`, or `payload`;
- rejects `task_source` or destination/thread/topic identifiers;
- rejects invalid cron expressions at scheduler startup (fail before rendering the crontab);
- accepts raw cron strings as-is (no DSL), as long as they parse as valid cron syntax.

- [ ] **Step 2: Write failing cron-renderer tests**

Add tests proving the renderer:
- emits one cron line per validated schedule;
- invokes a named scheduler command like `node dist/index.js run <schedule-name>`;
- does not inline payload JSON, auth headers, or shell boilerplate;
- can render a stable deterministic order.

- [ ] **Step 3: Run the schedule and renderer tests to verify failure**

Run: `pnpm --dir LocalAgent --filter @local-agent/task-scheduler test -- src/__tests__/schedule-config.test.ts src/__tests__/cron-renderer.test.ts`
Expected: FAIL because the loader and renderer do not exist yet.

- [ ] **Step 4: Implement merged YAML loading and validation**

Implement `schedule-config.ts` to mirror enrichment-style directory loading. Use `js-yaml`, accept both `.yaml` and `.yml`, merge `schedules`, reject duplicates, validate the nested canonical task shape, and validate cron expressions using a Node cron parsing library (add it as a dependency of `@local-agent/task-scheduler`) so invalid cron fails fast at scheduler startup.

- [ ] **Step 5: Implement crontab rendering and config snapshot writing**

Implement `cron-renderer.ts` so scheduler startup can:
- render a temporary crontab file;
- write a validated `config.snapshot.json` for cron-fired subprocesses;
- preserve deterministic schedule ordering.

- [ ] **Step 6: Update the scheduler entrypoint to support `render` and `run <name>` modes**

Make `src/index.ts` support:
- startup/render mode for container boot;
- per-entry run mode that resolves the named schedule from the snapshot.

- [ ] **Step 7: Run the schedule and renderer tests to verify they pass**

Run: `pnpm --dir LocalAgent --filter @local-agent/task-scheduler test -- src/__tests__/schedule-config.test.ts src/__tests__/cron-renderer.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit schedule loading and rendering**

```bash
git add LocalAgent/packages/daemon/task-scheduler
git commit -m "feat(scheduler): add schedule config loading and cron rendering"
```

### Task 3: Extend Session Schema and Repository for Fallback Metadata

**Files:**
- Modify: `LocalAgent/packages/shared/src/db/schema.ts`
- Modify: `LocalAgent/packages/shared/src/db/session-repository.ts`
- Modify: `LocalAgent/packages/shared/src/__tests__/db/session-repository.test.ts`
- Create: `LocalAgent/packages/migrator/src/migrations/0004_scheduler_fallback_metadata.sql`
- Modify: `LocalAgent/packages/migrator/src/migrations/meta/_journal.json`
- Modify: `LocalAgent/packages/migrator/src/__tests__/migrate.test.ts`

- [ ] **Step 1: Write the failing migration test**

Update `LocalAgent/packages/migrator/src/__tests__/migrate.test.ts` to assert that `sessions` contains:
- `fallback_seed_text`;
- `fallback_origin`;
- `fallback_title_hint`.

Also assert that outbound lazy anchor creation is safe under retries/concurrency by ensuring `session_platform_links` has a uniqueness guard:
- `UNIQUE(session_id, platform)`.

Note: in the current shared Drizzle schema, `session_platform_links` already uses a composite primary key over `(session_id, platform)`, which satisfies the design requirement. This step is a regression guard; no schema change should be required unless the live DB/migrations diverge.

- [ ] **Step 2: Write the failing session repository test**

Update `LocalAgent/packages/shared/src/__tests__/db/session-repository.test.ts` to assert that `upsertSession()` and `getSessionById()` preserve the new fallback metadata fields and ignore stale out-of-order updates for them like other session fields.

- [ ] **Step 3: Run the migration and repository tests to verify failure**

Run: `pnpm --dir LocalAgent --filter @local-agent/migrator test -- src/__tests__/migrate.test.ts`
Run: `pnpm --dir LocalAgent --filter @local-agent/shared test -- src/__tests__/db/session-repository.test.ts`
Expected: FAIL because the schema/repository do not yet include the new fields.

- [ ] **Step 4: Add the schema fields and migration**

Update the shared schema and create `0004_scheduler_fallback_metadata.sql` to:

- add the three nullable columns to `sessions`.

Then register the migration in `_journal.json`.

- [ ] **Step 5: Extend the session repository API**

Update `SessionRepository` types and upsert logic to read/write:
- `fallbackSeedText`;
- `fallbackOrigin`;
- `fallbackTitleHint`.

Preserve the existing “newer update wins” semantics.

- [ ] **Step 6: Run the migration and repository tests to verify they pass**

Run: `pnpm --dir LocalAgent --filter @local-agent/migrator test -- src/__tests__/migrate.test.ts`
Run: `pnpm --dir LocalAgent --filter @local-agent/shared test -- src/__tests__/db/session-repository.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit the session metadata schema change**

```bash
git add LocalAgent/packages/shared/src/db/schema.ts LocalAgent/packages/shared/src/db/session-repository.ts LocalAgent/packages/shared/src/__tests__/db/session-repository.test.ts LocalAgent/packages/migrator/src/migrations/0004_scheduler_fallback_metadata.sql LocalAgent/packages/migrator/src/migrations/meta/_journal.json LocalAgent/packages/migrator/src/__tests__/migrate.test.ts
git commit -m "feat(session): persist fallback delivery metadata"
```

### Task 4: Extend Canonical `/tasks` Intake to Accept Optional Fallback Metadata

**Files:**
- Modify: `LocalAgent/packages/shared/src/types.ts`
- Modify: `LocalAgent/packages/shared/src/index.ts`
- Modify: `LocalAgent/packages/api/src/routes/tasks.ts`
- Modify: `LocalAgent/packages/api/src/__tests__/routes/tasks.test.ts`

- [ ] **Step 1: Write the failing `/tasks` route tests**

Add tests asserting `/tasks`:
- accepts an optional additive session fallback metadata object;
- rejects malformed fallback metadata types;
- remains backward compatible for callers that do not send the new fields.

- [ ] **Step 2: Run the `/tasks` route test to verify failure**

Run: `pnpm --dir LocalAgent --filter @local-agent/api test -- src/__tests__/routes/tasks.test.ts`
Expected: FAIL because the route and shared types do not yet accept the metadata.

- [ ] **Step 3: Add shared task-submission types for fallback metadata**

Extend the canonical task submission types with an optional additive field, preferably a dedicated object such as `session`, containing:
- `fallbackSeedText`;
- `fallbackOrigin`;
- `fallbackTitleHint`.

Also update `LocalAgent/packages/shared/src/types.ts` interfaces (e.g. `TaskSubmission`) to include this optional `session` object so scheduler code can type-check without using `any`.

- [ ] **Step 4: Update `/tasks` validation and persistence boundary**

Update the route so it validates the optional object and passes the new data through the task intake path in a way the scheduler can use while keeping old callers unchanged.

Implementation note (current code reality): `LocalAgent/packages/api/src/routes/tasks.ts` currently only publishes to RabbitMQ and does not touch DB/session repositories. To match the design decision that fallback seed metadata is persisted via canonical `/tasks` intake, this task must explicitly add an API-side write path to session persistence.

Concrete wiring suggestion (so implementers do not get stuck):
- In `LocalAgent/packages/api/src/index.ts`, create a sqlite client via `createSqliteClient(loadSqliteConfig())` and assert schema version like other daemons.
- Create a `SessionRepository` from that db.
- Thread that repository through `createApp(...)` and into `createTaskRoutes(...)`.
- In `POST /tasks`, require `session_id` if `req.body.session?.fallbackSeedText` is present, then `upsertSession({ sessionId, fallbackSeedText, fallbackOrigin, fallbackTitleHint, ... })` before publishing.

- [ ] **Step 5: Run the `/tasks` route test to verify it passes**

Run: `pnpm --dir LocalAgent --filter @local-agent/api test -- src/__tests__/routes/tasks.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit the `/tasks` intake contract update**

```bash
git add LocalAgent/packages/shared/src/types.ts LocalAgent/packages/shared/src/index.ts LocalAgent/packages/api/src/routes/tasks.ts LocalAgent/packages/api/src/__tests__/routes/tasks.test.ts
git commit -m "feat(api): accept fallback metadata on canonical tasks"
```

### Task 5: Implement Scheduler Submission Flow

**Files:**
- Create: `LocalAgent/packages/daemon/task-scheduler/src/submitter.ts`
- Create: `LocalAgent/packages/daemon/task-scheduler/src/__tests__/submitter.test.ts`
- Modify: `LocalAgent/packages/daemon/task-scheduler/src/index.ts`

- [ ] **Step 1: Write the failing scheduler submitter test**

Add tests asserting the scheduler submitter:
- generates a fresh `session_id` for each fired run;
- sends a normal canonical `/tasks` request;
- injects auth headers via the shared auth helper;
- includes fallback seed metadata using the task payload;
- surfaces API/network failures clearly.

- [ ] **Step 2: Run the scheduler submitter test to verify failure**

Run: `pnpm --dir LocalAgent --filter @local-agent/task-scheduler test -- src/__tests__/submitter.test.ts`
Expected: FAIL because the submitter does not exist yet.

- [ ] **Step 3: Implement the submitter and wire `run <name>` mode**

Implement `submitter.ts` to:
- load a named schedule entry from the snapshot;
- generate a session id using the shared helper;
- submit a canonical task to `/tasks`;
- include fallback metadata with `fallbackSeedText = payload` and a simple `fallbackOrigin` such as `scheduler`.

Submission retry policy (v1): do not loop retries inside a single `run` invocation. Log the schedule name + error and exit non-zero so Supercronic can surface failures, and rely on the next cron tick for re-attempt.

- [ ] **Step 4: Run the scheduler submitter test to verify it passes**

Run: `pnpm --dir LocalAgent --filter @local-agent/task-scheduler test -- src/__tests__/submitter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the scheduler submission flow**

```bash
git add LocalAgent/packages/daemon/task-scheduler/src/index.ts LocalAgent/packages/daemon/task-scheduler/src/submitter.ts LocalAgent/packages/daemon/task-scheduler/src/__tests__/submitter.test.ts
git commit -m "feat(scheduler): submit canonical tasks from cron runs"
```

### Task 6: Implement Lazy Lark Fallback Anchor Creation

**Files:**
- Modify: `LocalAgent/packages/daemon/lark-result/src/index.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/adapters/lark-phase-notifier.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-phase-notifier.test.ts`

- [ ] **Step 1: Write the failing Lark notifier tests**

Add tests asserting that when a phase/result event has no `task_source` thread and no existing Lark platform link:
- the notifier loads fallback session metadata;
- creates a new top-level message;
- persists the new root message/thread/link;
- replies in-thread for the triggering event;
- reuses the persisted root for later events.

- [ ] **Step 2: Run the Lark notifier tests to verify failure**

Run: `pnpm --dir LocalAgent --filter @local-agent/lark-result-daemon test -- src/__tests__/lark-notifier.test.ts src/__tests__/lark-phase-notifier.test.ts`
Expected: FAIL because fallback creation is not implemented.

- [ ] **Step 3: Inject the repositories needed for fallback resolution**

Update the Lark daemon wiring so the notifier/phase notifier can load session fallback metadata and write missing platform links safely.

Implementation note (current code reality): the outbound DB repositories (`SessionRepository`, `SessionPlatformLinkRepository`) are already created and passed into `LarkNotifier` in `LocalAgent/packages/daemon/lark-result/src/index.ts`, but `LarkPhaseNotifier` is currently Lark-source-only and cannot participate in fallback creation.

Concrete approach (recommended):
- Keep reaction-based phase updates for Lark-sourced tasks (where `task_source.message_id` exists).
- For non-Lark-sourced phase events that only have `session_id`, deliver a short status message (e.g. `Status: queued`) into the same lazily created Lark fallback thread used for results.
- Implement this by either:
  - injecting `LarkNotifier` into `LarkPoller` and routing non-Lark phase events through a new `LarkNotifier.notifyPhase(...)` method that shares the same destination resolution + lazy anchor creation; or
  - expanding `LarkPhaseNotifier` to accept `SessionRepository` + `SessionPlatformLinkRepository` + a message-sending capability so it can resolve/create the fallback destination itself.

- [ ] **Step 4: Implement lazy Lark anchor creation with idempotent reuse**

Update the notifier path to:
- prefer explicit `task_source` thread behavior when present;
- otherwise check `session_platform_links` for an existing Lark anchor;
- otherwise create a new top-level message using `fallbackSeedText`;
- persist the new Lark root/thread state and Lark session-platform link using an upsert/transaction keyed by `(session_id, platform)` so concurrent deliveries do not create duplicate anchors;
- send the triggering phase/result as an in-thread reply.

Phase delivery requirement (from design): the first outbound event for a session may be a phase event. Ensure the chosen implementation delivers phase updates for sessions without `task_source` by posting a message into the lazily created fallback thread.

- [ ] **Step 5: Run the Lark notifier tests to verify they pass**

Run: `pnpm --dir LocalAgent --filter @local-agent/lark-result-daemon test -- src/__tests__/lark-notifier.test.ts src/__tests__/lark-phase-notifier.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit the Lark fallback delivery change**

```bash
git add LocalAgent/packages/daemon/lark-result/src/index.ts LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts LocalAgent/packages/daemon/lark-result/src/adapters/lark-phase-notifier.ts LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts LocalAgent/packages/daemon/lark-result/src/__tests__/lark-phase-notifier.test.ts
git commit -m "feat(lark): lazily create fallback root threads"
```

### Task 7: Implement Lazy Telegram Topic Creation on Fallback Delivery

**Files:**
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/index.ts`
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts`
- Reuse/Modify: `LocalAgent/packages/daemon/telegram-inbound/src/adapters/telegram-topic-manager.ts`

- [ ] **Step 1: Write the failing Telegram notifier tests**

Add tests asserting that when a phase/result event has no Telegram topic and no existing Telegram platform link:
- a new forum topic is created;
- a seed message is posted using `fallbackSeedText`;
- the triggering event is posted into that topic;
- the topic state and session-platform link are persisted;
- later events reuse the topic.

- [ ] **Step 2: Run the Telegram notifier test to verify failure**

Run: `pnpm --dir LocalAgent --filter @local-agent/telegram-outbound-daemon test -- src/__tests__/telegram-notifier.test.ts`
Expected: FAIL because fallback topic creation is not implemented.

- [ ] **Step 3: Inject topic creation capability into the Telegram outbound daemon**

Wire `TelegramTopicManager` or an extracted shared equivalent into the outbound daemon so notifier code can create topics on demand.

Implementation note (current code reality): `TelegramNotifier.resolveDestination()` currently falls back to `SessionBridgeRepository` (if present) or the configured forum group, and it never consults `SessionPlatformLinkRepository` nor creates topics. This task should pivot to the design's session-platform-link based anchoring, with topic creation only when no explicit `task_source` and no existing link exists.

- [ ] **Step 4: Implement lazy Telegram topic creation with idempotent reuse**

Update the notifier path to:
- preserve existing explicit topic behavior when `task_source` provides it;
- otherwise check `session_platform_links` for a Telegram anchor;
- otherwise create a forum topic, post the seed message, persist topic/thread/link state using an upsert/transaction keyed by `(session_id, platform)` so concurrent deliveries do not create duplicate topics, and then post the triggering phase/result into that topic.

- [ ] **Step 5: Run the Telegram notifier test to verify it passes**

Run: `pnpm --dir LocalAgent --filter @local-agent/telegram-outbound-daemon test -- src/__tests__/telegram-notifier.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit the Telegram fallback delivery change**

```bash
git add LocalAgent/packages/daemon/telegram-outbound/src/index.ts LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts LocalAgent/packages/daemon/telegram-inbound/src/adapters/telegram-topic-manager.ts
git commit -m "feat(telegram): lazily create fallback forum topics"
```

### Task 8: Run Cross-Package Regression Tests and Verify Compose Wiring

**Files:**
- Modify as needed based on failures discovered in verification.

- [ ] **Step 1: Run targeted API/shared/daemon tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/shared test -- src/__tests__/db/session-repository.test.ts src/__tests__/db/session-platform-link-repository.test.ts`
Run: `pnpm --dir LocalAgent --filter @local-agent/api test -- src/__tests__/routes/tasks.test.ts src/__tests__/routes/results.test.ts`
Run: `pnpm --dir LocalAgent --filter @local-agent/lark-result-daemon test`
Run: `pnpm --dir LocalAgent --filter @local-agent/telegram-outbound-daemon test`
Run: `pnpm --dir LocalAgent --filter @local-agent/task-scheduler test`

Expected: PASS.

- [ ] **Step 2: Run migration coverage**

Run: `pnpm --dir LocalAgent --filter @local-agent/migrator test`
Expected: PASS.

- [ ] **Step 3: Build the affected packages**

Run: `pnpm --dir LocalAgent --filter @local-agent/shared build`
Run: `pnpm --dir LocalAgent --filter @local-agent/api build`
Run: `pnpm --dir LocalAgent --filter @local-agent/lark-result-daemon build`
Run: `pnpm --dir LocalAgent --filter @local-agent/telegram-outbound-daemon build`
Run: `pnpm --dir LocalAgent --filter @local-agent/task-scheduler build`
Expected: PASS.

- [ ] **Step 4: Smoke-check compose configuration**

Run: `docker compose -f LocalAgent/docker-compose.yml config`
Expected: PASS and includes the new `task-scheduler` service.

- [ ] **Step 5: Commit final verification fixes if needed**

```bash
git add LocalAgent
git commit -m "test: verify scheduled fallback delivery end to end"
```
