# Telegram and Lark Feature Parity Implementation Plan

**Goal:** Build full Telegram and Lark parity by bridging one Lark thread and one Telegram forum topic to the same `session_id`, with bidirectional mirroring, Telegram inbound task handling, and Telegram persistence.

**Architecture:** Extend the current Lark-first session model by adding Telegram-specific persistence tables plus a narrow `session_bridges` mapping keyed by `session_id`. Telegram becomes a first-class inbound and outbound channel through widened shared contracts, a Telegram topic-aware listener/bridge flow, and result-daemon mirror consumption while reusing the existing task, enrichment, and result-event pipeline.

**Tech Stack:** TypeScript, Express, amqplib, Telegram Bot HTTP API, Lark Open API, Vitest, Drizzle/SQLite, existing LocalAgent daemon packages.

---

## Cross-Channel Mirroring Policy (V1)

Treat the existing task-event/results exchange as the cross-channel delivery bus.

- Cross-channel copies are carried by a new `mirror` task-event kind.
- `mirror` is only for accepted user-originated messages.
- `phase` and `result` remain the only bot-originated delivery path.
- Source-side enrichment emits `mirror` only after the inbound user message has been accepted, persisted, and bridged.
- Destination-side result daemons consume `mirror` events, dedup by persisted origin metadata plus stable `mirror_id`, deliver to their own platform, and persist the mirrored outbound message.
- No listener, enrichment path, or notifier should call the peer platform directly for mirrored delivery.

Ownership rules:

- `task-enrichment` emits `mirror` events for accepted inbound user messages after session materialization and bridge bootstrap succeed.
- `lark-result` consumes `mirror` events whose `task_source.source !== 'lark'` and also handles normal Lark bot-visible `phase`/`result` fanout.
- `telegram-result` consumes `mirror` events whose `task_source.source !== 'telegram'` and also handles normal Telegram bot-visible `phase`/`result` fanout.

This keeps user-message mirroring downstream of the canonical accept path, keeps bot delivery on the existing fanout path, and centralizes retry-safe dedup in `lark-result` and `telegram-result`.

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/shared/src/types.ts` | Widen `TaskSource`; add `mirror` task-event kind/contracts and Telegram inbound envelope/types |
| `packages/shared/src/index.ts` | Export new Telegram shared contracts and repositories |
| `packages/shared/src/db/schema.ts` | Add `telegram_threads`, `telegram_messages`, and `session_bridges` tables with composite Telegram keys |
| `packages/shared/src/db/telegram-history-repository.ts` | Persist and query Telegram thread/message state |
| `packages/shared/src/db/session-bridge-repository.ts` | Persist and query session-to-Lark/Telegram bridge mappings |
| `packages/shared/src/db/history-format.ts` or new Telegram formatter file | Format Telegram topic history into prompt context |
| `packages/shared/src/telegram-content.ts` | Normalize Telegram inbound content for command parsing |
| `packages/shared/src/telegram-inbound-routing.ts` | Classify Telegram root/topic commands using Lark-matching semantics |
| `packages/shared/src/__tests__/types.test.ts` | Shared contract coverage for Telegram task sources |
| `packages/shared/src/__tests__/db/*.test.ts` | Repository coverage for new tables |
| `packages/migrator/src/migrations/*telegram*sql` | Schema migration for Telegram tables and bridge table |
| `packages/migrator/src/migrations/meta/_journal.json` | Register new migration |
| `packages/migrator/src/__tests__/migrate.test.ts` | Migration coverage for new tables |
| `packages/api/src/routes/tasks.ts` | Accept Telegram task sources |
| `packages/api/src/routes/jobs.ts` | Accept Telegram task sources |
| `packages/api/src/routes/results.ts` | Accept Telegram task sources, `mirror` events, and Telegram phase emitters |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Validate Telegram task source acceptance |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Validate Telegram task source acceptance on jobs |
| `packages/api/src/__tests__/routes/results.test.ts` | Validate Telegram task source acceptance |
| `packages/daemon/telegram-result/src/config.ts` | Replace chat-id config with hardcoded forum group config |
| `packages/daemon/telegram-result/src/index.ts` | Start outbound poller plus inbound Telegram update loop and startup validation |
| `packages/daemon/telegram-result/src/telegram-poller.ts` | Route phase/result fanout and non-Telegram-source mirror events into Telegram topics via bridge state |
| `packages/daemon/telegram-result/src/telegram-update-poller.ts` | Poll Telegram `getUpdates`, filter inbound messages, and dispatch accepted updates |
| `packages/daemon/telegram-result/src/telegram-bridge-service.ts` | Coordinate topic creation, bridge bootstrap, and synthetic failures |
| `packages/daemon/telegram-result/src/adapters/telegram-notifier.ts` | Topic-aware send/reply/edit/create-topic Telegram API calls |
| `packages/daemon/telegram-result/src/adapters/telegram-task-submitter.ts` | Submit Telegram inbound tasks to `/tasks` |
| `packages/daemon/telegram-result/src/adapters/telegram-phase-publisher.ts` | Publish `received` phase for Telegram inbound tasks |
| `packages/daemon/telegram-result/src/adapters/telegram-topic-manager.ts` | Validate configured forum group and create topics |
| `packages/daemon/telegram-result/src/__tests__/*.test.ts` | Telegram daemon flow coverage |
| `packages/daemon/lark-listener/src/message-handler.ts` | Tighten loop prevention for mirrored Telegram-originated Lark messages |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Verify mirrored Lark messages are not resubmitted |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Dispatch Lark vs Telegram inbound classification, materialize bridges, and emit mirror events for accepted user messages |
| `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Keep Lark thread context fetcher unchanged except interface alignment if needed |
| `packages/daemon/task-enrichment/src/adapters/telegram-thread-context-fetcher.ts` | Read Telegram topic context/history from SQLite |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Telegram root/topic flow coverage |
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Keep canonical Lark send/reply behavior for bridged sessions |
| `packages/daemon/lark-result/src/lark-poller.ts` | Consume non-Lark-source mirror events and keep bridged-session result delivery/cleanup behavior intact |
| `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts` | Verify canonical Lark send behavior for bridged sessions |
| `packages/daemon/lark-result/src/__tests__/lark-poller.test.ts` | Verify non-Lark-source mirror consumption and dedup |
| `packages/daemon/task/src/adapters/cleanup-executor.ts` | Delete Telegram rows and bridge rows during cleanup |
| `packages/daemon/task/src/services/gc-executor.ts` | GC ended Telegram sessions and bridges |
| `packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts` | Verify cross-channel cleanup |
| `docker-compose.yml` | Update Telegram env/config |
| `docs/LOCAL_DEVELOPMENT.md` and/or env docs | Document `TELEGRAM_FORUM_GROUP_ID` and parity mode |

### Task 1: Widen shared task-source contracts for Telegram

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing shared contract tests**

Add tests in `packages/shared/src/__tests__/types.test.ts` for:

```ts
it('accepts a telegram task source with chat and topic ids', () => {
  expect(isValidTaskSource({
    source: 'telegram',
    chat_id: '-100123',
    topic_id: '42',
    message_id: '99',
  })).toBe(true);
});

it('rejects a telegram topic task source missing topic_id', () => {
  // This is a stricter validator than isValidTaskSource. Implement alongside Telegram inbound parsing.
  expect(isValidTelegramTopicTaskSource({
    source: 'telegram',
    chat_id: '-100123',
    message_id: '99',
  })).toBe(false);
});

it('accepts a telegram chat task source without topic_id (for synthetic failure delivery)', () => {
  expect(isValidTaskSource({
    source: 'telegram',
    chat_id: '-100123',
    message_id: '99',
  })).toBe(true);
});
```

- [ ] **Step 2: Run the shared tests to verify failure**

Run: `npm test --prefix packages/shared -- src/__tests__/types.test.ts`
Expected: FAIL because Telegram task sources are not part of the shared contract yet.

- [ ] **Step 3: Implement the widened `TaskSource` union**

In `packages/shared/src/types.ts`:

- add `TelegramTopicTaskSource` and `TelegramChatTaskSource`
- widen `TaskSource`
- update `isValidTaskSource` to validate both variants
- keep Lark compatibility intact

Add explicit helper validators:

- `isValidTelegramTopicTaskSource(...)` (requires `topic_id`)
- `isValidTelegramChatTaskSource(...)` (no `topic_id`, used for synthetic failures)

Notes:

- Telegram forum-topic tasks always require `topic_id`.
- `TelegramChatTaskSource` exists only to support synthetic failures when topic metadata is missing or the bot is used in an unsupported chat.

Export the new type from `packages/shared/src/index.ts`.

- [ ] **Step 4: Run the shared tests to verify they pass**

Run: `npm test --prefix packages/shared -- src/__tests__/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): add telegram task source contract"
```

### Task 1A: Add shared task-event mirror contracts

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write failing shared task-event tests**

Add tests for:

```ts
it('accepts mirror as a valid task event kind', () => {
  expect(TASK_EVENT_KINDS).toContain('mirror');
});

it('accepts a mirror event payload with mirror_id and no destination', () => {
  expect(isValidTaskEvent({
    kind: 'mirror',
    task_id: 'task-123',
    session_id: 'session-123',
    task_type: 'coding',
    task_source: {
      source: 'telegram',
      chat_id: '-100123',
      topic_id: '42',
      message_id: '99',
    },
    mirror_id: 'mirror-123',
    author_type: 'user',
    text: 'hello',
    origin_message_id: '99',
    emitted_at: '2026-04-06T10:00:00.000Z',
  })).toBe(true);
});
```

- [ ] **Step 2: Run the shared tests to verify failure**

Run: `npm test --prefix packages/shared -- src/__tests__/types.test.ts`
Expected: FAIL because `mirror` is not yet part of the shared task-event contract.

- [ ] **Step 3: Implement the shared mirror-event contract**

In `packages/shared/src/types.ts`:

- add `mirror` to the task-event kind union / `TASK_EVENT_KINDS`
- define the `MirrorTaskEvent` shape with `task_type`, `mirror_id`, `author_type`, `text`, `origin_message_id`, and `emitted_at`
- widen shared event validators so `mirror` payloads are accepted

Export the new task-event helpers from `packages/shared/src/index.ts`.

- [ ] **Step 4: Run the shared tests to verify they pass**

Run: `npm test --prefix packages/shared -- src/__tests__/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): add mirror task event contract"
```

### Task 2: Add Telegram persistence schema and repositories

**Files:**
- Modify: `packages/shared/src/db/schema.ts`
- Create: `packages/shared/src/db/telegram-history-repository.ts`
- Create: `packages/shared/src/db/session-bridge-repository.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/__tests__/db/telegram-history-repository.test.ts`
- Create: `packages/shared/src/__tests__/db/session-bridge-repository.test.ts`

- [ ] **Step 1: Write the failing repository tests**

Add tests covering:

```ts
it('upserts telegram thread state and records inbound/outbound messages', async () => {
  // create thread row, insert messages, read them back in order
});

it('upserts and resolves a session bridge by session_id and telegram topic id', async () => {
  // create bridge row, query by both keys
});

it('deletes telegram messages, thread rows, and bridge rows by session_id', async () => {
  // ensure full cleanup is possible
});
```

- [ ] **Step 2: Run the shared DB tests to verify failure**

Run: `npm test --prefix packages/shared -- src/__tests__/db/telegram-history-repository.test.ts src/__tests__/db/session-bridge-repository.test.ts`
Expected: FAIL because the schema/repositories do not exist.

- [ ] **Step 3: Add the Telegram and bridge tables to the shared schema**

In `packages/shared/src/db/schema.ts` add:

- `telegramThreadsTable`
- `telegramMessagesTable`
- `sessionBridgesTable`

Keep table shape aligned with the design spec, including composite primary key `(chat_id, topic_id)` for `telegram_threads`, composite primary key `(chat_id, message_id)` for `telegram_messages`, composite foreign keys, explicit `status_message_id` and `metadata_json` on `telegram_threads`, and `UNIQUE (telegram_chat_id, telegram_topic_id)` on `session_bridges`.

- [ ] **Step 4: Implement the repositories**

Create `packages/shared/src/db/telegram-history-repository.ts` with focused methods for:

- upserting topic state
- recording inbound/outbound messages
- lookup by `(chat_id, topic_id)`, `session_id`, and `(chat_id, message_id)`
- listing messages for a topic
- deleting rows by `session_id`

Create `packages/shared/src/db/session-bridge-repository.ts` with methods for:

- upsert by `session_id`
- get by `session_id`
- get by Lark root message id
- get by Telegram chat/topic identity
- mark ended / delete by `session_id`

Export all new tables/repositories from `packages/shared/src/index.ts`.

- [ ] **Step 5: Run the repository tests to verify they pass**

Run: `npm test --prefix packages/shared -- src/__tests__/db/telegram-history-repository.test.ts src/__tests__/db/session-bridge-repository.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/db/schema.ts packages/shared/src/db/telegram-history-repository.ts packages/shared/src/db/session-bridge-repository.ts packages/shared/src/index.ts packages/shared/src/__tests__/db/telegram-history-repository.test.ts packages/shared/src/__tests__/db/session-bridge-repository.test.ts
git commit -m "feat(shared): add telegram persistence and bridge repositories"
```

### Task 3: Add the migration for Telegram tables and bridge table

**Files:**
- Create: `packages/migrator/src/migrations/0001_telegram_bridge_state.sql`
- Modify: `packages/migrator/src/migrations/meta/_journal.json`
- Modify: `packages/migrator/src/__tests__/migrate.test.ts`

- [ ] **Step 1: Write the failing migration test**

Add assertions in `packages/migrator/src/__tests__/migrate.test.ts` that the migrated DB contains:

- `telegram_threads`
- `telegram_messages`
- `session_bridges`

and that inserts/selects against those tables succeed using composite Telegram identities.

- [ ] **Step 2: Run migration tests to verify failure**

Run: `npm test --prefix packages/migrator -- src/__tests__/migrate.test.ts`
Expected: FAIL because the new tables are not created yet.

- [ ] **Step 3: Add the SQL migration and journal entry**

Create `packages/migrator/src/migrations/0001_telegram_bridge_state.sql` with the schema from the design spec, including composite Telegram keys and `status_message_id` storage on `telegram_threads`.

Update `packages/migrator/src/migrations/meta/_journal.json` with the new migration entry and increment the version metadata as required by current Drizzle output conventions.

- [ ] **Step 4: Run migration tests to verify they pass**

Run: `npm test --prefix packages/migrator -- src/__tests__/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/migrator/src/migrations/0001_telegram_bridge_state.sql packages/migrator/src/migrations/meta/_journal.json packages/migrator/src/__tests__/migrate.test.ts
git commit -m "feat(migrator): add telegram bridge schema"
```

### Task 4: Add Telegram inbound normalization and routing helpers

**Files:**
- Create: `packages/shared/src/telegram-content.ts`
- Create: `packages/shared/src/telegram-inbound-routing.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/__tests__/telegram-content.test.ts`
- Create: `packages/shared/src/__tests__/telegram-inbound-routing.test.ts`

- [ ] **Step 1: Write failing Telegram inbound tests**

Add tests for:

```ts
it('normalizes plain telegram text messages', () => {
  // expect normalized_text to equal message text
});

it('accepts a root /task command in an unmapped topic', () => {
  // expect accepted root task
});

it('rejects /task inside an existing topic continuation', () => {
  // expect same thread-only rejection semantics as Lark
});

it('accepts /status, /new, and /end only for mapped topic continuations', () => {
  // expect topic-only command behavior
});
```

- [ ] **Step 2: Run the shared Telegram routing tests to verify failure**

Run: `npm test --prefix packages/shared -- src/__tests__/telegram-content.test.ts src/__tests__/telegram-inbound-routing.test.ts`
Expected: FAIL because these modules do not exist.

- [ ] **Step 3: Implement Telegram content normalization and routing**

Create `packages/shared/src/telegram-content.ts` with normalization helpers for the Telegram update/message shape you plan to persist.

Create `packages/shared/src/telegram-inbound-routing.ts` mirroring the Lark routing contract:

- root `/task ...` accepted
- plain text in mapped topic becomes continuation
- `/status`, `/new`, `/end` are topic-only
- `/task` inside existing topic rejected
- non-normalizable messages rejected

Export the new helpers from `packages/shared/src/index.ts`.

- [ ] **Step 4: Run the shared Telegram routing tests to verify they pass**

Run: `npm test --prefix packages/shared -- src/__tests__/telegram-content.test.ts src/__tests__/telegram-inbound-routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/telegram-content.ts packages/shared/src/telegram-inbound-routing.ts packages/shared/src/index.ts packages/shared/src/__tests__/telegram-content.test.ts packages/shared/src/__tests__/telegram-inbound-routing.test.ts
git commit -m "feat(shared): add telegram inbound routing"
```

### Task 5: Teach the API to accept Telegram task sources and mirror events

**Files:**
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/api/src/routes/jobs.ts`
- Modify: `packages/api/src/routes/results.ts`
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`
- Modify: `packages/api/src/__tests__/routes/jobs.test.ts`
- Modify: `packages/api/src/__tests__/routes/results.test.ts`

- [ ] **Step 1: Write failing API tests**

Add tests asserting that:

```ts
it('accepts telegram task_source on POST /tasks', async () => {
  // source: telegram, chat_id, topic_id, message_id
});

it('accepts telegram task_source on POST /jobs', async () => {
  // telegram-enriched job payload reaches jobs route without 400
});

it('accepts telegram task_source on phase, result, and mirror POST /results', async () => {
  // all three event kinds should validate
});

it('accepts telegram-listener as a valid received-phase emitter', async () => {
  // received phase posted by telegram listener should validate
});
```

- [ ] **Step 2: Run API tests to verify failure**

Run: `npm test --prefix packages/api -- src/__tests__/routes/tasks.test.ts src/__tests__/routes/jobs.test.ts src/__tests__/routes/results.test.ts`
Expected: FAIL because current validation only accepts Lark task sources, `/jobs` is not updated, `mirror` is not a valid result event kind, and `telegram-listener` is not yet an allowed phase emitter.

- [ ] **Step 3: Implement minimal API compatibility changes**

Update route validation only as needed so the widened shared `isValidTaskSource` contract is accepted everywhere, including `/jobs`.

Also update `/results` validation so it accepts:

- `mirror` as a valid task-event kind
- `telegram-listener` as a valid received-phase emitter

Do not add Telegram-specific API branching here; keep the API generic.

- [ ] **Step 4: Run API tests to verify they pass**

Run: `npm test --prefix packages/api -- src/__tests__/routes/tasks.test.ts src/__tests__/routes/jobs.test.ts src/__tests__/routes/results.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/tasks.ts packages/api/src/routes/jobs.ts packages/api/src/routes/results.ts packages/api/src/__tests__/routes/tasks.test.ts packages/api/src/__tests__/routes/jobs.test.ts packages/api/src/__tests__/routes/results.test.ts
git commit -m "feat(api): accept telegram task sources and mirror events"
```

### Task 6: Add Telegram topic-context fetching for enrichment

**Files:**
- Create: `packages/daemon/task-enrichment/src/adapters/telegram-thread-context-fetcher.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write the failing topic-context tests**

Add tests covering:

```ts
it('returns inherited task metadata for a mapped telegram topic', async () => {
  // read telegram thread + message history + bridge mapping using (chat_id, topic_id)
});

it('returns not_thread for an unmapped telegram topic', async () => {
  // no session mapping exists yet
});
```

- [ ] **Step 2: Run enrichment tests to verify failure**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/enrichment-poller.test.ts`
Expected: FAIL because no Telegram topic fetcher exists.

- [ ] **Step 3: Implement `TelegramThreadContextFetcher`**

Create a fetcher that mirrors current Lark semantics:

- lookup Telegram topic row by `(chat_id, topic_id)` from `task_source`
- read topic messages in order
- format history into prompt context
- return inherited `task_type`, `session_id`, `executor`, and `executor_model`

Keep the return shape aligned with the current enrichment-side `ThreadContextResult` contract.

- [ ] **Step 4: Run enrichment tests to verify the new fetcher passes**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/enrichment-poller.test.ts`
Expected: PASS for the new fetcher-specific coverage.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/adapters/telegram-thread-context-fetcher.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(task-enrichment): add telegram topic context fetcher"
```

### Task 7: Extend the Telegram package into an inbound bridge daemon

**Files:**
- Modify: `packages/daemon/telegram-result/src/config.ts`
- Modify: `packages/daemon/telegram-result/src/index.ts`
- Create: `packages/daemon/telegram-result/src/telegram-update-poller.ts`
- Create: `packages/daemon/telegram-result/src/adapters/telegram-task-submitter.ts`
- Create: `packages/daemon/telegram-result/src/adapters/telegram-phase-publisher.ts`
- Create: `packages/daemon/telegram-result/src/adapters/telegram-topic-manager.ts`
- Create: `packages/daemon/telegram-result/src/__tests__/telegram-update-poller.test.ts`
- Modify: `packages/daemon/telegram-result/src/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing Telegram daemon tests**

Add tests for:

```ts
it('loads TELEGRAM_FORUM_GROUP_ID and no longer requires TELEGRAM_CHAT_ID for parity mode', () => {
  // config contract
});

it('rejects updates from chats other than the configured forum group', async () => {
  // ignored update
});

it('publishes a synthetic failure result for messages in the configured forum group that are not in a topic', async () => {
  // forum group can still receive non-topic messages; reject via results-queue visible error path
});

it('publishes a synthetic failure result for updates from groups that are not forum-enabled', async () => {
  // if the bot is accidentally added elsewhere, reject via results-queue visible error path
});

it('submits a telegram inbound task and publishes received phase for accepted topic messages', async () => {
  // happy path inbound listener flow
});
```

- [ ] **Step 2: Run the Telegram daemon tests to verify failure**

Run: `npm test --prefix packages/daemon/telegram-result -- src/__tests__/config.test.ts src/__tests__/telegram-update-poller.test.ts`
Expected: FAIL because inbound polling and forum-group config do not exist.

- [ ] **Step 3: Implement config and startup validation changes**

In `config.ts`:

- add required `TELEGRAM_FORUM_GROUP_ID`
- demote or remove `TELEGRAM_CHAT_ID` from normal parity mode

In `index.ts`:

- validate bot token with `getMe`
- validate configured group with `getChat`
- verify `is_forum === true`
- start both the existing outbound event poller and the new inbound update poller

- [ ] **Step 4: Implement inbound Telegram update polling**

Create `telegram-update-poller.ts` and minimal adapters to:

- poll `getUpdates`
- filter to the configured group
- reject bot-authored and mirrored messages
- detect updates in non-forum chats (or forum-disabled groups) and publish synthetic failure results
- detect missing forum topic/thread ids and publish synthetic failure results
- submit accepted Telegram inbound tasks
- publish `received` phase events best-effort after successful task submission

Keep this layer thin. It should hand off classification/materialization decisions to enrichment rather than duplicating business logic.

Do not let the Telegram listener emit cross-channel mirror messages directly. Accepted user-message mirroring must happen downstream through enrichment-emitted `mirror` events.

- [ ] **Step 5: Run the Telegram daemon tests to verify they pass**

Run: `npm test --prefix packages/daemon/telegram-result -- src/__tests__/config.test.ts src/__tests__/telegram-update-poller.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/telegram-result/src/config.ts packages/daemon/telegram-result/src/index.ts packages/daemon/telegram-result/src/telegram-update-poller.ts packages/daemon/telegram-result/src/adapters/telegram-task-submitter.ts packages/daemon/telegram-result/src/adapters/telegram-phase-publisher.ts packages/daemon/telegram-result/src/adapters/telegram-topic-manager.ts packages/daemon/telegram-result/src/__tests__/config.test.ts packages/daemon/telegram-result/src/__tests__/telegram-update-poller.test.ts
git commit -m "feat(telegram): add inbound forum-topic listener"
```

### Task 8: Make enrichment classify Telegram roots/topics, materialize bridge state, and emit user-message mirror events

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write the failing enrichment tests for Telegram flows**

Add tests for:

```ts
it('accepts a telegram root /task command, generates a session id, and posts a job', async () => {
  // root topic bootstrap
});

it('uses inherited session metadata for telegram topic continuations', async () => {
  // plain text continuation inside mapped topic
});

it('rejects /task inside an existing telegram topic', async () => {
  // same thread-only semantics as lark
});

it('handles /status, /new, and /end in a mapped telegram topic using the same semantics as lark', async () => {
  // /status uses inherited session_id, /new updates executor/model, /end terminates + triggers cleanup
});

it('emits a mirror event after accepting and persisting a lark user message', async () => {
  // accepted lark inbound user message -> bridge exists -> POST /results mirror event
});

it('emits a mirror event for an accepted telegram user message after persistence and bridge bootstrap', async () => {
  // accepted telegram inbound user message -> bridge exists -> POST /results mirror event
});
```

- [ ] **Step 2: Run the enrichment tests to verify failure**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/enrichment-poller.test.ts`
Expected: FAIL because enrichment only knows how to classify Lark inbound tasks today.

- [ ] **Step 3: Implement Telegram classification and session materialization**

Update `enrichment-poller.ts` so it can:

- decode and classify Telegram inbound envelopes
- route Telegram roots versus mapped topic continuations
- generate `session_id` for accepted Telegram roots
- persist inbound Telegram root/topic messages
- upsert Telegram thread state
- create/update bridge rows
- use the Telegram topic context fetcher for Telegram-sourced continuations
- publish `mirror` events for accepted inbound user messages after persistence and bridge bootstrap succeed

Also ensure Telegram `/status`, `/new`, and `/end` paths:

- resolve inherited session metadata via `TelegramThreadContextFetcher`
- perform the same state updates as existing Lark commands (including updating both `telegram_threads` and `lark_threads` where required by current semantics)
- publish the same downstream task/job/status events as the Lark path does today

Keep the existing Lark path intact; do not regress Lark behavior.

- [ ] **Step 4: Run the enrichment tests to verify they pass**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/enrichment-poller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(task-enrichment): materialize telegram sessions and bridges"
```

### Task 9: Implement topic creation and bridge bootstrap for Lark-originated sessions

**Files:**
- Create or Modify: `packages/daemon/telegram-result/src/telegram-bridge-service.ts`
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write the failing bridge bootstrap tests**

Add tests for:

```ts
it('creates a telegram topic when the first bridged lark session is materialized', async () => {
  // lark-root session -> createForumTopic -> persist topic/bridge
});
```

- [ ] **Step 2: Run the bridge/bootstrap tests to verify failure**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/enrichment-poller.test.ts`
Expected: FAIL because topic creation and bridge bootstrap for Lark-originated sessions do not exist.

- [ ] **Step 3: Implement Lark-originated Telegram topic creation and persistence**

Build a Telegram bridge service that can:

- create a forum topic in the configured Telegram group
- derive a deterministic title from `task_type` and `session_id`
- persist `telegram_threads`
- upsert `session_bridges`

Invoke it from the first point where an accepted Lark root session has a real `session_id` and bridge creation is safe.


- [ ] **Step 4: Run the bridge/bootstrap tests to verify they pass**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/enrichment-poller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/telegram-result/src/telegram-bridge-service.ts packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(bridge): create telegram topics for lark sessions"
```

### Task 10: Implement Lark anchor creation for Telegram-originated sessions

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/telegram-result/src/telegram-bridge-service.ts` or add a focused Lark bridge helper in the owning package
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write the failing Telegram-originated anchor tests**

Add tests for:

```ts
it('creates a lark root anchor when a session starts from telegram', async () => {
  // send root lark message, persist lark thread row, bridge topic to root message
});

it('persists the lark anchor before accepting subsequent mirrored telegram traffic', async () => {
  // continuation depends on bridge root
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/enrichment-poller.test.ts`
Expected: FAIL because no Telegram-originated Lark anchor bootstrap exists.

- [ ] **Step 3: Implement Telegram-originated Lark anchor creation**

Add a focused helper that can:

- send a root Lark message to the hardcoded Lark recipient
- capture the returned root message id
- persist the Lark thread anchor row
- upsert the `session_bridges` row with both sides present

Wire this into Telegram root-session materialization before the first job is posted.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/enrichment-poller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/telegram-result/src/telegram-bridge-service.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(bridge): create lark anchors for telegram sessions"
```

### Task 11: Add bidirectional loop prevention using persisted mirror metadata

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Modify: `packages/daemon/telegram-result/src/telegram-update-poller.ts`
- Modify: `packages/daemon/telegram-result/src/__tests__/telegram-update-poller.test.ts`

- [ ] **Step 1: Write the failing loop-prevention tests**

Add tests for:

```ts
it('skips mirrored telegram-originated outbound lark messages', async () => {
  // lark listener should not resubmit a mirrored message
});

it('skips mirrored lark-originated telegram messages seen through getUpdates', async () => {
  // telegram listener should not resubmit the mirror copy
});
```

- [ ] **Step 2: Run listener tests to verify failure**

Run: `npm test --prefix packages/daemon/lark-listener -- src/__tests__/message-handler.test.ts`
Run: `npm test --prefix packages/daemon/telegram-result -- src/__tests__/telegram-update-poller.test.ts`
Expected: FAIL because loop-prevention only handles platform-local duplicates today.

- [ ] **Step 3: Implement persistence-based loop checks**

In Lark listener:

- consult Lark message persistence before submitting inbound tasks
- skip previously persisted outbound mirrored/bot messages

In Telegram listener:

- skip bot-authored updates
- skip updates whose `message_id` is already stored as an outbound mirrored Telegram message
- skip updates marked by mirror metadata as Lark-originated

Keep the existing transport dedup behavior in place.

- [ ] **Step 4: Run listener tests to verify they pass**

Run: `npm test --prefix packages/daemon/lark-listener -- src/__tests__/message-handler.test.ts`
Run: `npm test --prefix packages/daemon/telegram-result -- src/__tests__/telegram-update-poller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts packages/daemon/telegram-result/src/telegram-update-poller.ts packages/daemon/telegram-result/src/__tests__/telegram-update-poller.test.ts
git commit -m "fix(bridge): prevent cross-channel mirror loops"
```

### Task 12: Route Telegram phase and result delivery into topics

**Files:**
- Modify: `packages/daemon/telegram-result/src/telegram-poller.ts`
- Modify: `packages/daemon/telegram-result/src/adapters/telegram-notifier.ts`
- Modify: `packages/daemon/telegram-result/src/__tests__/telegram-poller.test.ts`
- Modify: `packages/daemon/telegram-result/src/__tests__/telegram-notifier.test.ts`

- [ ] **Step 1: Write the failing outbound delivery tests**

Add tests for:

```ts
it('replies final results into the bridged telegram topic instead of a fixed chat', async () => {
  // lookup bridge/topic state, send to topic
});

it('posts or updates one topic status message for received/enriching/queued/executing', async () => {
  // phase-event handling
});

it('delivers synthetic non-topic failures back through the same telegram chat context', async () => {
  // visible error path
});
```

- [ ] **Step 2: Run Telegram outbound tests to verify failure**

Run: `npm test --prefix packages/daemon/telegram-result -- src/__tests__/telegram-poller.test.ts src/__tests__/telegram-notifier.test.ts`
Expected: FAIL because the current poller ignores phases and uses a fixed chat id.

- [ ] **Step 3: Implement topic-aware Telegram event delivery**

Update `telegram-poller.ts` and `telegram-notifier.ts` so they:

- look up bridge/topic state by `task_source` or `session_id`
- send result replies into the mapped topic
- handle phase events by sending or editing one status message per topic and persisting `status_message_id`
- clear/replace the status message when terminal results arrive
- support synthetic error result delivery for non-topic messages (missing topic/thread id)

Do not emit any additional cross-channel copy for bot-authored phase/result deliveries here. Bot-visible delivery already fans out through the existing exchange to every attached platform consumer.

- [ ] **Step 4: Run Telegram outbound tests to verify they pass**

Run: `npm test --prefix packages/daemon/telegram-result -- src/__tests__/telegram-poller.test.ts src/__tests__/telegram-notifier.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/telegram-result/src/telegram-poller.ts packages/daemon/telegram-result/src/adapters/telegram-notifier.ts packages/daemon/telegram-result/src/__tests__/telegram-poller.test.ts packages/daemon/telegram-result/src/__tests__/telegram-notifier.test.ts
git commit -m "feat(telegram): deliver phases and results into topics"
```

### Task 13: Extend cleanup and GC across Telegram rows and bridge rows

**Files:**
- Modify: `packages/daemon/task/src/adapters/cleanup-executor.ts`
- Modify: `packages/daemon/task/src/services/gc-executor.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts`
- Modify: `packages/daemon/task/src/services/__tests__/gc-executor.test.ts`

- [ ] **Step 1: Write the failing cleanup/GC tests**

Add tests asserting:

```ts
it('cleanup removes telegram messages, telegram thread state, and the session bridge', async () => {
  // session-specific cleanup
});

it('gc removes ended telegram sessions and bridge rows', async () => {
  // safety-net cleanup
});
```

- [ ] **Step 2: Run task-daemon cleanup tests to verify failure**

Run: `npm test --prefix packages/daemon/task -- src/adapters/__tests__/cleanup-executor.test.ts src/services/__tests__/gc-executor.test.ts`
Expected: FAIL because cleanup only handles Lark rows today.

- [ ] **Step 3: Implement cross-channel cleanup and GC**

Update cleanup and GC so ended sessions remove:

- `lark_messages`
- `lark_threads`
- `telegram_messages`
- `telegram_threads`
- `session_bridges`

Keep deletion ordered to satisfy foreign-key constraints.

- [ ] **Step 4: Run cleanup/GC tests to verify they pass**

Run: `npm test --prefix packages/daemon/task -- src/adapters/__tests__/cleanup-executor.test.ts src/services/__tests__/gc-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/adapters/cleanup-executor.ts packages/daemon/task/src/services/gc-executor.ts packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts packages/daemon/task/src/services/__tests__/gc-executor.test.ts
git commit -m "feat(task-daemon): clean up telegram bridge state"
```

### Task 14: Update runtime config and documentation

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docs/LOCAL_DEVELOPMENT.md`
- Modify: any root env example or command docs that mention Telegram config

- [ ] **Step 1: Write a minimal doc/config verification checklist**

Add/update documentation so it explicitly covers:

- `TELEGRAM_FORUM_GROUP_ID`
- forum-enabled-group requirement
- parity-mode behavior superseding `TELEGRAM_CHAT_ID`
- migration requirement before running the bridge daemon

- [ ] **Step 2: Run a targeted search to confirm stale `TELEGRAM_CHAT_ID` assumptions remain**

Run: `rg -n "TELEGRAM_CHAT_ID|telegram chat id|forum" docker-compose.yml docs packages`
Expected: stale references identified before editing.

- [ ] **Step 3: Update compose and docs**

Change compose/env/docs to reflect:

- Telegram forum group config
- single hardcoded group assumption
- topic-based parity mode

- [ ] **Step 4: Re-run the targeted search to verify the new contract is documented consistently**

Run: `rg -n "TELEGRAM_CHAT_ID|TELEGRAM_FORUM_GROUP_ID|forum" docker-compose.yml docs packages`
Expected: parity docs mention the forum group and any remaining `TELEGRAM_CHAT_ID` references are explicitly legacy-only.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docs/LOCAL_DEVELOPMENT.md
# add any other env/doc files you changed
git commit -m "docs: document telegram forum parity mode"
```

### Task 15: Run the focused verification matrix

**Files:**
- No source changes required unless fixes are needed

- [ ] **Step 1: Run shared package tests**

Run: `npm test --prefix packages/shared`
Expected: PASS.

- [ ] **Step 2: Run migrator tests**

Run: `npm test --prefix packages/migrator`
Expected: PASS.

- [ ] **Step 3: Run API tests**

Run: `npm test --prefix packages/api`
Expected: PASS.

- [ ] **Step 4: Run Telegram daemon tests**

Run: `npm test --prefix packages/daemon/telegram-result`
Expected: PASS.

- [ ] **Step 5: Run Lark listener/result tests**

Run: `npm test --prefix packages/daemon/lark-listener`
Run: `npm test --prefix packages/daemon/lark-result`
Expected: PASS.

- [ ] **Step 6: Run task-enrichment and task-daemon tests**

Run: `npm test --prefix packages/daemon/task-enrichment`
Run: `npm test --prefix packages/daemon/task`
Expected: PASS.

- [ ] **Step 7: Commit any final test-driven fixes**

```bash
git add -A
git commit -m "test: finalize telegram lark parity verification"
```
