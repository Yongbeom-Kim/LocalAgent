# Session-ID-Only Result Routing for Lark and Telegram Implementation Plan

**Goal:** Re-architect outbound Lark and Telegram result delivery so routing depends only on `session_id`, removes bridge-based cross-platform state, and keeps inbound continuation anchored only by live platform thread/topic rows.

**Architecture:** Simplify routing to a per-platform model. `session_platform_links` becomes the only outbound destination mapping, each outbound daemon owns lazy create for its own platform, and RabbitMQ exchange fanout determines which daemons receive each event. `lark_threads` and `telegram_threads` remain live inbound anchors only while the conversation exists; after `/end`, those rows are deleted and any later inbound reply to the old thread/topic becomes a brand-new session.

**Tech Stack:** TypeScript, Node.js 20, Drizzle ORM, SQLite/libSQL, Express, RabbitMQ, Vitest, Rush monorepo

---

## File Map

| File | Responsibility |
|------|----------------|
| `LocalAgent/packages/shared/src/db/schema.ts` | Remove bridge/tombstone schema and define the simplified per-platform routing tables |
| `LocalAgent/packages/shared/src/db/session-platform-link-repository.ts` | Simplify link semantics to active-or-missing plus claim-based lazy create |
| `LocalAgent/packages/shared/src/db/session-bridge-repository.ts` | Delete bridge repository from the codebase |
| `LocalAgent/packages/shared/src/db/session-repository.ts` | Keep lineage, enforce live-session checks used by outbound daemons and cleanup ordering |
| `LocalAgent/packages/shared/src/db/lark-history-repository.ts` | Preserve live root-anchor semantics, stop recreating ended threads implicitly, support hard-delete cleanup |
| `LocalAgent/packages/shared/src/db/telegram-history-repository.ts` | Preserve live topic-anchor semantics, support hard-delete cleanup |
| `LocalAgent/packages/shared/src/db/history-format.ts` | Keep root-owned prompt-history filtering intact after routing simplification |
| `LocalAgent/packages/shared/src/types.ts` | Remove or deprecate obsolete result-routing hints from shared contracts |
| `LocalAgent/packages/shared/src/index.ts` | Remove `SessionBridgeRepository` exports and expose updated repository APIs |
| `LocalAgent/packages/api/src/routes/results.ts` | Make `session_id` required for result/phase events and remove routing dependence on `context_ref` |
| `LocalAgent/packages/api/src/routes/tasks.ts` | Keep `session_id` as canonical execution target and align comments/validation with the new routing contract |
| `LocalAgent/packages/api/src/routes/jobs.ts` | Remove stale references that imply `context_ref` is part of result routing |
| `LocalAgent/packages/cli/src/commands/submit.ts` | Stop promoting context-root options for the new result-routing model |
| `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Resolve and lazily create Lark destinations from `session_id` only; remove bridge/context-based routing |
| `LocalAgent/packages/daemon/lark-result/src/lark-poller.ts` | Keep result consumption aligned with the new `session_id`-required event contract |
| `LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts` | Resolve and lazily create Telegram destinations from `session_id` only; remove bridge/context-based routing |
| `LocalAgent/packages/daemon/telegram-outbound/src/telegram-poller.ts` | Keep Telegram result consumption aligned with the new contract |
| `LocalAgent/packages/daemon/lark-listener/src/adapters/lark-session-resolver.ts` | Resolve inbound continuation only from live `lark_threads` rows; unknown deleted thread becomes new session |
| `LocalAgent/packages/daemon/telegram-inbound/src/adapters/telegram-session-resolver.ts` | Resolve inbound continuation only from live `telegram_threads` rows; unknown deleted topic becomes new session |
| `LocalAgent/packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Refuse history-only continuation without a live Lark anchor row |
| `LocalAgent/packages/daemon/task-enrichment/src/adapters/telegram-thread-context-fetcher.ts` | Refuse history-only continuation without a live Telegram anchor row |
| `LocalAgent/packages/daemon/task/src/adapters/cleanup-executor.ts` | Keep filesystem cleanup scoped to session subtree |
| `LocalAgent/packages/daemon/task/src/services/gc-executor.ts` | Remove bridge cleanup and align DB cleanup ordering with the simplified schema |
| `LocalAgent/packages/migrator/src/migrations/0008_session_id_only_result_routing.sql` | Rebuild schema for the simplified routing model |
| `LocalAgent/packages/migrator/src/migrations/0009_sync_schema_version.sql` | Bump schema version after the new migration |
| `LocalAgent/packages/migrator/src/migrations/meta/_journal.json` | Register the new migration tags |
| `LocalAgent/docs/LOCAL_DEVELOPMENT.md` | Update schema-version expectations and routing contract notes |
| `LocalAgent/packages/shared/src/__tests__/db/*.test.ts` | Cover schema/repository changes and bridge removal |
| `LocalAgent/packages/api/src/__tests__/routes/results.test.ts` | Cover `session_id`-required result/phase routing contract |
| `LocalAgent/packages/api/src/__tests__/routes/tasks.test.ts` | Cover updated routing-related validation and comments |
| `LocalAgent/packages/api/src/__tests__/routes/jobs.test.ts` | Cover removal/deprecation of stale routing assumptions |
| `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts` | Cover `session_id`-only Lark routing and lazy create/drop behavior |
| `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts` | Cover `session_id`-only Telegram routing and lazy create/drop behavior |
| `LocalAgent/packages/daemon/lark-listener/src/__tests__/lark-session-resolver.test.ts` | Cover live-anchor-only continuation and deleted-thread new-session behavior |
| `LocalAgent/packages/daemon/telegram-inbound/src/__tests__/telegram-session-resolver.test.ts` | Cover live-anchor-only continuation and deleted-topic new-session behavior |
| `LocalAgent/packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts` | Cover Lark context fetch refusal without live anchor |
| `LocalAgent/packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Update enrichment expectations if resolver behavior changes surface here |
| `LocalAgent/packages/daemon/telegram-inbound/src/__tests__/telegram-session-resolver.test.ts` | Cover Telegram new-session-after-delete behavior |
| `LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts` | Cover bridge removal and new cleanup ordering |
| `LocalAgent/packages/shared/src/__tests__/cleanup.test.ts` | Keep subtree cleanup payload semantics intact |

## Task 1: Rebuild the SQLite schema around per-platform session routing

**Files:**
- Modify: `LocalAgent/packages/shared/src/db/schema.ts`
- Create: `LocalAgent/packages/migrator/src/migrations/0008_session_id_only_result_routing.sql`
- Create: `LocalAgent/packages/migrator/src/migrations/0009_sync_schema_version.sql`
- Modify: `LocalAgent/packages/migrator/src/migrations/meta/_journal.json`
- Modify: `LocalAgent/docs/LOCAL_DEVELOPMENT.md`
- Test: `LocalAgent/packages/migrator/src/__tests__/migrate.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/session-platform-link-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/session-bridge-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/session-repository.test.ts`

- [ ] **Step 1: Write failing migration and repository tests for the target schema**

Add assertions that the post-migration schema:

- has no `session_bridges` table;
- removes `link_status` and `ended_at_ms` from `session_platform_links`;
- removes `ended_at_ms` from `sessions`, `lark_threads`, and `telegram_threads`;
- preserves `root_session_id` on `lark_threads` and `telegram_threads`;
- keeps `(session_id, platform)` as the only uniqueness rule for `session_platform_links`;
- keeps a non-unique lookup index on `(platform, external_thread_key)`.

- [ ] **Step 2: Run the focused DB and migrator tests to verify they fail**

Run:

```bash
cd LocalAgent/packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/db/session-platform-link-repository.test.ts src/__tests__/db/session-bridge-repository.test.ts src/__tests__/db/session-repository.test.ts

cd ../migrator
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/migrate.test.ts
```

Expected: FAIL on obsolete bridge schema and on old lifecycle columns still existing.

- [ ] **Step 3: Update Drizzle schema to the simplified routing model**

In `LocalAgent/packages/shared/src/db/schema.ts`:

- remove `sessionBridgesTable` entirely;
- remove `endedAtMs` from `sessionsTable`, `sessionPlatformLinksTable`, `larkThreadsTable`, and `telegramThreadsTable`;
- remove `linkStatus` from `sessionPlatformLinksTable`;
- keep `claimToken` and `claimExpiresAtMs` on `sessionPlatformLinksTable`;
- keep `rootSessionId` on `larkThreadsTable` and `telegramThreadsTable`;
- keep all existing message-table producer `sessionId` fields and foreign keys.

- [ ] **Step 4: Write the SQLite migration using table rebuilds where required**

In `LocalAgent/packages/migrator/src/migrations/0008_session_id_only_result_routing.sql`:

- drop `session_bridges`;
- rebuild `session_platform_links` via a `__new_session_platform_links` table copy so SQLite can remove `link_status` and `ended_at_ms`;
- explicitly drop the old unique index on `(platform, external_thread_key)` before creating the simplified non-unique lookup index;
- rebuild `sessions`, `lark_threads`, and `telegram_threads` explicitly so SQLite can remove `ended_at_ms` safely;
- preserve existing rows and translate active links into the simplified no-status form.

- [ ] **Step 5: Register the migration and bump schema version**

Update:

- `LocalAgent/packages/migrator/src/migrations/meta/_journal.json`
- `LocalAgent/packages/migrator/src/migrations/0009_sync_schema_version.sql`

Expected: the runtime schema version is incremented consistently and daemon config/docs can be updated to match.

- [ ] **Step 6: Update local-development docs and schema-version expectations**

In `LocalAgent/docs/LOCAL_DEVELOPMENT.md` and any config tests that assert a schema version:

- update the expected version number;
- note that `session_bridges` no longer exists and result routing is now `session_id`-only.

- [ ] **Step 7: Run the focused DB and migrator tests again**

Run the same commands from Step 2.

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add LocalAgent/packages/shared/src/db/schema.ts LocalAgent/packages/migrator/src/migrations/0008_session_id_only_result_routing.sql LocalAgent/packages/migrator/src/migrations/0009_sync_schema_version.sql LocalAgent/packages/migrator/src/migrations/meta/_journal.json LocalAgent/packages/migrator/src/__tests__/migrate.test.ts LocalAgent/docs/LOCAL_DEVELOPMENT.md LocalAgent/packages/shared/src/__tests__/db/session-platform-link-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/session-bridge-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/session-repository.test.ts
git commit -m "feat: simplify result routing schema"
```

## Task 2: Simplify shared repositories and remove bridge infrastructure

**Files:**
- Modify: `LocalAgent/packages/shared/src/db/session-platform-link-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/session-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/lark-history-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/telegram-history-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/history-format.ts`
- Modify: `LocalAgent/packages/shared/src/index.ts`
- Delete: `LocalAgent/packages/shared/src/db/session-bridge-repository.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/session-platform-link-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/lark-history-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/telegram-history-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/history-format.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/session-bridge-repository.test.ts`

- [ ] **Step 1: Write failing repository tests for active-or-missing link semantics**

Add assertions that:

- `session_platform_links` no longer exposes `link_status`/`ended_at_ms` behavior;
- claim rows are represented only by `external_thread_key = NULL` plus claim fields;
- deleting a link fully removes it;
- bridge repository symbols are gone from shared exports.

- [ ] **Step 2: Run focused repository tests to verify failure**

Run:

```bash
cd LocalAgent/packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/db/session-platform-link-repository.test.ts src/__tests__/db/lark-history-repository.test.ts src/__tests__/db/telegram-history-repository.test.ts src/__tests__/db/history-format.test.ts src/__tests__/db/session-bridge-repository.test.ts
```

Expected: FAIL on stale bridge imports and old ended-state assumptions.

- [ ] **Step 3: Refactor `SessionPlatformLinkRepository` to active-or-missing semantics**

In `LocalAgent/packages/shared/src/db/session-platform-link-repository.ts`:

- remove `SessionPlatformLinkStatus`;
- remove ended-state methods such as `markLinksEnded`;
- keep `claimPendingLink`, `activateClaimedLink`, and `releaseExpiredOrFailedClaim` using `externalThreadKey = NULL` as the pending marker;
- keep lookup by `(session_id, platform)` and `(platform, external_thread_key)`;
- keep bulk delete helpers.

- [ ] **Step 4: Remove bridge repository and exports**

Delete `LocalAgent/packages/shared/src/db/session-bridge-repository.ts` and remove all related exports and type references from `LocalAgent/packages/shared/src/index.ts`.

- [ ] **Step 5: Keep history repositories root-anchor-focused**

In `LocalAgent/packages/shared/src/db/lark-history-repository.ts` and `LocalAgent/packages/shared/src/db/telegram-history-repository.ts`:

- preserve producing `sessionId` on message rows;
- keep `rootSessionId` on live thread/topic rows;
- keep hard-delete helpers for thread/topic rows and messages;
- stop any behavior that implicitly assumes an ended tombstone row remains available.

- [ ] **Step 6: Verify prompt-history formatting still strips outbound metadata correctly**

Expected: no behavior change in `history-format.ts` beyond ensuring root-owned filtering still matches the live anchor semantics.

- [ ] **Step 7: Run repository tests again**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add LocalAgent/packages/shared/src/db/session-platform-link-repository.ts LocalAgent/packages/shared/src/db/session-repository.ts LocalAgent/packages/shared/src/db/lark-history-repository.ts LocalAgent/packages/shared/src/db/telegram-history-repository.ts LocalAgent/packages/shared/src/db/history-format.ts LocalAgent/packages/shared/src/index.ts LocalAgent/packages/shared/src/__tests__/db/session-platform-link-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/lark-history-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/telegram-history-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/history-format.test.ts
git rm LocalAgent/packages/shared/src/db/session-bridge-repository.ts LocalAgent/packages/shared/src/__tests__/db/session-bridge-repository.test.ts
git commit -m "refactor: remove bridge-based routing state"
```

## Task 3: Make `/results` and shared contracts require `session_id` for delivery routing

**Files:**
- Modify: `LocalAgent/packages/shared/src/types.ts`
- Modify: `LocalAgent/packages/api/src/routes/results.ts`
- Modify: `LocalAgent/packages/api/src/routes/tasks.ts`
- Modify: `LocalAgent/packages/api/src/routes/jobs.ts`
- Modify: `LocalAgent/packages/cli/src/commands/submit.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/types.test.ts`
- Test: `LocalAgent/packages/api/src/__tests__/routes/results.test.ts`
- Test: `LocalAgent/packages/api/src/__tests__/routes/tasks.test.ts`
- Test: `LocalAgent/packages/api/src/__tests__/routes/jobs.test.ts`
- Test: `LocalAgent/packages/cli/src/__tests__/submit.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add assertions that:

- `event_kind = phase` requires `session_id`;
- `event_kind = result` requires `session_id`;
- `context_ref` is no longer used for result routing;
- `event_kind = mirror` is removed end-to-end or converted into a documented no-op with explicit tests;
- CLI submit no longer promotes `context-platform`/`context-root-key` for this flow;
- shared types/tests reflect `session_id` as the routing identity.

- [ ] **Step 2: Run the focused API and shared-contract tests to verify they fail**

Run:

```bash
cd LocalAgent/packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/types.test.ts

cd ../api
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/routes/results.test.ts src/__tests__/routes/tasks.test.ts src/__tests__/routes/jobs.test.ts

cd ../cli
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/submit.test.ts
```

Expected: FAIL on old optional `session_id` behavior and stale routing hints.

- [ ] **Step 3: Tighten shared types and route validation**

In `LocalAgent/packages/shared/src/types.ts` and `LocalAgent/packages/api/src/routes/results.ts`:

- make `session_id` required for result/phase routing events;
- remove `context_ref` from the normal result-routing contract or clearly deprecate it as non-routing metadata if retention is unavoidable elsewhere;
- keep `task_source` only for audit or same-platform suppression logic, not destination routing;
- remove `mirror` from shared/API routing if it no longer has a supported architecture path, or explicitly redefine it as a no-op and test that no daemon attempts bridge-style delivery.

- [ ] **Step 4: Align tasks/jobs/CLI language with the new routing model**

In `LocalAgent/packages/api/src/routes/tasks.ts`, `LocalAgent/packages/api/src/routes/jobs.ts`, and `LocalAgent/packages/cli/src/commands/submit.ts`:

- keep `session_id` as the canonical execution target;
- remove or de-emphasize context-root CLI options and route comments that imply result routing depends on them;
- ensure help text matches the new architecture.

- [ ] **Step 5: Run focused contract tests again**

Run the commands from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add LocalAgent/packages/shared/src/types.ts LocalAgent/packages/api/src/routes/results.ts LocalAgent/packages/api/src/routes/tasks.ts LocalAgent/packages/api/src/routes/jobs.ts LocalAgent/packages/cli/src/commands/submit.ts LocalAgent/packages/shared/src/__tests__/types.test.ts LocalAgent/packages/api/src/__tests__/routes/results.test.ts LocalAgent/packages/api/src/__tests__/routes/tasks.test.ts LocalAgent/packages/api/src/__tests__/routes/jobs.test.ts LocalAgent/packages/cli/src/__tests__/submit.test.ts
git commit -m "feat: require session id for result routing"
```

## Task 4: Rewrite Lark outbound routing around `session_id` only

**Files:**
- Modify: `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/lark-poller.ts`
- Test: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
- Test: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-poller.test.ts`

- [ ] **Step 1: Write failing notifier tests for the new routing state machine**

Add tests covering:

- a result with live `session_id` and existing Lark link sends successfully without `context_ref`;
- a result with missing link but active session and `fallback_seed_text` lazily creates and persists a Lark root message;
- a result with missing link and missing/ended session does not create a destination;
- cleanup marks the session ended before deleting rows so a late event cannot recreate the destination;
- no bridge lookup or bridge-based mirror routing is used.

- [ ] **Step 2: Run focused Lark result tests to verify failure**

Run:

```bash
cd LocalAgent/packages/daemon/lark-result
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-notifier.test.ts src/__tests__/lark-poller.test.ts
```

Expected: FAIL on bridge/context-based routing assumptions.

- [ ] **Step 3: Remove bridge and `context_ref` routing branches from `lark-notifier.ts`**

Refactor `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts` so that delivery routing:

- requires `session_id`;
- resolves only via `session_platform_links`;
- checks `sessions.status === 'active'` before any lazy create;
- lazy-creates only when fallback metadata is present;
- drops/returns cleanly when no destination can be safely materialized;
- removes bridge-based mirror logic.

- [ ] **Step 4: Keep poller behavior aligned with the new contract**

In `LocalAgent/packages/daemon/lark-result/src/lark-poller.ts`:

- ensure phase/result event handling assumes `session_id` is present for routable events;
- remove stale assumptions that `context_ref` determines delivery destination.

- [ ] **Step 5: Run focused Lark result tests again**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts LocalAgent/packages/daemon/lark-result/src/lark-poller.ts LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts LocalAgent/packages/daemon/lark-result/src/__tests__/lark-poller.test.ts
git commit -m "feat(lark): route results by session id only"
```

## Task 5: Rewrite Telegram outbound routing around `session_id` only

**Files:**
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/telegram-poller.ts`
- Test: `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts`
- Test: `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-poller.test.ts`

- [ ] **Step 1: Write failing Telegram notifier tests for `session_id`-only routing**

Add tests covering:

- sending through an existing Telegram link without `context_ref`;
- lazy topic creation when link is missing and fallback metadata exists;
- refusing topic creation for missing/ended/under-specified sessions;
- no bridge-based routing remains;
- child output does not mutate `telegram_threads.root_session_id`.

- [ ] **Step 2: Run focused Telegram outbound tests to verify failure**

Run:

```bash
cd LocalAgent/packages/daemon/telegram-outbound
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/telegram-notifier.test.ts src/__tests__/telegram-poller.test.ts
```

Expected: FAIL on current bridge/context behavior.

- [ ] **Step 3: Refactor `telegram-notifier.ts` to the new routing model**

Implement:

- `session_id`-only routing;
- live-session check before lazy create;
- lazy topic creation only when fallback metadata exists;
- no bridge lookup;
- no use of `context_ref` for destination routing.

- [ ] **Step 4: Align `telegram-poller.ts` with the new contract**

Expected: result and phase handling assume `session_id`-driven destination resolution and do not fall back to obsolete routing hints.

- [ ] **Step 5: Run focused Telegram outbound tests again**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts LocalAgent/packages/daemon/telegram-outbound/src/telegram-poller.ts LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-poller.test.ts
git commit -m "feat(telegram): route results by session id only"
```

## Task 6: Re-anchor inbound continuation to live thread/topic rows only

**Files:**
- Modify: `LocalAgent/packages/daemon/lark-listener/src/adapters/lark-session-resolver.ts`
- Modify: `LocalAgent/packages/daemon/telegram-inbound/src/adapters/telegram-session-resolver.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/adapters/telegram-thread-context-fetcher.ts`
- Test: `LocalAgent/packages/daemon/lark-listener/src/__tests__/lark-session-resolver.test.ts`
- Test: `LocalAgent/packages/daemon/telegram-inbound/src/__tests__/telegram-session-resolver.test.ts`
- Test: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`
- Test: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing inbound-resolution tests**

Add tests covering:

- live thread/topic rows still continue the root session;
- Lark `audit_only` rows are ignored as continuation anchors when deciding whether a deleted thread should start a fresh session;
- once the live anchor row is deleted, a later inbound reply becomes a brand-new session;
- platform-link rows are no longer used as inbound fallback after deletion;
- context fetchers refuse history-only continuation without a live anchor row.

- [ ] **Step 2: Run focused inbound/enrichment tests to verify failure**

Run:

```bash
cd LocalAgent/packages/daemon/lark-listener
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-session-resolver.test.ts

cd ../telegram-inbound
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/telegram-session-resolver.test.ts

cd ../task-enrichment
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/thread-context-fetcher.test.ts src/__tests__/enrichment-poller.test.ts
```

Expected: FAIL on old link-fallback and deleted-thread behavior.

- [ ] **Step 3: Refactor inbound resolvers to live-anchor-first behavior**

In both resolver files:

- resolve continuation from `lark_threads` / `telegram_threads` first;
- for Lark, ignore `audit_only` rows as continuation anchors so a deleted-thread reply can actually reach the new-session path;
- stop using platform-link lookup as a deleted-thread fallback;
- when no live anchor row exists, generate a new root session according to the platform’s normal new-session path.

- [ ] **Step 4: Update thread-context fetchers to require live anchor rows**

Expected: prompt-history reconstruction remains root-owned while live, but does not silently continue from orphaned message history.

- [ ] **Step 5: Run focused inbound/enrichment tests again**

Run the commands from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add LocalAgent/packages/daemon/lark-listener/src/adapters/lark-session-resolver.ts LocalAgent/packages/daemon/telegram-inbound/src/adapters/telegram-session-resolver.ts LocalAgent/packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts LocalAgent/packages/daemon/task-enrichment/src/adapters/telegram-thread-context-fetcher.ts LocalAgent/packages/daemon/lark-listener/src/__tests__/lark-session-resolver.test.ts LocalAgent/packages/daemon/telegram-inbound/src/__tests__/telegram-session-resolver.test.ts LocalAgent/packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts LocalAgent/packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat: use live thread anchors for inbound continuation"
```

## Task 7: Fix cleanup and GC ordering so late events cannot recreate destinations

**Files:**
- Modify: `LocalAgent/packages/daemon/task/src/adapters/cleanup-executor.ts`
- Modify: `LocalAgent/packages/daemon/task/src/services/gc-executor.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
- Test: `LocalAgent/packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts`
- Test: `LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts`
- Test: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
- Test: `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts`

- [ ] **Step 1: Write failing cleanup-race tests**

Add assertions that:

- cleanup marks subtree sessions ended before deleting platform links;
- GC no longer references `session_bridges`;
- a late result arriving after cleanup does not recreate a Lark or Telegram destination for that ended session.

- [ ] **Step 2: Run focused cleanup/gc/outbound tests to verify failure**

Run:

```bash
cd LocalAgent/packages/daemon/task
node ../../../common/scripts/install-run-rushx.js test -- src/adapters/__tests__/cleanup-executor.test.ts src/services/__tests__/gc-executor.test.ts

cd ../lark-result
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-notifier.test.ts

cd ../telegram-outbound
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/telegram-notifier.test.ts
```

Expected: FAIL on old ordering and bridge cleanup assumptions.

- [ ] **Step 3: Implement the explicit cleanup ordering**

Update cleanup and GC paths so they:

- enumerate the full subtree;
- mark `sessions.status = 'ended'` for the subtree before deleting routing rows;
- delete platform links, messages, and live anchor rows;
- delete session rows last;
- remove all `session_bridges` references.

- [ ] **Step 4: Re-run focused cleanup/gc/outbound tests**

Run the commands from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add LocalAgent/packages/daemon/task/src/adapters/cleanup-executor.ts LocalAgent/packages/daemon/task/src/services/gc-executor.ts LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts LocalAgent/packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts
git commit -m "fix: harden cleanup against routing recreation"
```

## Task 8: Run the end-to-end targeted verification set and clean up docs/comments

**Files:**
- Modify: `LocalAgent/docs/development/design/2026-04-09-session-id-only-result-routing-design.md`
- Modify: `LocalAgent/docs/development/plans/2026-04-09-session-id-only-result-routing-plan.md`
- Test: all touched targeted tests from Tasks 1-7

- [ ] **Step 1: Re-read the design doc and ensure implementation matches the hard-delete/new-session tradeoff note**

Expected: docs and code agree that a reply after `/end` starts a brand-new session.

- [ ] **Step 2: Run the targeted verification suite**

Run:

```bash
cd LocalAgent/packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/db/session-platform-link-repository.test.ts src/__tests__/db/lark-history-repository.test.ts src/__tests__/db/telegram-history-repository.test.ts src/__tests__/types.test.ts

cd ../migrator
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/migrate.test.ts

cd ../api
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/routes/results.test.ts src/__tests__/routes/tasks.test.ts src/__tests__/routes/jobs.test.ts

cd ../cli
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/submit.test.ts

cd ../daemon/lark-result
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-notifier.test.ts src/__tests__/lark-poller.test.ts

cd ../telegram-outbound
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/telegram-notifier.test.ts src/__tests__/telegram-poller.test.ts

cd ../lark-listener
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-session-resolver.test.ts

cd ../telegram-inbound
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/telegram-session-resolver.test.ts

cd ../task-enrichment
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/thread-context-fetcher.test.ts src/__tests__/enrichment-poller.test.ts

cd ../task
node ../../../common/scripts/install-run-rushx.js test -- src/adapters/__tests__/cleanup-executor.test.ts src/services/__tests__/gc-executor.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit final documentation/test alignment**

```bash
git add LocalAgent/docs/development/design/2026-04-09-session-id-only-result-routing-design.md LocalAgent/docs/development/plans/2026-04-09-session-id-only-result-routing-plan.md
git commit -m "docs: finalize session-id-only result routing plan"
```
