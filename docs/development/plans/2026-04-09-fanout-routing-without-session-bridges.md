# Fanout Routing Without Session Bridges Implementation Plan

**Goal:** Remove `session_bridges` and implement explicit `context_ref`-anchored fanout routing for shared Lark and Telegram delivery.

**Architecture:** Keep fanout as transport only while making `context_ref` the required reporting-channel contract for mirror events and for any shared-channel phase/result event. Persistent routing truth stays in root-session ownership plus `session_platform_links`, where platform history owns channel ownership semantics and links remain attachment-only.

**Important clarification:** This cutover allows direct same-platform source-addressed events to remain explicit and lightweight, but it does not allow pollers or consumers to guess shared-channel destinations. If fallback channel creation remains part of the product, that materialization must happen before fanout publication so resulting events still carry `context_ref`.

**Tech Stack:** TypeScript, Rush monorepo, Drizzle ORM, SQLite/libSQL, RabbitMQ, Vitest

---

## File Structure

- `packages/shared/src/types.ts`: tighten event contracts and validators around `context_ref`
- `packages/api/src/routes/tasks.ts`: enforce task-intake validation for shared-channel session-backed work
- `packages/api/src/routes/results.ts`: enforce hard-fail validation for mirror events and shared-channel phase/result events missing `context_ref`
- `packages/shared/src/db/schema.ts`: remove `session_bridges` from the shared schema
- `packages/shared/src/db/session-platform-link-repository.ts`: expose only attachment-oriented platform-link helpers needed after bridge removal
- `packages/shared/src/db/lark-history-repository.ts`: preserve root ownership on thread rows
- `packages/shared/src/db/telegram-history-repository.ts`: preserve root ownership on topic rows
- `packages/daemon/lark-listener/src/adapters/task-submitter.ts`: require and preserve `context_ref` for shared-channel Lark submissions
- `packages/daemon/telegram-inbound/src/adapters/telegram-task-submitter.ts`: require and preserve `context_ref` for shared-channel Telegram submissions
- `packages/daemon/task-enrichment/src/enrichment-poller.ts`: ensure queued/terminal/mirror publication paths preserve `context_ref`
- `packages/daemon/task-enrichment/src/adapters/task-phase-publisher.ts`: preserve `context_ref` on phase publication
- `packages/daemon/task/src/task-poller.ts`: ensure task-daemon result publication preserves `context_ref`
- `packages/daemon/lark-result/src/lark-poller.ts`: dispatch using explicit contract rules instead of bridge-era heuristics
- `packages/daemon/telegram-outbound/src/telegram-poller.ts`: dispatch using explicit contract rules instead of bridge-era heuristics
- `packages/daemon/lark-result/src/adapters/lark-notifier.ts`: route only from explicit Lark `context_ref` for shared-channel delivery
- `packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`: route only from explicit Telegram `context_ref` for shared-channel delivery
- `packages/daemon/lark-result/src/index.ts`: remove bridge repository wiring from daemon bootstrap
- `packages/daemon/telegram-outbound/src/index.ts`: remove bridge repository wiring from daemon bootstrap
- `packages/daemon/task/src/services/gc-executor.ts`: remove bridge cleanup branches
- `packages/shared/src/index.ts`: remove bridge repository exports
- `packages/migrator/src/migrations/0008_drop_session_bridges.sql`: drop the bridge table
- `packages/migrator/src/__tests__/migrate.test.ts`: assert the final schema no longer contains `session_bridges`

## Task 1: Tighten Shared Event Contracts Around `context_ref`

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing contract tests**

```ts
it('requires context_ref for mirror events', () => {
  // mirror payload without context_ref should be invalid
});

it('requires context_ref for shared-channel phase/result events', () => {
  // session-backed lifecycle payloads must carry a reporting-channel anchor
});

it('allows direct same-platform phase/result events without session_id to omit context_ref', () => {
  // task_source-addressed direct delivery remains valid
});

it('rejects mirror payloads that rely only on task_source.source for destination semantics', () => {
  // origin metadata is not the delivery contract
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix packages/shared -- src/__tests__/types.test.ts -v`
Expected: FAIL because the current type guards still accept bridge-era payloads without a required routing anchor.

- [ ] **Step 3: Write minimal implementation**

Update `types.ts` so the shared event validators enforce the new contract shape: mirror always requires `context_ref`, shared-channel phase/result events require it, and only direct same-platform events without `session_id` may omit it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix packages/shared -- src/__tests__/types.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): require context refs for shared-channel events"
```

## Task 2: Align Task Intake With the Shared-Channel Routing Contract

**Files:**
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
- Modify: `packages/daemon/telegram-inbound/src/adapters/telegram-task-submitter.ts`
- Test: `packages/api/src/__tests__/routes/tasks.test.ts`
- Test: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`

- [ ] **Step 1: Write the failing task-intake tests**

```ts
it('rejects shared-channel session-backed task submissions without context_ref', async () => {
  // session-backed work that will publish into a shared channel must arrive anchored
});

it('accepts direct same-platform task submissions that do not establish shared-channel routing', async () => {
  // direct source-addressed submissions remain valid
});

it('preserves context_ref through lark and telegram inbound submitters', async () => {
  // submitters forward the resolved reporting anchor
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/api --to @local-agent/lark-listener-daemon --to @local-agent/telegram-inbound-daemon`
Expected: FAIL because task intake still allows session-backed work to proceed without the routing anchor required by downstream fanout delivery.

- [ ] **Step 3: Write minimal implementation**

Update `/tasks` and inbound submitters so shared-channel session-backed work requires and preserves `context_ref`. Keep direct same-platform flows valid when they are fully addressed by `task_source` and do not rely on shared-channel fanout routing.

- [ ] **Step 4: Run test to verify it passes**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/api --to @local-agent/lark-listener-daemon --to @local-agent/telegram-inbound-daemon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/tasks.ts packages/daemon/lark-listener/src/adapters/task-submitter.ts packages/daemon/telegram-inbound/src/adapters/telegram-task-submitter.ts packages/api/src/__tests__/routes/tasks.test.ts packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts
git commit -m "feat(intake): require anchored shared-channel task submissions"
```

## Task 3: Hard-Fail Invalid Shared-Channel Events at the Result API Boundary

**Files:**
- Modify: `packages/api/src/routes/results.ts`
- Test: `packages/api/src/__tests__/routes/results.test.ts`

- [ ] **Step 1: Write the failing route tests**

```ts
it('rejects mirror POST /results when context_ref is missing', async () => {
  // POST /results with mirror event and no context_ref returns 400
});

it('rejects shared-channel phase/result POST /results when context_ref is missing', async () => {
  // anchored lifecycle event without context_ref returns 400
});

it('accepts direct same-platform phase/result POST /results without context_ref when session_id is omitted', async () => {
  // task_source-addressed direct delivery remains valid
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --prefix packages/api -- src/__tests__/routes/results.test.ts -v`
Expected: FAIL because the API currently accepts bridge-era events with missing routing anchors.

- [ ] **Step 3: Write minimal implementation**

Tighten `results.ts` validation so:

- mirror always requires `context_ref`;
- shared-channel phase/result paths require `context_ref`;
- direct same-platform phase/result paths allow omitted `context_ref` only when `session_id` is omitted and `task_source` fully addresses same-platform delivery;
- the error text is explicit that shared-channel routing now requires a reporting-channel anchor.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --prefix packages/api -- src/__tests__/routes/results.test.ts -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/results.ts packages/api/src/__tests__/routes/results.test.ts
git commit -m "feat(api): hard fail missing context refs on results events"
```

## Task 4: Ensure All Shared-Channel Publishers Emit `context_ref`

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

it('publishes enrichment status results with context_ref when shared-channel delivery is used', async () => {
  // status lookup result paths preserve the reporting-channel anchor
});

it('never relies on notifier-side fallback creation to fill missing context_ref', async () => {
  // publication must already be contract-complete
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/task-enrichment-daemon --to @local-agent/task-daemon`
Expected: FAIL because not every shared-channel publication path currently preserves or requires `context_ref`.

- [ ] **Step 3: Write minimal implementation**

Update the publishing paths so that every mirror event and every shared-channel phase/result event includes the correct `context_ref`, including enrichment status and synthetic failure paths, and there is no dependence on downstream destination inference.

- [ ] **Step 4: Run test to verify it passes**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/task-enrichment-daemon --to @local-agent/task-daemon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/adapters/task-phase-publisher.ts packages/daemon/task/src/task-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts packages/daemon/task/src/__tests__/task-poller.test.ts
git commit -m "feat(daemons): preserve context refs through fanout publication"
```

## Task 5: Remove Bridge-Era Dispatch Heuristics From Pollers

**Files:**
- Modify: `packages/daemon/lark-result/src/lark-poller.ts`
- Modify: `packages/daemon/telegram-outbound/src/telegram-poller.ts`
- Test: `packages/daemon/lark-result/src/__tests__/lark-poller.test.ts`
- Test: `packages/daemon/telegram-outbound/src/__tests__/telegram-poller.test.ts`

- [ ] **Step 1: Write the failing poller tests**

```ts
it('dispatches mirror events by explicit platform contract rather than task_source.source', async () => {
  // origin platform does not decide delivery target
});

it('dispatches shared-channel lifecycle events only when the platform contract matches', async () => {
  // poller rejects malformed or mismatched shared-channel payloads
});

it('keeps direct same-platform source-addressed events working', async () => {
  // direct delivery remains supported without shared-channel guessing
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: FAIL because current pollers still contain origin-based dispatch heuristics.

- [ ] **Step 3: Write minimal implementation**

Update pollers so they dispatch shared-channel and mirror events according to the explicit contract, not bridge-era `task_source.source` heuristics. Preserve direct same-platform source-addressed behavior where the event shape makes that intent explicit.

- [ ] **Step 4: Run test to verify it passes**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-result/src/lark-poller.ts packages/daemon/telegram-outbound/src/telegram-poller.ts packages/daemon/lark-result/src/__tests__/lark-poller.test.ts packages/daemon/telegram-outbound/src/__tests__/telegram-poller.test.ts
git commit -m "refactor(pollers): dispatch fanout events by explicit routing contract"
```

## Task 6: Remove Bridge-Based Routing From Lark and Telegram Consumers

**Files:**
- Modify: `packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
- Test: `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
- Test: `packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts`

- [ ] **Step 1: Write the failing consumer tests**

```ts
it('routes lark delivery only from explicit lark context_ref for shared-channel work', async () => {
  // no session_bridges fallback
});

it('routes telegram delivery only from explicit telegram context_ref for shared-channel work', async () => {
  // no session_bridges fallback
});

it('fails shared-channel delivery when context_ref is missing', async () => {
  // notifier does not guess from session_id or task_source
});

it('does not create fallback channels during notification to compensate for malformed events', async () => {
  // fallback materialization must happen upstream
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: FAIL because both consumers still contain bridge-era fallback logic.

- [ ] **Step 3: Write minimal implementation**

Update both notifiers so they:

- require explicit platform-matching `context_ref` for shared-channel delivery;
- allow direct same-platform delivery only for events that omit `session_id` and are fully addressed by `task_source`;
- use platform history only to load metadata and persist messages;
- never consult `session_bridges` or peer-platform inference for delivery;
- do not create fallback channels during notification to cover for missing shared-channel contract data.

- [ ] **Step 4: Run test to verify it passes**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-result/src/adapters/lark-notifier.ts packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts
git commit -m "refactor(notifiers): remove bridge inference from shared-channel routing"
```

## Task 7: Remove Bridge Repository Wiring and Persistence Surface

**Files:**
- Modify: `packages/daemon/lark-result/src/index.ts`
- Modify: `packages/daemon/telegram-outbound/src/index.ts`
- Modify: `packages/shared/src/db/schema.ts`
- Modify: `packages/shared/src/index.ts`
- Delete: `packages/shared/src/db/session-bridge-repository.ts`
- Delete: `packages/shared/src/__tests__/db/session-bridge-repository.test.ts`
- Modify: `packages/shared/src/db/lark-history-repository.ts`
- Modify: `packages/shared/src/db/telegram-history-repository.ts`
- Modify: `packages/shared/src/db/session-platform-link-repository.ts`

- [ ] **Step 1: Write the failing repository/bootstrap tests**

```ts
it('preserves root ownership on lark and telegram thread rows without session_bridges', async () => {
  // child output should not rewrite root ownership
});

it('treats platform links as attachments and preserves platform rows as the ownership source of truth', async () => {
  // multiple sessions may attach to one channel without making link lookup authoritative for ownership
});

it('does not construct SessionBridgeRepository from daemon composition roots', async () => {
  // runtime wiring is bridge-free
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/shared --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: FAIL because bridge-era repository assumptions and daemon wiring still exist.

- [ ] **Step 3: Write minimal implementation**

Remove `session_bridges` from the shared schema/export surface, delete the bridge repository, keep only attachment-oriented platform-link helpers, and update daemon entrypoints so they no longer import or construct `SessionBridgeRepository`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/shared --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-result/src/index.ts packages/daemon/telegram-outbound/src/index.ts packages/shared/src/db/schema.ts packages/shared/src/index.ts packages/shared/src/db/lark-history-repository.ts packages/shared/src/db/telegram-history-repository.ts packages/shared/src/db/session-platform-link-repository.ts
git rm packages/shared/src/db/session-bridge-repository.ts packages/shared/src/__tests__/db/session-bridge-repository.test.ts
git commit -m "refactor(shared): delete session bridge persistence and wiring"
```

## Task 8: Drop `session_bridges` in the Migrated Schema

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

## Task 9: Remove Bridge-Specific Cleanup and GC Logic

**Files:**
- Modify: `packages/daemon/task/src/services/gc-executor.ts`
- Modify: `packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
- Test: `packages/daemon/task/src/__tests__/gc-executor.test.ts`
- Test: `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
- Test: `packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts`

- [ ] **Step 1: Write the failing cleanup tests**

```ts
it('cleans a session subtree without querying session_bridges', async () => {
  // cleanup reply posts first, then deletes sessions, links, and platform rows only
});

it('gc succeeds against a schema with no session_bridges table', async () => {
  // no special-case bridge cleanup path remains
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
git add packages/daemon/task/src/services/gc-executor.ts packages/daemon/task/src/__tests__/gc-executor.test.ts packages/daemon/lark-result/src/adapters/lark-notifier.ts packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts
git commit -m "refactor(cleanup): remove bridge-specific teardown logic"
```

## Task 10: Run the Direct-Cutover Regression Sweep

**Files:**
- Modify as needed: `packages/api/src/__tests__/routes/tasks.test.ts`
- Modify as needed: `packages/api/src/__tests__/routes/results.test.ts`
- Modify as needed: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`
- Modify as needed: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Modify as needed: `packages/daemon/lark-result/src/__tests__/lark-poller.test.ts`
- Modify as needed: `packages/daemon/telegram-outbound/src/__tests__/telegram-poller.test.ts`
- Modify as needed: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Add any remaining regression tests discovered during integration**

```ts
it('never publishes or dispatches a shared-channel event without context_ref after the cutover', async () => {
  // integration guard across intake, producers, pollers, and consumers
});
```

- [ ] **Step 2: Run the cross-package regression suite**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/shared --to @local-agent/api --to @local-agent/migrator --to @local-agent/lark-listener-daemon --to @local-agent/telegram-inbound-daemon --to @local-agent/task-enrichment-daemon --to @local-agent/task-daemon --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: PASS

- [ ] **Step 3: Fix any remaining direct-cutover contract gaps**

Only patch cases where bridge-era assumptions or missing `context_ref` still survive.

- [ ] **Step 4: Re-run the cross-package regression suite**

Run: `node common/scripts/run-rush-project-tests.js --to @local-agent/shared --to @local-agent/api --to @local-agent/migrator --to @local-agent/lark-listener-daemon --to @local-agent/telegram-inbound-daemon --to @local-agent/task-enrichment-daemon --to @local-agent/task-daemon --to @local-agent/lark-result-daemon --to @local-agent/telegram-outbound-daemon`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/__tests__/routes/tasks.test.ts packages/api/src/__tests__/routes/results.test.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts packages/daemon/task/src/__tests__/task-poller.test.ts packages/daemon/lark-result/src/__tests__/lark-poller.test.ts packages/daemon/telegram-outbound/src/__tests__/telegram-poller.test.ts packages/shared/src/__tests__/types.test.ts
git commit -m "test: finalize fanout routing cutover without session bridges"
```

## Definition of Done

- No runtime code imports or constructs `SessionBridgeRepository`.
- Final migrated schema contains no `session_bridges` table.
- Shared-channel phase, result, and mirror events require explicit `context_ref`.
- Shared-channel task intake preserves the same routing contract that result publication expects.
- Lark and Telegram pollers no longer dispatch shared-channel or mirror events by bridge-era origin heuristics.
- Lark and Telegram consumers no longer infer destinations from bridge rows, links, or notifier-side fallback creation.
- Cleanup and GC succeed without bridge-table access.
- The regression suite in Task 10 passes.
