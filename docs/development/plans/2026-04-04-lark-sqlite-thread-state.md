# Lark SQLite Thread State Implementation Plan

**Goal:** Replace Lark thread-history reconstruction from the Lark Open API with a SQLite-backed canonical Lark thread store that persists inbound and outbound messages, serves thread metadata/history reads from shared repositories, and deletes rows by `session_id` on `/end` and GC.

**Architecture:** Add a shared SQLite access layer in `packages/shared` for `lark_threads` and `lark_messages`, plus a dedicated migration package/service that owns schema setup and upgrades. Update the Lark listener and Lark result daemons to persist inbound/outbound messages, then switch task-enrichment from remote thread reconstruction to DB-backed reads while keeping the existing user-facing Lark contract unchanged.

**Tech Stack:** TypeScript monorepo, SQLite, typed ORM/query-builder with migration tooling, existing Lark Open API integration, Vitest.

---

## File Structure

### New packages/files

- Create: `LocalAgent/packages/shared/src/db/`
  - Shared SQLite connection factory, schema definitions, repository helpers, and schema-version checks.
- Create: `LocalAgent/packages/shared/src/db/config.ts`
  - Shared DB path/env parsing.
- Create: `LocalAgent/packages/shared/src/db/schema.ts`
  - `lark_threads` and `lark_messages` schema definitions.
- Create: `LocalAgent/packages/shared/src/db/client.ts`
  - Connection bootstrap, WAL setup, runtime guardrails.
- Create: `LocalAgent/packages/shared/src/db/lark-history-repository.ts`
  - Lark-specific upsert/read/delete operations.
- Create: `LocalAgent/packages/shared/src/db/types.ts`
  - Shared DB-facing types for thread/message persistence.
- Create: `LocalAgent/packages/shared/src/db/history-format.ts`
  - Prompt-history formatting from DB rows.
- Create: `LocalAgent/packages/shared/src/db/schema-version.ts`
  - Helpers for schema compatibility assertions used by non-migrator services.
- Create: `LocalAgent/packages/shared/src/__tests__/db/`
  - Unit tests for connection config, repositories, formatting, and schema guards.
- Create: `LocalAgent/packages/migrator/`
  - Dedicated migration package/service.
- Create: `LocalAgent/packages/migrator/package.json`
- Create: `LocalAgent/packages/migrator/tsconfig.json`
- Create: `LocalAgent/packages/migrator/src/index.ts`
  - Process entrypoint for migration service/command.
- Create: `LocalAgent/packages/migrator/src/config.ts`
  - Migrator-specific config.
- Create: `LocalAgent/packages/migrator/src/migrate.ts`
  - Migration runner wiring.
- Create: `LocalAgent/packages/migrator/src/__tests__/`
  - Migrator config and migration-runner tests.

### Existing files to modify

- Modify: `LocalAgent/packages/shared/package.json`
  - Add SQLite/ORM dependencies and migration-related dev tooling.
- Modify: `LocalAgent/packages/shared/src/index.ts`
  - Export shared DB config/repository APIs.
- Modify: `LocalAgent/packages/shared/src/config.ts`
  - Add shared DB path/schema-version helpers if centralized here instead of db/config.ts only.
- Modify: `LocalAgent/packages/shared/src/constants.ts`
  - Add DB-related defaults as needed.
- Modify: `LocalAgent/packages/daemon/lark-listener/src/config.ts`
  - Require DB path/schema env or shared config usage.
- Modify: `LocalAgent/packages/daemon/lark-listener/src/index.ts`
  - Construct repository-backed persistence collaborators.
- Modify: `LocalAgent/packages/daemon/lark-listener/src/message-handler.ts`
  - Persist inbound messages and local usage replies via shared repositories.
- Modify: `LocalAgent/packages/daemon/lark-listener/src/adapters/lark-replier.ts`
  - Return/send enough information to persist successful outbound replies.
- Modify: `LocalAgent/packages/daemon/lark-result/src/config.ts`
  - Require DB path/schema env or shared config usage.
- Modify: `LocalAgent/packages/daemon/lark-result/src/index.ts`
  - Construct repository-backed persistence collaborators.
- Modify: `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`
  - Persist successful outbound replies and update canonical thread metadata.
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/config.ts`
  - Require DB path/schema env or shared config usage.
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/index.ts`
  - Stop wiring only the remote thread fetch path; add DB-backed reader path.
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`
  - Replace or shrink remote-reconstruction responsibilities to DB-backed reads, or remove if fully superseded.
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/enrichment-poller.ts`
  - Read thread metadata/history from shared DB repositories instead of Lark thread reconstruction.
- Modify: `LocalAgent/packages/daemon/task/src/adapters/cleanup-executor.ts`
  - Delete DB rows by `session_id` during cleanup.
- Modify: `LocalAgent/packages/daemon/task/src/services/gc-executor.ts`
  - Use shared DB delete helpers for ended-session cleanup safety net.
- Modify: `LocalAgent/docker-compose.yml`
  - Add shared DB volume/path and migrator startup wiring.
- Modify: `LocalAgent/docs/LOCAL_DEVELOPMENT.md`
  - Document migrator lifecycle and DB path.
- Modify: `LocalAgent/COMMANDS.md`
  - Only if cleanup/gc notes need DB lifecycle clarification.

### Existing tests to modify

- Modify: `LocalAgent/packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
  - Cover inbound persistence and local reply persistence.
- Modify: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
  - Cover outbound persistence and metadata updates.
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`
  - Replace remote reconstruction expectations with DB-backed ones or remove obsolete tests.
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`
  - Cover DB-backed history and metadata reads.
- Modify: `LocalAgent/packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts`
  - Cover DB row deletion.
- Modify: `LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts`
  - Cover DB cleanup safety-net behavior.

## Task 1: Choose and wire the SQLite stack

**Files:**
- Modify: `LocalAgent/packages/shared/package.json`
- Create: `LocalAgent/packages/shared/src/db/config.ts`
- Create: `LocalAgent/packages/shared/src/db/client.ts`
- Create: `LocalAgent/packages/shared/src/db/schema.ts`
- Create: `LocalAgent/packages/shared/src/db/types.ts`
- Modify: `LocalAgent/packages/shared/src/index.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/config.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/client.test.ts`

- [ ] **Step 1: Add a failing shared-config test for DB path and schema guard inputs**

```ts
import { describe, expect, it } from 'vitest';
import { loadSqliteConfig } from '../../db/config';

describe('loadSqliteConfig', () => {
  it('reads the SQLite DB path from env', () => {
    expect(loadSqliteConfig({ LOCAL_AGENT_SQLITE_PATH: '/tmp/local-agent.db' }).dbPath)
      .toBe('/tmp/local-agent.db');
  });
});
```

- [ ] **Step 2: Run the new shared DB config test to verify it fails**

Run: `pnpm --dir LocalAgent --filter @local-agent/shared test -- src/__tests__/db/config.test.ts`
Expected: FAIL because the DB config module does not exist yet.

- [ ] **Step 3: Add the SQLite/ORM dependencies and minimal DB config/client modules**

Implementation notes:
- Pick one typed SQLite-friendly stack with explicit migration tooling.
- Add `loadSqliteConfig()` that requires the DB path env var.
- Add `createSqliteClient()` that opens the DB and enables WAL mode.
- Add `assertExpectedSchemaVersion()` placeholder API for non-migrator services.
- Export the new APIs from shared.

- [ ] **Step 4: Add a small client test that proves WAL/bootstrap runs without migrating**

```ts
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteClient } from '../../db/client';

it('opens a sqlite database file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-agent-db-'));
  const db = createSqliteClient(join(dir, 'local-agent.db'));
  expect(db).toBeDefined();
});
```

- [ ] **Step 5: Run the shared DB config/client tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/shared test -- src/__tests__/db/config.test.ts src/__tests__/db/client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit the DB stack bootstrap**

```bash
git add LocalAgent/packages/shared/package.json LocalAgent/packages/shared/src/index.ts LocalAgent/packages/shared/src/db LocalAgent/packages/shared/src/__tests__/db/config.test.ts LocalAgent/packages/shared/src/__tests__/db/client.test.ts
git commit -m "feat(shared): add sqlite client bootstrap"
```

## Task 2: Define the `lark_threads` and `lark_messages` schema plus repositories

**Files:**
- Modify: `LocalAgent/packages/shared/src/db/schema.ts`
- Create: `LocalAgent/packages/shared/src/db/lark-history-repository.ts`
- Create: `LocalAgent/packages/shared/src/db/history-format.ts`
- Modify: `LocalAgent/packages/shared/src/index.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/lark-history-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/history-format.test.ts`

- [ ] **Step 1: Write failing repository tests for thread upsert, message insert, metadata update, and delete-by-session**

```ts
it('upserts a lark thread row and inserts inbound message rows', async () => {
  // create temp DB, call repository
  // assert thread metadata and message persistence
});

it('updates executor/model on /new without changing session_id', async () => {
  // seed thread, persist /new reply update, assert session_id unchanged
});

it('deletes lark rows by session_id', async () => {
  // seed rows, call delete helper, assert both tables empty
});
```

- [ ] **Step 2: Run the repository tests to verify they fail**

Run: `pnpm --dir LocalAgent --filter @local-agent/shared test -- src/__tests__/db/lark-history-repository.test.ts`
Expected: FAIL because repository/schema behavior is not implemented yet.

- [ ] **Step 3: Implement the schema definitions**

Schema requirements:
- `lark_threads(root_message_id, thread_id nullable unique, session_id, source, chat_type, task_type, executor, executor_model, status, created_at_ms, updated_at_ms, ended_at_ms)`
- `lark_messages(message_id, source, root_message_id, session_id, thread_id nullable, direction, sender_type, message_type, raw_content, normalized_text, metadata_json, created_at_ms)`
- required indexes from the design doc.

- [ ] **Step 4: Implement the shared repository API**

Repository API should include focused methods such as:
- `upsertInboundLarkMessage(...)`
- `recordOutboundLarkMessage(...)`
- `getLarkThreadByThreadId(...)`
- `getLarkThreadBySessionId(...)`
- `getLarkMessagesForThread(...)`
- `markLarkThreadNewInstance(...)`
- `markLarkThreadEnded(...)`
- `deleteLarkRowsBySessionId(...)`

- [ ] **Step 5: Implement prompt-history formatting from DB rows**

Formatting requirements:
- user inbound rows -> `user: ...`
- bot outbound rows -> `assistant: ...`
- strip visible metadata header lines from outbound normalized text before composing history
- prefer normalized text, fall back carefully if missing.

- [ ] **Step 6: Run repository and formatting tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/shared test -- src/__tests__/db/lark-history-repository.test.ts src/__tests__/db/history-format.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit the shared Lark repository layer**

```bash
git add LocalAgent/packages/shared/src/index.ts LocalAgent/packages/shared/src/db/schema.ts LocalAgent/packages/shared/src/db/lark-history-repository.ts LocalAgent/packages/shared/src/db/history-format.ts LocalAgent/packages/shared/src/__tests__/db/lark-history-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/history-format.test.ts
git commit -m "feat(shared): add lark sqlite repositories"
```

## Task 3: Add the dedicated migration package/service

**Files:**
- Create: `LocalAgent/packages/migrator/package.json`
- Create: `LocalAgent/packages/migrator/tsconfig.json`
- Create: `LocalAgent/packages/migrator/src/config.ts`
- Create: `LocalAgent/packages/migrator/src/migrate.ts`
- Create: `LocalAgent/packages/migrator/src/index.ts`
- Create: `LocalAgent/packages/migrator/src/__tests__/config.test.ts`
- Create: `LocalAgent/packages/migrator/src/__tests__/migrate.test.ts`
- Modify: `LocalAgent/rush.json`

- [ ] **Step 1: Write a failing migrator config test**

```ts
import { describe, expect, it } from 'vitest';
import { loadMigratorConfig } from '../config';

describe('loadMigratorConfig', () => {
  it('requires the shared sqlite path', () => {
    expect(loadMigratorConfig({ LOCAL_AGENT_SQLITE_PATH: '/tmp/local-agent.db' }).dbPath)
      .toBe('/tmp/local-agent.db');
  });
});
```

- [ ] **Step 2: Run the migrator test to verify it fails**

Run: `pnpm --dir LocalAgent --filter @local-agent/migrator test`
Expected: FAIL because the package does not exist yet.

- [ ] **Step 3: Scaffold the migrator package and wire it into the monorepo**

Implementation requirements:
- add the package to repo package discovery if needed;
- use the same shared DB config;
- invoke the ORM migration runner;
- exit non-zero on failure.

- [ ] **Step 4: Add a migration test that applies the initial schema to an empty temp DB**

```ts
it('applies the initial lark sqlite schema', async () => {
  // temp db path
  // run migration function
  // assert lark_threads and lark_messages exist
});
```

- [ ] **Step 5: Run the migrator tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/migrator test`
Expected: PASS.

- [ ] **Step 6: Commit the migrator package**

```bash
git add LocalAgent/packages/migrator LocalAgent/rush.json
git commit -m "feat(migrator): add sqlite schema migrator"
```

## Task 4: Persist inbound Lark messages in `lark-listener`

**Files:**
- Modify: `LocalAgent/packages/daemon/lark-listener/src/config.ts`
- Modify: `LocalAgent/packages/daemon/lark-listener/src/index.ts`
- Modify: `LocalAgent/packages/daemon/lark-listener/src/message-handler.ts`
- Modify: `LocalAgent/packages/daemon/lark-listener/src/adapters/lark-replier.ts`
- Modify: `LocalAgent/packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Test: `LocalAgent/packages/daemon/lark-listener/src/__tests__/config.test.ts`

- [ ] **Step 1: Add a failing listener test that asserts inbound persistence happens before submission**

```ts
it('persists inbound lark messages before task submission', async () => {
  const repo = { upsertInboundLarkMessage: vi.fn().mockResolvedValue(undefined) };
  // construct handler with repo dependency
  // handle message
  // expect repo write before submitter.submit
});
```

- [ ] **Step 2: Add a failing listener config test for DB/schema requirements**

Run: `pnpm --dir LocalAgent --filter @local-agent/lark-listener test -- src/__tests__/config.test.ts src/__tests__/message-handler.test.ts`
Expected: FAIL because the listener does not yet depend on the DB layer.

- [ ] **Step 3: Add a small Lark message metadata resolver for inbound writes**

Implementation requirements:
- do one `getMessage` lookup when needed to resolve `thread_id` and `root_message_id`;
- hide this behind a small adapter/repository-facing helper;
- avoid full thread listing.

- [ ] **Step 4: Update `MessageHandler` to persist inbound rows before submission**

Behavior:
- normalize content as today;
- resolve thread identity;
- upsert/insert DB rows through shared repository APIs;
- then continue the existing parse/submit/react flow.

- [ ] **Step 5: Persist local usage-error replies through the same shared writer path**

Implementation requirements:
- update `LarkReplier.reply()` to return enough information to persist successful replies;
- mark direction as outbound and sender as bot;
- associate the reply with the same thread/session when known.

- [ ] **Step 6: Run listener tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/lark-listener test`
Expected: PASS.

- [ ] **Step 7: Commit inbound listener persistence**

```bash
git add LocalAgent/packages/daemon/lark-listener/src/config.ts LocalAgent/packages/daemon/lark-listener/src/index.ts LocalAgent/packages/daemon/lark-listener/src/message-handler.ts LocalAgent/packages/daemon/lark-listener/src/adapters/lark-replier.ts LocalAgent/packages/daemon/lark-listener/src/__tests__/message-handler.test.ts LocalAgent/packages/daemon/lark-listener/src/__tests__/config.test.ts
git commit -m "feat(lark-listener): persist inbound lark messages"
```

## Task 5: Persist outbound Lark result replies and canonical metadata updates

**Files:**
- Modify: `LocalAgent/packages/daemon/lark-result/src/config.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/index.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
- Test: `LocalAgent/packages/daemon/lark-result/src/__tests__/config.test.ts`

- [ ] **Step 1: Add a failing notifier test that asserts successful replies are persisted**

```ts
it('persists outbound lark replies after successful send', async () => {
  // mock successful send
  // assert repository.recordOutboundLarkMessage called
});
```

- [ ] **Step 2: Add a failing notifier test for `/new` metadata updates**

```ts
it('updates thread executor/model on /new while preserving session_id', async () => {
  // result shape that represents /new completion
  // assert thread metadata update call
});
```

- [ ] **Step 3: Run notifier tests to verify they fail**

Run: `pnpm --dir LocalAgent --filter @local-agent/lark-result test -- src/__tests__/lark-notifier.test.ts`
Expected: FAIL because no DB persistence hooks exist yet.

- [ ] **Step 4: Update `LarkNotifier` to persist successful outbound replies**

Implementation requirements:
- persist the reply text after successful Lark send;
- keep existing visible headers unchanged;
- associate message rows with canonical thread/session metadata.

- [ ] **Step 5: Update `LarkNotifier` to maintain canonical thread metadata**

Rules:
- normal successful task replies may update `task_type`, `executor`, `executor_model`, and `updated_at` on `lark_threads`;
- `/new` reply must mark `metadata_json.event_kind = 'new_instance_reply'` and update executor/model while preserving session_id;
- `/end` does not create a new session.

- [ ] **Step 6: Run lark-result tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/lark-result test`
Expected: PASS.

- [ ] **Step 7: Commit outbound persistence**

```bash
git add LocalAgent/packages/daemon/lark-result/src/config.ts LocalAgent/packages/daemon/lark-result/src/index.ts LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts LocalAgent/packages/daemon/lark-result/src/__tests__/config.test.ts
git commit -m "feat(lark-result): persist outbound lark replies"
```

## Task 6: Replace enrichment thread reconstruction with DB-backed reads

**Files:**
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/config.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/index.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify or Remove: `LocalAgent/packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`
- Modify or Remove: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`
- Test: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/config.test.ts`

- [ ] **Step 1: Write a failing enrichment test that proves thread metadata/history come from DB**

```ts
it('builds thread continuation from sqlite-backed lark repositories', async () => {
  // seed DB rows
  // poll once
  // assert POST /jobs body uses DB-derived history + metadata
});
```

- [ ] **Step 2: Write a failing enrichment test that proves no full-thread Lark fetch occurs**

```ts
it('does not call remote listMessages for thread continuation', async () => {
  // spy/mock old fetcher path
  // expect DB path only
});
```

- [ ] **Step 3: Run enrichment tests to verify they fail**

Run: `pnpm --dir LocalAgent --filter @local-agent/task-enrichment test -- src/__tests__/enrichment-poller.test.ts`
Expected: FAIL because enrichment still depends on the old thread reconstruction path.

- [ ] **Step 4: Implement DB-backed thread state reading**

Requirements:
- resolve canonical thread metadata from `lark_threads` by `root_message_id`, `thread_id`, or a lookup starting from `message_id`;
- read ordered message rows from `lark_messages` ordered by `(created_at_ms, message_id)`;
- format prompt history from DB rows;
- keep current control-task behavior (`/status`, `/new`, `/end`) intact.

- [ ] **Step 5: Remove or narrow obsolete remote reconstruction logic**

Acceptable end states:
- delete `ThreadContextFetcher` if fully obsolete;
- or keep only the minimum thread-id resolution role that is still needed elsewhere.

- [ ] **Step 6: Run task-enrichment tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/task-enrichment test`
Expected: PASS.

- [ ] **Step 7: Commit DB-backed enrichment reads**

```bash
git add LocalAgent/packages/daemon/task-enrichment/src/config.ts LocalAgent/packages/daemon/task-enrichment/src/index.ts LocalAgent/packages/daemon/task-enrichment/src/enrichment-poller.ts LocalAgent/packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts LocalAgent/packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts LocalAgent/packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts LocalAgent/packages/daemon/task-enrichment/src/__tests__/config.test.ts
git commit -m "feat(task-enrichment): read lark thread state from sqlite"
```

## Task 7: Delete DB rows on cleanup and GC

**Files:**
- Modify: `LocalAgent/packages/daemon/task/src/adapters/cleanup-executor.ts`
- Modify: `LocalAgent/packages/daemon/task/src/services/gc-executor.ts`
- Modify: `LocalAgent/packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts`
- Modify: `LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts`

- [ ] **Step 1: Add a failing cleanup test for DB row deletion by `session_id`**

```ts
it('deletes lark sqlite rows for the cleaned session', async () => {
  // seed DB rows, execute cleanup, assert rows removed
});
```

- [ ] **Step 2: Add a failing GC test for ended-thread cleanup safety net**

```ts
it('removes ended lark sqlite rows during gc safety-net cleanup', async () => {
  // seed ended thread rows, execute gc, assert delete helper used
});
```

- [ ] **Step 3: Run cleanup and GC tests to verify they fail**

Run: `pnpm --dir LocalAgent --filter @local-agent/task test -- src/adapters/__tests__/cleanup-executor.test.ts src/services/__tests__/gc-executor.test.ts`
Expected: FAIL because the DB delete path does not exist yet.

- [ ] **Step 4: Update cleanup execution to delete DB rows by session_id**

Rules:
- keep existing workspace deletion behavior;
- add shared repository deletion in the same logical cleanup path;
- fail loudly if DB deletion fails.

- [ ] **Step 5: Update GC to use the DB ended-session safety-net path**

Rules:
- existing filesystem GC behavior remains;
- add DB cleanup for rows intentionally marked ended but still present.

- [ ] **Step 6: Run task-daemon cleanup tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/task test -- src/adapters/__tests__/cleanup-executor.test.ts src/services/__tests__/gc-executor.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit cleanup/GC DB deletion support**

```bash
git add LocalAgent/packages/daemon/task/src/adapters/cleanup-executor.ts LocalAgent/packages/daemon/task/src/services/gc-executor.ts LocalAgent/packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts
git commit -m "feat(task): delete lark sqlite rows on cleanup"
```

## Task 8: Wire deployment, startup checks, and docs

**Files:**
- Modify: `LocalAgent/docker-compose.yml`
- Modify: `LocalAgent/docs/LOCAL_DEVELOPMENT.md`
- Modify: `LocalAgent/packages/daemon/lark-listener/src/config.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/config.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/config.ts`
- Test: config test files in each touched package

- [ ] **Step 1: Add failing config tests for schema-version fail-fast behavior in normal services**

```ts
it('fails fast when the sqlite schema is outdated', () => {
  // mock schema guard mismatch
  // expect startup config/bootstrap path to throw
});
```

- [ ] **Step 2: Run the affected config tests to verify they fail**

Run: `pnpm --dir LocalAgent --filter @local-agent/lark-listener test -- src/__tests__/config.test.ts && pnpm --dir LocalAgent --filter @local-agent/lark-result test -- src/__tests__/config.test.ts && pnpm --dir LocalAgent --filter @local-agent/task-enrichment test -- src/__tests__/config.test.ts`
Expected: FAIL because the services do not yet assert schema readiness.

- [ ] **Step 3: Wire compose/startup ordering and shared DB path env vars**

Implementation requirements:
- add migrator service or explicit migration command wiring;
- mount a shared path/volume for the SQLite file;
- document the expected deploy/start order.

- [ ] **Step 4: Add fail-fast schema checks to normal service startup**

Rules:
- services should verify schema compatibility at startup;
- services should not perform schema upgrades themselves.

- [ ] **Step 5: Update local development docs**

Docs must cover:
- DB path env var;
- migrator package/service usage;
- startup order;
- no-backfill rollout caveat.

- [ ] **Step 6: Run the touched config/doc-adjacent tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/lark-listener test -- src/__tests__/config.test.ts && pnpm --dir LocalAgent --filter @local-agent/lark-result test -- src/__tests__/config.test.ts && pnpm --dir LocalAgent --filter @local-agent/task-enrichment test -- src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit deployment and docs changes**

```bash
git add LocalAgent/docker-compose.yml LocalAgent/docs/LOCAL_DEVELOPMENT.md LocalAgent/packages/daemon/lark-listener/src/config.ts LocalAgent/packages/daemon/lark-result/src/config.ts LocalAgent/packages/daemon/task-enrichment/src/config.ts LocalAgent/packages/daemon/lark-listener/src/__tests__/config.test.ts LocalAgent/packages/daemon/lark-result/src/__tests__/config.test.ts LocalAgent/packages/daemon/task-enrichment/src/__tests__/config.test.ts
git commit -m "chore: wire sqlite migrator startup and docs"
```

## Task 9: Run focused verification and final repo-wide checks

**Files:**
- Test: all touched package test suites
- Modify: any touched files only if fallout fixes are needed

- [ ] **Step 1: Run shared tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/shared test`
Expected: PASS.

- [ ] **Step 2: Run Lark listener tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/lark-listener test`
Expected: PASS.

- [ ] **Step 3: Run Lark result tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/lark-result test`
Expected: PASS.

- [ ] **Step 4: Run task-enrichment tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/task-enrichment test`
Expected: PASS.

- [ ] **Step 5: Run task-daemon tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/task test`
Expected: PASS.

- [ ] **Step 6: Run migrator tests**

Run: `pnpm --dir LocalAgent --filter @local-agent/migrator test`
Expected: PASS.

- [ ] **Step 7: Fix only direct fallout in touched areas if any suite fails**

Guidance:
- do not broaden scope beyond SQLite Lark persistence;
- if a test exposes an unclear design assumption, update the implementation to match the design spec rather than inventing new behavior.

- [ ] **Step 8: Commit final fallout fixes if needed**

```bash
git add <touched files>
git commit -m "test: stabilize lark sqlite thread state rollout"
```
