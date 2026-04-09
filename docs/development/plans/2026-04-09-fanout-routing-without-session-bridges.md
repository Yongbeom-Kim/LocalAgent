# Fanout Routing Without Session Bridges Implementation Plan

**Goal:** Remove `session_bridges` and implement explicit `context_ref`-anchored fanout routing for shared Lark and Telegram delivery.

**Architecture:** Keep fanout as transport only while making `context_ref` the required reporting-channel contract on shared-channel phase, result, and mirror events. Persistent routing truth stays in root-session ownership plus `session_platform_links`, and runtime consumers stop inferring cross-platform destinations from bridge rows.

**Tech Stack:** TypeScript, Rush monorepo, Drizzle ORM, SQLite/libSQL, RabbitMQ, Vitest

---

## File Structure

- `packages/shared/src/types.ts`: tighten event contracts and validators around `context_ref`
- `packages/api/src/routes/results.ts`: enforce hard-fail validation for shared-channel events missing `context_ref`
- `packages/shared/src/db/schema.ts`: remove `session_bridges` from the shared schema
- `packages/shared/src/db/session-platform-link-repository.ts`: expose only root-session and platform-link helpers needed after bridge removal
- `packages/shared/src/db/lark-history-repository.ts`: preserve root ownership on thread rows
- `packages/shared/src/db/telegram-history-repository.ts`: preserve root ownership on topic rows
- `packages/daemon/task-enrichment/src/enrichment-poller.ts`: ensure queued/terminal/mirror publication paths preserve `context_ref`
- `packages/daemon/task/src/task-poller.ts`: ensure task-daemon result publication preserves `context_ref`
- `packages/daemon/lark-result/src/adapters/lark-notifier.ts`: route only from explicit Lark `context_ref`
- `packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`: route only from explicit Telegram `context_ref`
- `packages/daemon/task/src/services/gc-executor.ts`: remove bridge cleanup branches
- `packages/shared/src/index.ts`: remove bridge repository exports
- `packages/migrator/src/migrations/0008_drop_session_bridges.sql`: drop the bridge table
- `packages/migrator/src/__tests__/migrate.test.ts`: assert the final schema no longer contains `session_bridges`

### Task 1: Tighten Shared Event Contracts Around `context_ref`

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing contract tests**

```ts
it('requires context_ref for mirror events', () => {
  // mirror payload without context_ref should be invalid
});

it('exposes helpers that distinguish shared-channel events requiring context_ref', () => {
  // phase/result/mirror shared-channel payloads must carry a reporting-channel anchor
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix packages/shared -- src/__tests__/types.test.ts -v`
Expected: FAIL because the current type guards still accept bridge-era payloads without a required routing anchor.

- [ ] **Step 3: Write minimal implementation**

Update `types.ts` so the shared event validators enforce the new contract shape for shared-channel events and document the rule that `context_ref` is mandatory for fanout-routed delivery.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix packages/shared -- src/__tests__/types.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): require context refs for shared-channel events"
```

### Task 2: Hard-Fail Invalid Shared-Channel Events at the API Boundary

**Files:**
- Modify: `packages/api/src/routes/results.ts`
- Test: `packages/api/src/__tests__/routes/results.test.ts`

- [ ] **Step 1: Write the failing route tests**

```ts
it('rejects mirror POST /results when context_ref is missing', async () => {
  // POST /results with mirror event and no context_ref returns 400
});

it('rejects shared-channel phase/result POST /results when context_ref is missing', async () => {
  // shared-channel lifecycle event without context_ref returns 400
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix packages/api -- src/__tests__/routes/results.test.ts -v`
Expected: FAIL because the API currently accepts bridge-era events with missing routing anchors.

- [ ] **Step 3: Write minimal implementation**

Tighten `results.ts` validation so:

- mirror always requires `context_ref`;
- phase/result paths reject shared-channel submissions without `context_ref`;
- the error text is explicit that shared-channel routing now requires a reporting-channel anchor.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix packages/api -- src/__tests__/routes/results.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/results.ts packages/api/src/__tests__/routes/results.test.ts
git commit -m "feat(api): hard fail missing context refs on results events"
```

### Task 3: Ensure All Shared-Channel Publishers Emit `context_ref`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/task-enrichment/src/adapters/task-phase-publisher.ts`
- Modify: `packages/daemon/task/src/task-poller.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`
- Test: `packages/daemon/task/src/__tests__/task-poller.test.ts`

- [ ] **Step 1: Write the failing publisher tests**

```ts
it('publishes queued and rejection events with context_ref for shared-channel work', async () => {
  // enrichment emits phase/result payloads containing context_ref
});

it('publishes task-daemon final results with the original context_ref', async () => {
  // task execution result POST /results preserves reporting-channel anchor
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/task-enrichment-daemon --to @local-agent/task-daemon`
Expected: FAIL because not every shared-channel publication path currently preserves or requires `context_ref`.

- [ ] **Step 3: Write minimal implementation**

Update the publishing paths so that every shared-channel phase/result/mirror event includes the correct `context_ref` and there is no dependence on downstream destination inference.

- [ ] **Step 4: Run test to verify it passes**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/task-enrichment-daemon --to @local-agent/task-daemon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/adapters/task-phase-publisher.ts packages/daemon/task/src/task-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts packages/daemon/task/src/__tests__/task-poller.test.ts
git commit -m "feat(daemons): preserve context refs through fanout publication"
```

### Task 4: Remove Bridge-Based Routing from Lark and Telegram Consumers

**Files:**
- Modify: `packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
- Test: `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
- Test: `packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts`

- [ ] **Step 1: Write the failing consumer tests**

```ts
it('routes lark delivery only from explicit lark context_ref', async () => {
  // no session_bridges fallback
});

it('routes telegram delivery only from explicit telegram context_ref', async () => {
  // no session_bridges fallback
});

it('fails shared-channel delivery when context_ref is missing', async () => {
  // notifier does not guess from session_id or task_source
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: FAIL because both consumers still contain bridge-era fallback logic.

- [ ] **Step 3: Write minimal implementation**

Update both notifiers so they:

- require explicit platform-matching `context_ref` for shared-channel delivery;
- use platform history only to load metadata and persist messages;
- never consult `session_bridges` or peer-platform inference for delivery.

- [ ] **Step 4: Run test to verify it passes**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-result/src/adapters/lark-notifier.ts packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts
git commit -m "refactor(notifiers): remove bridge inference from shared-channel routing"
```

### Task 5: Remove the Bridge Table and Repository Layer

**Files:**
- Modify: `packages/shared/src/db/schema.ts`
- Modify: `packages/shared/src/index.ts`
- Delete: `packages/shared/src/db/session-bridge-repository.ts`
- Delete: `packages/shared/src/__tests__/db/session-bridge-repository.test.ts`
- Modify: `packages/shared/src/db/lark-history-repository.ts`
- Modify: `packages/shared/src/db/telegram-history-repository.ts`
- Modify: `packages/shared/src/db/session-platform-link-repository.ts`

- [ ] **Step 1: Write the failing shared repository tests**

```ts
it('preserves root ownership on lark and telegram thread rows without session_bridges', async () => {
  // child output should not rewrite root ownership
});

it('resolves routing support from platform links without bridge helpers', async () => {
  // repository API no longer exports bridge concepts
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix packages/shared -- src/__tests__/db/lark-history-repository.test.ts src/__tests__/db/telegram-history-repository.test.ts src/__tests__/db/session-platform-link-repository.test.ts -v`
Expected: FAIL because bridge-era repository assumptions still exist.

- [ ] **Step 3: Write minimal implementation**

Remove `session_bridges` from the shared schema/export surface, delete the bridge repository, and keep only the root-session and platform-link helpers needed by the new model.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix packages/shared -- src/__tests__/db/lark-history-repository.test.ts src/__tests__/db/telegram-history-repository.test.ts src/__tests__/db/session-platform-link-repository.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/shared/src/index.ts packages/shared/src/db/lark-history-repository.ts packages/shared/src/db/telegram-history-repository.ts packages/shared/src/db/session-platform-link-repository.ts
git rm packages/shared/src/db/session-bridge-repository.ts packages/shared/src/__tests__/db/session-bridge-repository.test.ts
git commit -m "refactor(shared): delete session bridge persistence"
```

### Task 6: Drop `session_bridges` in the Migrated Schema

**Files:**
- Create: `packages/migrator/src/migrations/0008_drop_session_bridges.sql`
- Modify: `packages/migrator/src/migrations/meta/_journal.json`
- Modify: `packages/migrator/src/__tests__/migrate.test.ts`

- [ ] **Step 1: Write the failing migration tests**

```ts
it('final migrated schema does not contain session_bridges', async () => {
  // PRAGMA table_info('session_bridges') returns no rows
});

it('still migrates routing state through root-session and platform-link tables', async () => {
  // lark_threads, telegram_threads, and session_platform_links remain intact
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix packages/migrator -- src/__tests__/migrate.test.ts -v`
Expected: FAIL because the current final schema still includes `session_bridges`.

- [ ] **Step 3: Write minimal implementation**

Add migration `0008_drop_session_bridges.sql` to drop the table and update schema-version metadata. Keep all remaining routing tables untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix packages/migrator -- src/__tests__/migrate.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/migrator/src/migrations/0008_drop_session_bridges.sql packages/migrator/src/migrations/meta/_journal.json packages/migrator/src/__tests__/migrate.test.ts
git commit -m "refactor(migrator): drop session bridges table"
```

### Task 7: Remove Bridge-Specific Cleanup and GC Logic

**Files:**
- Modify: `packages/daemon/task/src/services/gc-executor.ts`
- Modify: `packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
- Test: `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
- Test: `packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts`

- [ ] **Step 1: Write the failing cleanup tests**

```ts
it('cleans a session subtree without querying session_bridges', async () => {
  // cleanup reply posts first, then deletes sessions, links, and platform rows only
});

it('gc succeeds against a schema with no session_bridges table', async () => {
  // no special-case bridge error handling needed
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/task-daemon --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: FAIL because cleanup and GC still contain bridge-table branches.

- [ ] **Step 3: Write minimal implementation**

Delete bridge-specific cleanup calls and make subtree deletion rely only on session, link, and history repositories.

- [ ] **Step 4: Run test to verify it passes**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/task-daemon --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/services/gc-executor.ts packages/daemon/lark-result/src/adapters/lark-notifier.ts packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts
git commit -m "refactor(cleanup): remove bridge-specific teardown logic"
```

### Task 8: Run the Direct-Cutover Regression Sweep

**Files:**
- Modify as needed: `packages/api/src/__tests__/routes/results.test.ts`
- Modify as needed: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`
- Modify as needed: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Modify as needed: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Add any remaining regression tests discovered during integration**

```ts
it('never publishes a shared-channel event without context_ref after the cutover', async () => {
  // integration guard across API and producers
});
```

- [ ] **Step 2: Run the cross-package regression suite**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/shared --to @local-agent/api --to @local-agent/migrator --to @local-agent/task-enrichment-daemon --to @local-agent/task-daemon --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: PASS

- [ ] **Step 3: Fix any remaining direct-cutover contract gaps**

Only patch cases where bridge-era assumptions or missing `context_ref` still survive.

- [ ] **Step 4: Re-run the cross-package regression suite**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/shared --to @local-agent/api --to @local-agent/migrator --to @local-agent/task-enrichment-daemon --to @local-agent/task-daemon --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/__tests__/routes/results.test.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts packages/daemon/task/src/__tests__/task-poller.test.ts packages/shared/src/__tests__/types.test.ts
git commit -m "test: finalize fanout routing cutover without session bridges"
```

## Definition of Done

- No runtime code imports or constructs `SessionBridgeRepository`.
- Final migrated schema contains no `session_bridges` table.
- Shared-channel phase, result, and mirror events require explicit `context_ref`.
- Lark and Telegram consumers no longer infer destinations from bridge rows.
- Cleanup and GC succeed without bridge-table access.
- The regression suite in Task 8 passes.
