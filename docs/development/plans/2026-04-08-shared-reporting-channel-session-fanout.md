# Shared Reporting Channels with Root and Child Sessions Implementation Plan

**Goal:** Allow one Lark thread or Telegram topic to act as a shared reporting channel for a root session plus attached child sessions, while keeping human replies bound to the root session only.

**Architecture:** Preserve `session_id` as the execution/workspace/queue identity, add `parent_session_id` lineage in `sessions`, reinterpret per-platform thread/topic rows as root-owned reporting-channel state, and let `session_platform_links` attach many sessions to the same reporting channel. Result routing and cleanup resolve through reporting-channel state, while prompt-history construction filters to root-session messages only.

**Locked decisions:** Child sessions always materialize explicit platform-link attachments; `parent_session_id` is write-once and acyclic; parent/context mismatches are rejected; `/end` marks the root reporting channel as closing and blocks new child attachments; bridged roots give child sessions the same Lark and Telegram reporting surfaces; unattached child sessions are out of scope.

**Tech Stack:** TypeScript, Drizzle ORM, SQLite/libSQL, Express, RabbitMQ, Vitest, Commander

---

## File Map

**Schema and repositories**
- Modify: `LocalAgent/packages/shared/src/db/schema.ts`
- Modify: `LocalAgent/packages/shared/src/db/session-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/session-platform-link-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/session-bridge-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/lark-history-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/telegram-history-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/history-format.ts`
- Create: `LocalAgent/packages/migrator/src/migrations/0004_shared_reporting_channel_session_fanout.sql`
- Modify: `LocalAgent/packages/migrator/src/migrations/meta/_journal.json`
- Create: `LocalAgent/packages/migrator/src/migrations/0005_sync_schema_version.sql`
- Modify: `LocalAgent/packages/migrator/src/__tests__/migrate.test.ts`
- Modify: `LocalAgent/docs/LOCAL_DEVELOPMENT.md`

**Shared contracts and API**
- Modify: `LocalAgent/packages/shared/src/types.ts`
- Modify: `LocalAgent/packages/api/src/routes/tasks.ts`
- Modify: `LocalAgent/packages/api/src/routes/jobs.ts`
- Modify: `LocalAgent/packages/api/src/__tests__/routes/tasks.test.ts`
- Modify: `LocalAgent/packages/api/src/__tests__/routes/jobs.test.ts`

**Inbound resolution and enrichment**
- Modify: `LocalAgent/packages/daemon/lark-listener/src/adapters/lark-session-resolver.ts`
- Modify: `LocalAgent/packages/daemon/telegram-inbound/src/adapters/telegram-session-resolver.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/adapters/telegram-thread-context-fetcher.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/enrichment-poller.ts`

**Result routing and cleanup**
- Modify: `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
- Modify: `LocalAgent/packages/daemon/task/src/adapters/cleanup-executor.ts`
- Modify: `LocalAgent/packages/daemon/task/src/services/gc-executor.ts`
- Modify: `LocalAgent/packages/shared/src/index.ts`
- Create: `LocalAgent/packages/shared/src/cleanup.ts`

**CLI**
- Modify: `LocalAgent/packages/cli/src/commands/submit.ts`

**Tests**
- Modify: `LocalAgent/packages/shared/src/__tests__/db/session-repository.test.ts`
- Modify: `LocalAgent/packages/shared/src/__tests__/db/session-platform-link-repository.test.ts`
- Modify: `LocalAgent/packages/shared/src/__tests__/db/session-bridge-repository.test.ts`
- Modify: `LocalAgent/packages/shared/src/__tests__/db/lark-history-repository.test.ts`
- Modify: `LocalAgent/packages/shared/src/__tests__/db/telegram-history-repository.test.ts`
- Modify: `LocalAgent/packages/shared/src/__tests__/db/history-format.test.ts`
- Modify: `LocalAgent/packages/shared/src/__tests__/types.test.ts`
- Modify: `LocalAgent/packages/daemon/lark-listener/src/__tests__/lark-session-resolver.test.ts`
- Modify: `LocalAgent/packages/daemon/telegram-inbound/src/__tests__/telegram-session-resolver.test.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts`
- Modify: `LocalAgent/packages/cli/src/__tests__/submit.test.ts`
- Modify: `LocalAgent/packages/daemon/lark-listener/src/__tests__/config.test.ts`
- Modify: `LocalAgent/packages/daemon/lark-result/src/__tests__/config.test.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/config.test.ts`
- Modify: `LocalAgent/packages/daemon/telegram-inbound/src/__tests__/config.test.ts`
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/config.test.ts`
- Modify: `LocalAgent/packages/migrator/src/__tests__/migrate.test.ts`
- Create: `LocalAgent/packages/shared/src/__tests__/cleanup.test.ts`
- Modify: `LocalAgent/packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts`
- Modify: `LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts`

### Task 1: Migrate the schema from single-session ownership to root-owned reporting channels

**Files:**
- Modify: `LocalAgent/packages/shared/src/db/schema.ts`
- Create: `LocalAgent/packages/migrator/src/migrations/0004_shared_reporting_channel_session_fanout.sql`
- Modify: `LocalAgent/packages/migrator/src/migrations/meta/_journal.json`
- Create: `LocalAgent/packages/migrator/src/migrations/0005_sync_schema_version.sql`
- Modify: `LocalAgent/docs/LOCAL_DEVELOPMENT.md`
- Test: `LocalAgent/packages/shared/src/__tests__/db/session-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/session-platform-link-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/session-bridge-repository.test.ts`
- Test: `LocalAgent/packages/daemon/lark-listener/src/__tests__/config.test.ts`
- Test: `LocalAgent/packages/daemon/lark-result/src/__tests__/config.test.ts`
- Test: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/config.test.ts`
- Test: `LocalAgent/packages/daemon/telegram-inbound/src/__tests__/config.test.ts`
- Test: `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/config.test.ts`
- Test: `LocalAgent/packages/migrator/src/__tests__/migrate.test.ts`

- [ ] **Step 1: Write the failing schema and repository tests for lineage and multi-attachment**

Add tests that assert:

- `sessions` supports `parent_session_id` self-reference;
- `parent_session_id` is treated as immutable and parent rows must already exist;
- `session_platform_links` permits two different session ids to share the same `(platform, external_thread_key)`;
- `session_bridges` is keyed by root-session semantics rather than arbitrary child session identity.

- [ ] **Step 2: Run the focused shared DB tests to verify they fail**

Run:

```bash
cd LocalAgent/packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/db/session-repository.test.ts src/__tests__/db/session-platform-link-repository.test.ts src/__tests__/db/session-bridge-repository.test.ts
```

Expected: FAIL on missing `parent_session_id`, uniqueness assumptions, and root-session bridge expectations.

- [ ] **Step 3: Update Drizzle schema for root-owned reporting channels**

Implement these changes in `LocalAgent/packages/shared/src/db/schema.ts`:

- add `parentSessionId` to `sessionsTable` plus a self-FK and index;
- rename `sessionId` to `rootSessionId` in `larkThreadsTable` and `telegramThreadsTable`;
- rename `sessionId` to `rootSessionId` in `sessionBridgesTable`;
- drop the unique index on `(platform, externalThreadKey)` in `sessionPlatformLinksTable` and replace it with a non-unique lookup index.

- [ ] **Step 4: Write the SQLite migration with explicit backfill semantics**

In `LocalAgent/packages/migrator/src/migrations/0004_shared_reporting_channel_session_fanout.sql`, rebuild tables as needed to:

- add `parent_session_id` defaulting to `NULL`;
- copy existing `session_id` values into `root_session_id` on thread/topic and bridge rows;
- rebuild `session_platform_links` without the uniqueness constraint;
- preserve all existing message rows untouched.

- [ ] **Step 5: Register the migration in Drizzle's journal and bump schema version**

This repo uses Drizzle migrations with an explicit journal at `LocalAgent/packages/migrator/src/migrations/meta/_journal.json`. Update it to include the new `0004_shared_reporting_channel_session_fanout` tag and a follow-up `0005_sync_schema_version` tag.

Important baseline: the current journal already includes entries through `idx = 3` / `version = "9"`, while `0003_sync_schema_version.sql` still writes DB schema version `8`. Treat `8` as the current runtime schema version before this feature.

Create `LocalAgent/packages/migrator/src/migrations/0005_sync_schema_version.sql` that updates `__schema_version.version` to `10`, and append journal entries so the post-feature runtime schema version is unambiguously `10`.

- [ ] **Step 6: Update schema-version expectations in daemon config tests and docs**

Update tests that hardcode `LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION: '8'` to `'10'`:

- `LocalAgent/packages/daemon/lark-listener/src/__tests__/config.test.ts`
- `LocalAgent/packages/daemon/lark-result/src/__tests__/config.test.ts`
- `LocalAgent/packages/daemon/task-enrichment/src/__tests__/config.test.ts`
- `LocalAgent/packages/daemon/telegram-inbound/src/__tests__/config.test.ts`
- `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/config.test.ts`

Update `LocalAgent/docs/LOCAL_DEVELOPMENT.md` to recommend `LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION` of `10`.

- [ ] **Step 6a: Update migrator coverage for the new schema semantics**

In `LocalAgent/packages/migrator/src/__tests__/migrate.test.ts`, replace the old assertions with coverage that verifies:

- `lark_threads.root_session_id`, `telegram_threads.root_session_id`, and `session_bridges.root_session_id` are the persisted column names;
- `sessions.parent_session_id` exists and accepts `NULL` for roots plus existing-parent references for children;
- `session_platform_links` keeps `(session_id, platform)` unique while allowing two different sessions to share the same `(platform, external_thread_key)`;
- the migration test inserts two sessions attached to the same reporting channel and proves that only the per-session uniqueness constraint remains.

- [ ] **Step 7: Run the focused shared DB tests again**

Run:

```bash
cd LocalAgent/packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/db/session-repository.test.ts src/__tests__/db/session-platform-link-repository.test.ts src/__tests__/db/session-bridge-repository.test.ts

cd ../migrator
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/migrate.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the schema migration slice**

```bash
git add LocalAgent/packages/shared/src/db/schema.ts LocalAgent/packages/migrator/src/migrations/0004_shared_reporting_channel_session_fanout.sql LocalAgent/packages/migrator/src/migrations/0005_sync_schema_version.sql LocalAgent/packages/migrator/src/migrations/meta/_journal.json LocalAgent/packages/migrator/src/__tests__/migrate.test.ts LocalAgent/docs/LOCAL_DEVELOPMENT.md LocalAgent/packages/shared/src/__tests__/db/session-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/session-platform-link-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/session-bridge-repository.test.ts
git commit -m "feat: add reporting channel session fanout schema"
```

### Task 2: Extend repositories for lineage traversal and root/channel-aware persistence

**Files:**
- Modify: `LocalAgent/packages/shared/src/db/session-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/session-platform-link-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/session-bridge-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/lark-history-repository.ts`
- Modify: `LocalAgent/packages/shared/src/db/telegram-history-repository.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/session-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/session-platform-link-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/session-bridge-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/lark-history-repository.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/telegram-history-repository.test.ts`

- [ ] **Step 1: Write failing repository tests for subtree traversal and message ownership preservation**

Add coverage for:

- listing children/descendants from `parent_session_id`;
- rejecting reparent attempts or cyclic lineage at the repository/service boundary used by implementation;
- listing multiple links for one reporting channel;
- materializing explicit child-session platform links for the inherited reporting surfaces;
- bridge lookup by root session id;
- preserving per-message `session_id` when a thread/topic row is upserted.

- [ ] **Step 2: Run the repository tests to verify the new assertions fail**

Run:

```bash
cd LocalAgent/packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/db/session-repository.test.ts src/__tests__/db/session-platform-link-repository.test.ts src/__tests__/db/session-bridge-repository.test.ts src/__tests__/db/lark-history-repository.test.ts src/__tests__/db/telegram-history-repository.test.ts
```

Expected: FAIL on missing lineage APIs and topic/thread upsert behavior.

- [ ] **Step 3: Implement lineage-aware session repository methods**

In `LocalAgent/packages/shared/src/db/session-repository.ts`:

- add `parentSessionId` to `UpsertSessionParams` and `SessionRow`;
- implement helpers to list direct children and rooted descendants;
- enforce write-once parent semantics in the repository/service contract used by session creation paths;
- add delete helpers that accept many session ids.

- [ ] **Step 4: Implement multi-attachment session-platform-link APIs**

In `LocalAgent/packages/shared/src/db/session-platform-link-repository.ts`:

- add list-based lookup by `(platform, externalThreadKey)`;
- preserve existing session+platform singular lookups;
- add helpers used by child-session attachment materialization so every child gets explicit inherited platform links;
- add bulk delete helpers for session id collections.

- [ ] **Step 5: Reorient the bridge repository around root-session ownership**

In `LocalAgent/packages/shared/src/db/session-bridge-repository.ts`:

- rename types and methods from `sessionId` to `rootSessionId` semantics;
- keep lookup helpers by Lark root and Telegram topic;
- add compatibility only if needed to avoid broad churn in one step.

- [ ] **Step 6: Stop history repositories from rewriting message ownership**

In `LocalAgent/packages/shared/src/db/lark-history-repository.ts` and `LocalAgent/packages/shared/src/db/telegram-history-repository.ts`:

- ensure thread/topic upserts update only root-owned reporting-channel state;
- stop bulk-updating `*_messages.session_id` during thread/topic upserts;
- add helpers to fetch messages for one producing session within a reporting channel;
- add bulk delete helpers for multiple session ids when subtree cleanup lands.

Also fix the Lark audit-only path so that once a root session is resolved, inbound root and reply message rows are backfilled to `session_id = root_session_id` for root-session continuation to work deterministically.

- [ ] **Step 7: Run the repository tests again**

Run:

```bash
cd LocalAgent/packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/db/session-repository.test.ts src/__tests__/db/session-platform-link-repository.test.ts src/__tests__/db/session-bridge-repository.test.ts src/__tests__/db/lark-history-repository.test.ts src/__tests__/db/telegram-history-repository.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the repository slice**

```bash
git add LocalAgent/packages/shared/src/db/session-repository.ts LocalAgent/packages/shared/src/db/session-platform-link-repository.ts LocalAgent/packages/shared/src/db/session-bridge-repository.ts LocalAgent/packages/shared/src/db/lark-history-repository.ts LocalAgent/packages/shared/src/db/telegram-history-repository.ts LocalAgent/packages/shared/src/__tests__/db/session-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/session-platform-link-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/session-bridge-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/lark-history-repository.test.ts LocalAgent/packages/shared/src/__tests__/db/telegram-history-repository.test.ts
git commit -m "feat: add lineage-aware reporting channel repositories"
```

### Task 3: Update shared contracts and API validation for explicit target-session routing

**Files:**
- Modify: `LocalAgent/packages/shared/src/types.ts`
- Modify: `LocalAgent/packages/api/src/routes/tasks.ts`
- Modify: `LocalAgent/packages/api/src/routes/jobs.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/types.test.ts`
- Test: `LocalAgent/packages/api/src/__tests__/routes/tasks.test.ts`
- Test: `LocalAgent/packages/api/src/__tests__/routes/jobs.test.ts`

- [ ] **Step 1: Write failing type/validation tests for explicit session plus context submission**

Add tests covering:

- `TaskSubmission` and `Task` carrying both `session_id` and `context_ref` intentionally;
- mismatched parent lineage and `context_ref` being rejected;
- validation rejecting partial context fields where required;
- compatibility with existing simple submissions.

- [ ] **Step 2: Run the type tests to verify failure**

Run:

```bash
cd LocalAgent/packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/types.test.ts
```

Expected: FAIL on missing or mismatched validation behavior.

- [ ] **Step 3: Update shared types to make the routing contract explicit**

In `LocalAgent/packages/shared/src/types.ts`:

- document `session_id` as execution target session;
- document `context_ref` as reporting-channel anchor;
- add any narrow helper types needed for internal producers without widening user-facing ambiguity.

- [ ] **Step 4: Tighten task and job route validation**

In `LocalAgent/packages/api/src/routes/tasks.ts` and `LocalAgent/packages/api/src/routes/jobs.ts`:

- preserve existing optionality for backward compatibility;
- validate `context_ref` structure clearly;
- for `/tasks`, reject malformed or partial reporting-context inputs immediately;
- for `/jobs`, plumb `context_ref` through the `Job` contract so enriched/internal producers can preserve explicit reporting-channel routing;
- reject parent/context mismatches at the route or service boundary that has enough information to validate them, rather than silently correcting them;
- keep `session_id` pass-through when explicitly supplied;
- avoid introducing behavior that silently rewrites the target session.

- [ ] **Step 5: Run the type tests again**

Run:

```bash
cd LocalAgent/packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/types.test.ts

cd ../api
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/routes/tasks.test.ts src/__tests__/routes/jobs.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the contract slice**

```bash
git add LocalAgent/packages/shared/src/types.ts LocalAgent/packages/api/src/routes/tasks.ts LocalAgent/packages/api/src/routes/jobs.ts LocalAgent/packages/shared/src/__tests__/types.test.ts LocalAgent/packages/api/src/__tests__/routes/tasks.test.ts LocalAgent/packages/api/src/__tests__/routes/jobs.test.ts
git commit -m "feat: clarify target session and reporting context contract"
```

### Task 4: Keep inbound human routing root-only and rebuild root-only prompt history

**Files:**
- Modify: `LocalAgent/packages/daemon/lark-listener/src/adapters/lark-session-resolver.ts`
- Modify: `LocalAgent/packages/daemon/telegram-inbound/src/adapters/telegram-session-resolver.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/adapters/telegram-thread-context-fetcher.ts`
- Modify: `LocalAgent/packages/shared/src/db/history-format.ts`
- Test: `LocalAgent/packages/daemon/lark-listener/src/__tests__/lark-session-resolver.test.ts`
- Test: `LocalAgent/packages/daemon/telegram-inbound/src/__tests__/telegram-session-resolver.test.ts`
- Test: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/db/history-format.test.ts`

- [ ] **Step 1: Write failing resolver/context tests for root-only continuation**

Add cases where:

- a thread/topic has root and child session links;
- a human reply must still resolve to the root session;
- a bridged root causes child sessions to inherit both Lark and Telegram reporting surfaces when attached;
- child outbound rows are present in the visible reporting channel but excluded from prompt history.

- [ ] **Step 2: Run the focused resolver/context tests to verify they fail**

Run:

```bash
cd LocalAgent/packages/daemon/lark-listener
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-session-resolver.test.ts

cd ../telegram-inbound
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/telegram-session-resolver.test.ts

cd ../task-enrichment
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/thread-context-fetcher.test.ts
```

Expected: FAIL on child-session contamination or wrong session selection.

- [ ] **Step 3: Update inbound session resolvers to keep root ownership stable**

In the Lark and Telegram session resolvers:

- materialize the first session as the root session for the reporting channel;
- keep using the reporting-channel row's `root_session_id` for normal human replies;
- ensure child-session attachment paths materialize explicit inherited platform links instead of relying on implicit bridge-only routing;
- do not let later child attachments replace root ownership.

- [ ] **Step 4: Rebuild thread context fetchers around root-session filtering**

In both thread context fetchers:

- resolve `inheritedSessionId` from the reporting-channel root row;
- fetch reporting-channel messages and filter to rows belonging to the root session for assistant history;
- keep the `/new` fence behavior scoped to root-session messages only.

- [ ] **Step 5: Update history formatting helpers if the fetchers need role-safe filtering support**

In `LocalAgent/packages/shared/src/db/history-format.ts`, add minimal helper support only if required to keep the fetchers readable and deterministic.

- [ ] **Step 6: Run the focused resolver/context tests again**

Run:

```bash
cd LocalAgent/packages/daemon/lark-listener
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-session-resolver.test.ts

cd ../telegram-inbound
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/telegram-session-resolver.test.ts

cd ../task-enrichment
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/thread-context-fetcher.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the root-only continuation slice**

```bash
git add LocalAgent/packages/daemon/lark-listener/src/adapters/lark-session-resolver.ts LocalAgent/packages/daemon/telegram-inbound/src/adapters/telegram-session-resolver.ts LocalAgent/packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts LocalAgent/packages/daemon/task-enrichment/src/adapters/telegram-thread-context-fetcher.ts LocalAgent/packages/shared/src/db/history-format.ts LocalAgent/packages/daemon/lark-listener/src/__tests__/lark-session-resolver.test.ts LocalAgent/packages/daemon/telegram-inbound/src/__tests__/telegram-session-resolver.test.ts LocalAgent/packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts LocalAgent/packages/shared/src/__tests__/db/history-format.test.ts
git commit -m "feat: keep shared thread replies bound to root session"
```

### Task 5: Preserve explicit target-session behavior in enrichment and job submission

**Files:**
- Modify: `LocalAgent/packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Test: `LocalAgent/packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing enrichment tests for explicit target-session passthrough**

Add tests ensuring:

- tasks with explicit `session_id` plus `context_ref` do not get a new generated session id;
- tasks that would attach a new child under a closing root reporting channel are rejected;
- root-only human thread replies still inherit the reporting-channel root session;
- control-task behavior remains coherent under the new root-session model.

- [ ] **Step 2: Run the enrichment tests to verify failure**

Run:

```bash
cd LocalAgent/packages/daemon/task-enrichment
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/enrichment-poller.test.ts
```

Expected: FAIL on explicit-session passthrough assertions.

- [ ] **Step 3: Update enrichment poller routing rules**

In `LocalAgent/packages/daemon/task-enrichment/src/enrichment-poller.ts`:

- honor explicit `task.session_id` when it is intentionally supplied for internal child-session work;
- reject fresh child-session attachment when the resolved root reporting channel is already closing;
- keep root-only inherited-session behavior for human thread replies;
- avoid any fallback that would attach child work to the wrong reporting channel.

- [ ] **Step 4: Run the enrichment tests again**

Run:

```bash
cd LocalAgent/packages/daemon/task-enrichment
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/enrichment-poller.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the enrichment slice**

```bash
git add LocalAgent/packages/daemon/task-enrichment/src/enrichment-poller.ts LocalAgent/packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat: preserve explicit child session routing in enrichment"
```

### Task 6: Route child-session results into shared reporting channels without mutating root ownership

**Files:**
- Modify: `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
- Test: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
- Test: `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts`

- [ ] **Step 1: Write failing notifier tests for child-session fan-out**

Add coverage proving:

- child-session results find the shared reporting-channel destination;
- outbound message rows keep the child `session_id`;
- root reporting-channel rows do not get overwritten with child ownership;
- child sessions attached under a bridged root resolve both Lark and Telegram reporting surfaces consistently;
- destination lookup prefers explicit `context_ref` when present, then falls back to session-platform links, then bridge-derived resolution.

- [ ] **Step 2: Run the notifier tests to verify failure**

Run:

```bash
cd LocalAgent/packages/daemon/lark-result
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-notifier.test.ts

cd ../telegram-outbound
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/telegram-notifier.test.ts
```

Expected: FAIL on destination lookup or persistence semantics.

- [ ] **Step 3: Update Lark result routing**

In `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`:

- resolve the reporting-channel destination from `context_ref`, link rows, or root bridge in deterministic order;
- persist outbound rows with the producing session id;
- stop mutating thread ownership to the producing child session.

- [ ] **Step 4: Update Telegram result routing**

In `LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`:

- mirror the same destination precedence and child-session persistence rules;
- keep topic root ownership stable while allowing child outputs into the same topic.

- [ ] **Step 5: Run the notifier tests again**

Run:

```bash
cd LocalAgent/packages/daemon/lark-result
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-notifier.test.ts

cd ../telegram-outbound
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/telegram-notifier.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the result-routing slice**

```bash
git add LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts
git commit -m "feat: fan out child session results to shared reporting channels"
```

### Task 7: Make `/end` and GC clean up the full attached session subtree

**Files:**
- Modify: `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
- Modify: `LocalAgent/packages/daemon/task/src/adapters/cleanup-executor.ts`
- Modify: `LocalAgent/packages/daemon/task/src/services/gc-executor.ts`
- Modify: `LocalAgent/packages/shared/src/index.ts`
- Create: `LocalAgent/packages/shared/src/cleanup.ts`
- Test: `LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`
- Test: `LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts`
- Test: `LocalAgent/packages/shared/src/__tests__/cleanup.test.ts`
- Test: `LocalAgent/packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts`
- Test: `LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts`

- [ ] **Step 1: Write failing cleanup tests for root-plus-descendants deletion**

Add notifier assertions that `/end`:

- resolves the root reporting channel;
- marks the root reporting channel as closing before descendant enumeration;
- enumerates descendant session ids;
- deletes workspaces, links, message rows, bridge rows, and root reporting-channel rows only once;
- rejects racing child attachments after closing begins;
- avoids child-session helper paths deleting the root reporting-channel row prematurely.

- [ ] **Step 2: Run the cleanup-related notifier tests to verify failure**

Run:

```bash
cd LocalAgent/packages/daemon/lark-result
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-notifier.test.ts

cd ../telegram-outbound
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/telegram-notifier.test.ts
```

Expected: FAIL on subtree cleanup expectations.

- [ ] **Step 3: Introduce subtree-aware cleanup orchestration**

Update Lark and Telegram notifier cleanup paths so they:

- resolve the root session id;
- mark the root reporting channel as closing before subtree enumeration;
- enumerate all descendant session ids from the session repository;
- mark all sessions/links ended before deletion;
- delete per-session rows for every subtree member;
- delete the root reporting-channel row and root bridge row exactly once after terminal reply delivery.

Also update the cleanup job itself so it can remove multiple workspaces in one user-visible `/end` reply:

- change cleanup job payload to include the list of session ids in the subtree (JSON is fine);
- add shared parsing/validation helpers for the cleanup payload in `@local-agent/shared`, export them via `packages/shared/src/index.ts`, and cover them with focused unit tests;
- update `CleanupExecutor` to parse this payload and remove all listed session directories;
- keep backward compatibility so legacy cleanup payloads that omit subtree metadata still delete only `job.session_id`.

This preserves the single user-visible `/end` reply while still removing child session workspaces.

- [ ] **Step 4: Update local cleanup and GC helpers to respect subtree semantics**

In `cleanup-executor.ts` and `gc-executor.ts`:

- preserve per-session workspace deletion behavior;
- extend DB cleanup helpers so GC can remove stale root-owned reporting-channel state and descendant rows coherently;
- avoid assuming one reporting channel maps to one session.

Add or update tests that prove:

- cleanup payload parsing accepts the new subtree format and rejects malformed JSON;
- `CleanupExecutor` removes all listed workspaces and falls back to single-session deletion when subtree metadata is absent;
- `GcExecutor` cleanup helpers no longer assume `session_bridges` or reporting-channel rows are keyed by arbitrary child-session identity.

- [ ] **Step 5: Run the cleanup-related notifier tests again**

Run:

```bash
cd LocalAgent/packages/daemon/lark-result
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-notifier.test.ts

cd ../telegram-outbound
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/telegram-notifier.test.ts

cd ../task
node ../../../common/scripts/install-run-rushx.js test -- src/adapters/__tests__/cleanup-executor.test.ts src/services/__tests__/gc-executor.test.ts

cd ../../shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/cleanup.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the cleanup slice**

```bash
git add LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts LocalAgent/packages/daemon/task/src/adapters/cleanup-executor.ts LocalAgent/packages/daemon/task/src/services/gc-executor.ts LocalAgent/packages/shared/src/index.ts LocalAgent/packages/shared/src/cleanup.ts LocalAgent/packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts LocalAgent/packages/daemon/telegram-outbound/src/__tests__/telegram-notifier.test.ts LocalAgent/packages/shared/src/__tests__/cleanup.test.ts LocalAgent/packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts
git commit -m "feat: clean up full reporting channel session subtree"
```

### Task 8: Extend the CLI for explicit session plus reporting-context submission

**Files:**
- Modify: `LocalAgent/packages/cli/src/commands/submit.ts`
- Test: `LocalAgent/packages/cli/src/__tests__/submit.test.ts`

- [ ] **Step 1: Write failing CLI tests for explicit routing flags**

Add tests for:

- `--session-id` populating `session_id`;
- `--context-platform` plus `--context-root-key` populating `context_ref`;
- validation rejecting one context flag without the other;
- compatibility with the existing simple submission path.

- [ ] **Step 2: Run the CLI tests to verify failure**

Run:

```bash
cd LocalAgent/packages/cli
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/submit.test.ts
```

Expected: FAIL on missing request-body fields and validation behavior.

- [ ] **Step 3: Implement the CLI flags and request-body generation**

In `LocalAgent/packages/cli/src/commands/submit.ts`:

- add `sessionId?: string`, `contextPlatform?: 'lark' | 'telegram'`, and `contextRootKey?: string` options;
- validate that context fields are supplied together;
- serialize them into the `/tasks` request body only when present.

- [ ] **Step 4: Run the CLI tests again**

Run:

```bash
cd LocalAgent/packages/cli
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/submit.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the CLI slice**

```bash
git add LocalAgent/packages/cli/src/commands/submit.ts LocalAgent/packages/cli/src/__tests__/submit.test.ts
git commit -m "feat: support explicit reporting context in cli submit"
```

### Task 9: Run end-to-end verification across the touched packages

**Files:**
- Modify: none unless verification exposes defects

- [ ] **Step 1: Run the shared and daemon unit suites touched by this feature**

Run:

```bash
cd LocalAgent
node common/scripts/run-rush-project-tests.js
```

Expected: PASS.

- [ ] **Step 2: Run the package-level test entrypoints for regression safety**

Run from `LocalAgent/`:

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/run-rush-project-tests.js
```

Expected: PASS.

- [ ] **Step 3: Run the migration tests if present and verify schema version behavior**

Run:

```bash
cd LocalAgent/packages/migrator
node ../../common/scripts/install-run-rushx.js test
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff for accidental schema or cleanup regressions**

Run:

```bash
git status --short
git diff --stat
```

Expected: only the planned files above are modified unless follow-up fixes were required.

- [ ] **Step 5: Commit any final verification fixes**

```bash
git add -A
git commit -m "test: verify reporting channel session fanout"
```
