# Design: Telegram and Lark Feature Parity via Cross-Channel Thread Bridging

**Date:** 2026-04-05
**Status:** Ready for implementation planning
**Packages affected:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/migrator`, `packages/daemon/lark-listener`, `packages/daemon/lark-result`, `packages/daemon/task-enrichment`, `packages/daemon/telegram-result`

## 1. Problem

The system currently treats Lark and Telegram as fundamentally different products.

Today:

- Lark supports inbound task submission, thread continuation, `/status`, `/new`, `/end`, thread-scoped history, and SQLite-backed thread/session state.
- Telegram only consumes outbound result events from the results queue and sends them to a single hardcoded chat.
- Session semantics are built around Lark thread identity and Lark message persistence.
- There is no Telegram equivalent of a thread/session container, no Telegram inbound listener flow, and no Telegram persistence layer tied to `session_id`.

That means Telegram users cannot use the product the same way Lark users can, and a conversation started on one platform cannot continue coherently on the other.

## 2. Goal

Add full user-visible parity between Lark and Telegram by treating a Telegram forum topic as the Telegram-side replacement for a Lark thread and bridging both channels through a shared LocalAgent session.

After this feature:

1. one Lark thread maps to exactly one Telegram forum topic and exactly one `session_id`;
2. a new session started from either Lark or Telegram auto-creates the peer thread/topic in the other platform;
3. inbound Telegram messages can submit tasks and continue existing sessions, just like Lark replies do today;
4. `/status`, `/new`, and `/end` work from Telegram with semantics matching Lark;
5. task phase updates and final results route back to Telegram topics as first-class thread replies;
6. accepted user messages are echoed cross-channel between the mapped Lark thread and Telegram topic;
7. bot-visible phase updates and final results fan out to every attached channel through the existing result exchange;
8. loop prevention ensures mirrored messages do not recursively resubmit themselves;
9. Telegram thread and message state is persisted in SQLite and correlated to `session_id`.

## 3. Non-Goals

- No support for multiple Telegram groups in V1.
- No support for Telegram private chats in V1.
- No generalized platform-agnostic `conversation_threads` schema in V1.
- No backfill of preexisting Telegram conversations or Lark threads.
- No removal of the existing Lark-specific persistence model in favor of a fully abstract cross-platform schema.
- No attempt to infer or migrate sessions across different Telegram topics.
- No fallback behavior for Telegram groups without forum topics.
- No user-configurable routing rules beyond one hardcoded Telegram group and the existing hardcoded Lark recipient model.

## 4. User Decisions Captured

- Feature scope is full end-to-end parity, not just submission.
- Telegram uses forum topics as the thread container.
- If a new session starts on Lark, the system auto-creates a Telegram forum topic in a single configured Telegram group.
- If a new session starts on Telegram, the system auto-creates the peer Lark thread/reply chain.
- Mirroring is bidirectional with loop prevention.
- Messages arriving in Telegram groups that do not support forum topics are rejected; the visible error is delivered through the existing results-queue delivery path, not by a direct listener reply.
- Session ownership is strict: `1` Lark thread `<->` `1` Telegram topic `<->` `1` `session_id`.
- The Telegram group is hardcoded/configured the same way the Lark recipient is hardcoded today.
- New tables are required for Telegram messages and Telegram threads, correlated to `session_id`.

## 5. Existing Context

### 5.1 Lark is already a session-aware inbound channel

Current implemented behavior:

- `packages/daemon/lark-listener` accepts inbound Lark messages and turns them into `lark_inbound` tasks.
- `packages/daemon/task-enrichment` classifies those envelopes into root commands, thread continuations, `/status`, `/new`, and `/end`.
- `packages/shared/src/db/lark-history-repository.ts` stores Lark threads and messages in SQLite and is already the source of truth for thread/session lookup.
- `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` reads inherited thread metadata and prompt history from SQLite.
- `packages/daemon/lark-result` consumes both phase and result events, updates reactions, and replies into the originating Lark thread.

### 5.2 Telegram is currently an outbound-only sink

Current implemented behavior:

- `packages/daemon/telegram-result` polls the `telegram-messages` results queue.
- It ignores phase events.
- It formats final task results and sends them to a single hardcoded `TELEGRAM_CHAT_ID`.
- There is no Telegram inbound task source, no Telegram thread/topic identity, and no Telegram persistence in SQLite.

### 5.3 Current shared contracts are Lark-shaped

Current limitations in `@local-agent/shared`:

- `TaskSource` only supports `{ source: 'lark', message_id: string }`.
- inbound routing and thread context classification are named and typed specifically for Lark.
- SQLite schema only has `lark_threads` and `lark_messages`.
- GC cleanup only targets ended Lark rows.

This means Telegram parity requires widening core routing contracts, not just adding another notifier.

## 6. Scope Assessment

This is one coherent subsystem, not multiple independent projects.

It spans:

- shared routing contracts,
- Telegram inbound and outbound adapters,
- cross-channel bridge state,
- SQLite schema and migration updates,
- enrichment/thread-resolution updates,
- mirrored message delivery,
- cleanup behavior.

Those all serve the same feature: cross-channel session continuity between Lark threads and Telegram forum topics.

## 7. Approaches Considered

### Approach A: First-class cross-channel bridge with Telegram-specific persistence (recommended)

Keep the existing Lark storage model, add Telegram-specific persistence tables, and introduce a small shared bridge mapping keyed by `session_id`. Widen `TaskSource` and inbound-routing contracts so both channels are first-class peers.

**Pros**

- Matches the current codebase shape.
- Meets the user's explicit requirement for Telegram thread/message tables correlated to `session_id`.
- Avoids premature fully generic schema abstraction.
- Keeps Lark and Telegram packages independently understandable.

**Cons**

- Requires coordinated changes across most daemons.
- Introduces another set of SQLite repository methods and migration work.

### Approach B: Make Telegram a secondary projection of Lark state

Keep Lark as the only canonical thread/session store and treat Telegram topics purely as mirrored UI surfaces attached to Lark thread rows.

**Pros**

- Smaller schema change.
- Faster initial implementation.

**Cons**

- Conflicts with the requirement for dedicated Telegram thread/message tables.
- Makes Telegram-originated sessions awkward because Lark would still have to be the canonical root.
- Pushes too much platform asymmetry into bridge logic.

### Approach C: Replace all channel-specific tables with a fully generic conversation schema

Introduce a new canonical cross-platform session/conversation model and migrate both Lark and Telegram to it.

**Pros**

- Cleanest abstraction in theory.
- Simplifies future channel additions.

**Cons**

- Too much churn for one feature.
- Forces migration of already-working Lark state machinery.
- Higher implementation risk with little immediate user benefit.

## 8. Recommendation

Adopt **Approach A**.

This gives Telegram true first-class parity while preserving the existing Lark-centered design where it is already working. It adds only the abstractions required to let both channels participate in the same session lifecycle.

## 9. Design Overview

### 9.1 Core invariants

V1 codifies these invariants:

1. One LocalAgent session maps to exactly one Lark thread and exactly one Telegram forum topic.
2. The Telegram side always lives inside one configured forum-enabled Telegram group.
3. The Lark side still uses the existing hardcoded bot recipient/app identity model.
4. A message mirrored from one channel into the other is recorded as outbound platform traffic and must never be reclassified as a fresh inbound user command.
5. `/new` preserves the existing session semantics: new executor instance inside the same session/thread/topic.
6. `/end` terminates the session and removes both Lark and Telegram persisted rows for that session.

### 9.2 High-level architecture

```text
Lark user message ───────┐
                         │
                         v
                 lark-listener
                         │
                classify + submit task
                         │
                         v
                 task-enrichment
                         │
               job/session resolution
                         │
                         v
                   task-daemon
                         │
                   result events
                         │
              ┌──────────┴──────────┐
              v                     v
         lark-result         telegram-result
              │                     │
     reply into Lark thread   reply into Telegram topic
              │                     │
              └──── user-message mirrors ─────┐
                                               │
Telegram user message ──> telegram listener ───┘

Shared SQLite state:
- lark_threads
- lark_messages
- telegram_threads
- telegram_messages
- session_bridges
```

### 9.3 Why a small bridge table is required

The user explicitly asked for new Telegram thread/message tables tied to `session_id`. That alone is not enough to support deterministic cross-channel lookups. The system also needs a direct way to answer:

- given a `session_id`, what is the peer Telegram topic?
- given a Telegram topic (`chat_id` + `topic_id`), what is the peer Lark root/thread?
- when a session is ended, which rows in both channel tables belong to it?

The cleanest V1 answer is a small `session_bridges` table keyed by `session_id` that stores the current peer identifiers for both channels.

This is not a generalized conversation abstraction. It is a narrow bridge index joining two existing platform-specific persistence families.

## 10. Shared Contract Changes

### 10.1 Widen `TaskSource`

`packages/shared/src/types.ts` currently only supports Lark. Replace it with a discriminated union that supports both Lark and Telegram.

Recommended shape:

```ts
export interface LarkTaskSource {
  source: 'lark';
  message_id: string;
}

export interface TelegramTopicTaskSource {
  source: 'telegram';
  chat_id: string;
  message_id: string;
  topic_id: string;
}

export interface TelegramChatTaskSource {
  source: 'telegram';
  chat_id: string;
  message_id: string;
}

export type TaskSource = LarkTaskSource | TelegramTopicTaskSource | TelegramChatTaskSource;
```

Rationale:

- `message_id` stays the per-message routing key.
- normal Telegram forum-topic tasks require `chat_id` and `topic_id` to identify the Telegram thread deterministically.
- a chat-only Telegram task source is allowed only for synthetic failure delivery when the inbound message cannot be tied to a valid topic.
- keeping `TaskSource` platform-specific lets phase and result consumers decide whether an event applies to them.

### 10.2 Add Telegram inbound envelope types and routing helpers

Add Telegram equivalents to the current Lark-specific inbound model:

- `TelegramInboundEnvelope`
- `normalizeTelegramInboundContent(...)`
- `classifyTelegramInboundEnvelope(...)`

The command semantics should match current Lark behavior as closely as possible:

- root `/task <task_type> <executor> <model> <payload>` starts a new session;
- plain text inside a topic becomes a thread continuation;
- `/status`, `/new`, `/end` are topic-only commands;
- `/task` inside a topic is rejected;
- non-normalizable Telegram payloads are rejected with channel-appropriate help.

The existing Lark classification logic should remain intact but be mirrored by a Telegram-specific classifier rather than force-fitting Telegram into Lark-specific names.

### 10.3 Generalize thread-context fetching conceptually, not by immediate full abstraction

Do **not** replace `ThreadContextFetcher` with a platform-agnostic mega-interface in V1.

Instead:

- keep the current Lark `ThreadContextFetcher` for Lark-sourced tasks;
- add a Telegram topic context fetcher with equivalent outputs for Telegram-sourced tasks;
- add one thin enrichment-side dispatcher that picks the correct fetcher by `task_source.source`.

This avoids a large refactor while still enabling both channels.

## 11. SQLite Schema Changes

### 11.1 New tables

Add three tables:

1. `telegram_threads`
2. `telegram_messages`
3. `session_bridges`

Recommended shape:

Notes:

- Telegram identifiers are not globally unique. `topic_id` (forum `message_thread_id`) is unique within a chat, and `message_id` is unique within a chat. To avoid collisions, primary keys and foreign keys must include `chat_id`.
- For consistency with existing SQLite usage, all Telegram ids are stored as `TEXT` even if the upstream Telegram API uses integers.

```sql
CREATE TABLE telegram_threads (
  chat_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  task_type TEXT NOT NULL,
  executor TEXT NOT NULL,
  executor_model TEXT NOT NULL,
  status TEXT NOT NULL,
  seed_message_id TEXT,
  status_message_id TEXT,
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  PRIMARY KEY (chat_id, topic_id)
);

CREATE INDEX idx_telegram_threads_session_id
  ON telegram_threads(session_id);
CREATE INDEX idx_telegram_threads_status_updated_at
  ON telegram_threads(status, updated_at_ms DESC);

CREATE TABLE telegram_messages (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  message_type TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  normalized_text TEXT,
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id),
  FOREIGN KEY (chat_id, topic_id) REFERENCES telegram_threads(chat_id, topic_id)
);

CREATE INDEX idx_telegram_messages_topic_created_at
  ON telegram_messages(chat_id, topic_id, created_at_ms ASC, message_id);
CREATE INDEX idx_telegram_messages_session_created_at
  ON telegram_messages(session_id, created_at_ms ASC, message_id);

CREATE TABLE session_bridges (
  session_id TEXT PRIMARY KEY,
  lark_root_message_id TEXT NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL,
  telegram_topic_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  UNIQUE (telegram_chat_id, telegram_topic_id),
  FOREIGN KEY (lark_root_message_id) REFERENCES lark_threads(root_message_id),
  FOREIGN KEY (telegram_chat_id, telegram_topic_id) REFERENCES telegram_threads(chat_id, topic_id)
);
```

### 11.2 Why `session_bridges` is narrow and acceptable

The bridge table is not a generic replacement for `lark_threads` or `telegram_threads`. It only records the canonical cross-channel pairing for a session. Per-channel message history and channel-specific metadata remain in their own tables.

### 11.3 Repository additions

Add a new shared repository module, likely `packages/shared/src/db/session-bridge-repository.ts`, plus a Telegram history repository analogous to `lark-history-repository.ts`.

Responsibilities:

- `TelegramHistoryRepository`
  - upsert Telegram thread state
  - record inbound Telegram messages
  - record outbound Telegram messages
  - look up topic by (`chat_id`, `topic_id`)
  - look up thread by `session_id`
  - list topic messages for prompt history / mirroring metadata
  - delete Telegram rows by `session_id`

- `SessionBridgeRepository`
  - upsert bridge row
  - get bridge by `session_id`
  - get bridge by Lark root message id
  - get bridge by Telegram topic id (`chat_id`, `topic_id`)
  - mark bridge ended
  - delete bridge by `session_id`

GC and cleanup executors must remove ended rows from all three persistence families, not just Lark.

## 12. Telegram Inbound Design

### 12.1 Listener package shape

Do not create a separate new daemon package in V1. Extend `packages/daemon/telegram-result` into a Telegram bridge daemon that owns both Telegram inbound polling and outbound notification/mirroring.

Reasoning:

- Telegram already has a package and config surface.
- Telegram Bot API polling and topic/message send logic belong together operationally.
- This keeps deployment simple while still allowing the code inside the package to split into focused adapters.

Recommended internal structure:

```text
packages/daemon/telegram-result/src/
  index.ts
  config.ts
  telegram-poller.ts                  # outbound result/phase queue polling
  telegram-update-poller.ts           # inbound getUpdates loop
  telegram-bridge-service.ts          # topic creation + mirror routing orchestration
  adapters/
    telegram-notifier.ts              # send message/reply/topic API calls
    telegram-topic-manager.ts         # createForumTopic, validate forum group
    telegram-task-submitter.ts        # POST /tasks
    telegram-phase-publisher.ts       # POST /results for received phase if Telegram listener owns it
  __tests__/
```

### 12.2 Telegram inbound acceptance rules

Accepted inbound Telegram messages must satisfy all of the following:

1. message comes from the configured hardcoded Telegram group;
2. the group supports forum topics;
3. the message belongs to a forum topic (has a topic/thread identifier);
4. the message is not authored by the bot itself;
5. the message is not marked as a mirrored cross-channel message from LocalAgent;
6. the message content is normalizable into text for command parsing or thread continuation.

Messages in non-forum groups are not accepted as tasks. The listener should create a synthetic failure result event tied to the Telegram task source so the normal Telegram delivery path surfaces the error.

### 12.3 Telegram root vs continuation semantics

Telegram root behavior differs slightly from Lark because Telegram forum topics are explicit containers.

Rules:

- A message in a **new topic not yet mapped to a session** is treated as a potential root message.
- A message in an **existing mapped topic** is treated as a continuation command/message.
- If a Telegram-originated root starts a new session, the system must create a peer Lark seed message/reply chain and immediately persist the resulting bridge row.

### 12.4 Telegram received phase emission

Telegram listener should publish `received` phase events using the same generalized results API used by Lark. Telegram phase/result consumers will then react in their own channel-specific way.

## 13. Telegram Topic Creation and Validation

### 13.1 Hardcoded forum group config

Extend Telegram config with one new required value:

```ts
telegramForumGroupId: string; // TELEGRAM_FORUM_GROUP_ID
```

Keep `TELEGRAM_BOT_TOKEN`. The old `TELEGRAM_CHAT_ID` no longer represents the primary runtime target for parity mode; topic replies should route by bridge state. If a fallback DM path is still needed for backward compatibility, it should be explicitly marked legacy and not used for bridged sessions.

### 13.2 Startup validation

At startup, Telegram daemon should validate:

- bot token via `getMe`
- configured forum group via `getChat`
- `is_forum === true` on the configured group

If validation fails, the daemon exits immediately.

### 13.3 Topic creation policy

When a new session is first materialized from either side:

- if started from Lark, create a Telegram topic in the configured forum group;
- if started from Telegram, reuse the originating topic and create the peer Lark root/reply thread;
- persist `telegram_threads` and `session_bridges` immediately after creation or reuse.

Topic titles should be deterministic and concise, for example:

```text
<task_type> • <session_id short>
```

No configurable title templates in V1.

## 14. Cross-Channel Mirror Delivery Bus

### 14.1 Principle

All cross-channel copies must flow through the existing task-event/results exchange. Treat it as the delivery bus for mirrored traffic in the same way it already acts as the delivery path for reactions, phases, and final results.

That means:

- no listener or enrichment path calls the peer platform directly to deliver a mirrored message;
- a new `mirror` task-event kind carries cross-channel copies;
- the source-side owner emits the `mirror` event only after the authoritative message has been accepted or sent and persisted;
- destination result daemons consume the `mirror` event, perform destination-side dedup, deliver to their own platform when applicable, and persist the mirrored outbound message.

### 14.2 What must be mirrored

Mirror only accepted user-originated bridged-session traffic across channels:

- inbound user Lark root messages and thread replies into Telegram;
- inbound user Telegram root messages and topic continuations into Lark.

Bot-originated traffic does not use `mirror`. It already rides the fanout result exchange through `phase` and `result` events.

### 14.3 Mirror event contract

Add a new shared task-event kind:

```ts
type TaskEventKind = 'phase' | 'result' | 'mirror';
```

Recommended `mirror` payload shape:

```ts
interface MirrorTaskEvent {
  kind: 'mirror';
  task_id: string;
  session_id: string;
  task_type: string;
  task_source: TaskSource;
  mirror_id: string;
  author_type: 'user';
  text: string;
  origin_message_id: string;
  emitted_at: string;
}
```

`mirror_id` must be stable across retries so consumers can do idempotent destination-side delivery. A good V1 key is derived from the origin platform identity, e.g. `lark:<message_id>` or `telegram:<chat_id>:<message_id>`.

### 14.4 Source-side emission rules

Emit `mirror` events only for accepted user messages, at the point where the source-side canonical record is known to exist:

- `task-enrichment` emits the `mirror` event after persistence/materialization and after any required bridge bootstrap completes.

This keeps user-message mirroring downstream of the canonical accept path and avoids mirrored ghost messages for rejected or failed inbound handling.

### 14.5 Destination-side delivery and persistence

Destination result daemons own mirror delivery, but selection is implicit rather than encoded in the payload:

- every attached platform consumer receives the same `mirror` event from fanout;
- a consumer ignores the event if `task_source.source` is its own platform;
- a consumer ignores the event if the session is not bridged to that platform;
- otherwise it dedups by `mirror_id` and persisted origin metadata, delivers locally, and stores the outbound mirror in platform-local history.

Mirrored outbound rows should still record origin metadata, for example:

```json
{
  "mirror_origin": "lark",
  "origin_message_id": "om_xxx",
  "mirror_id": "mirror_xxx",
  "mirrored_by": "local-agent"
}
```

Persisted metadata remains part of loop prevention.

## 15. Lark Anchor and Topic Bootstrap

### 15.1 Telegram topic bootstrap for Lark-originated sessions

When a session is first accepted on Lark, enrichment must create the peer Telegram topic in the configured forum group, persist `telegram_threads`, and create the `session_bridges` row before emitting the `mirror` event for the accepted user message.

### 15.2 Lark anchor creation for Telegram-originated sessions

When a session starts on Telegram, there is no existing Lark root message yet. V1 should create one by sending a seed message to the hardcoded Lark recipient and then replying in-thread as needed.

Recommended behavior:

1. send a root Lark message containing the initial task header and user text;
2. persist that sent root message as the `lark_threads.root_message_id` anchor;
3. create the bridge row linking it to the Telegram topic;
4. only then emit the `mirror` event for the accepted Telegram user message.

This keeps the Lark side consistent with the existing 1-thread-to-1-session model.

## 16. Loop Prevention

### 16.1 Principle

A mirrored user message must not be mistaken for a fresh inbound user message on the destination platform.

### 16.2 Telegram loop prevention

Telegram listener should skip messages when any of the following is true:

- `from.is_bot === true` and sender is the LocalAgent bot;
- message metadata in local persistence marks it as `mirror_origin = 'lark'`;
- the Telegram `message_id` is already recorded in `telegram_messages`.

### 16.3 Lark loop prevention

Lark listener already sees bot traffic. It should be tightened so mirrored Telegram-originated user messages and bot-authored outbound messages can be identified from local persistence and not resubmitted as inbound tasks.

Recommended rule:

- before submitting a Lark inbound task, consult `lark_messages` metadata for the message id;
- if it exists as an outbound mirrored message or bot-authored outbound message, skip enqueue;
- continue using the existing dedup map for transport-level duplicate delivery protection.

### 16.4 Why persistence-based loop prevention is necessary

Transport-level dedup only handles duplicate deliveries from the same platform. It does not prevent the other platform's mirrored copy from looking like a brand new user message. Persisted mirror metadata remains the durable source of truth for loop prevention, while `mirror_id` makes fanout-based mirror delivery retry-safe.

## 17. Result and Phase Delivery Changes

### 17.1 Telegram result consumer becomes a first-class task-event consumer

`packages/daemon/telegram-result/src/telegram-poller.ts` should stop ignoring non-result task events and should consume `phase`, `result`, and `mirror` events from the delivery bus.

Instead:

- phase events for any bridged task update the Telegram topic with an intermediate status signal,
- result events reply into the mapped topic rather than a fixed chat,
- mirror events deliver accepted user-message copies into Telegram when the source platform is not Telegram.

V1 does **not** need Telegram emoji/reaction parity. A lightweight textual status update policy is sufficient, but it must be explicit.

Recommended V1 status policy:

- send or edit one bot status message per topic for `received`, `enriching`, `queued`, `executing`;
- clear/replace it when the final result arrives;
- record the status-message id in `telegram_threads.status_message_id`.

### 17.2 Lark result consumer gains delivery-bus mirror responsibilities

`lark-result` keeps current reaction + reply behavior for Lark, but it also becomes bridge-aware in two ways:

- phase/result fanout for bridged sessions means bot-visible Lark replies still land in the mapped thread through the normal task-event path;
- consume `mirror` events whose source platform is not Lark and deliver them into the mapped Lark thread with destination-side dedup.

Cleanup on `/end` still removes both Lark and Telegram persisted state and the bridge row.

### 17.3 Error delivery for Telegram non-forum groups

For Telegram inbound messages in the configured group when `is_forum !== true` or topic metadata is missing:

- do not enqueue a normal task/job;
- publish a synthetic failure result through `/results` with `task_source.source = 'telegram'` and the original `chat_id` / `message_id`;
- Telegram result consumer delivers the visible error via the normal outbound path.

This matches the user's requested “throws and pushes an error message to the user from the results queue” behavior.

## 18. Enrichment and Session Materialization

### 18.1 Telegram root tasks need session materialization symmetric to Lark

Current enrichment logic materializes Lark root thread state into SQLite once root commands are accepted. Add a symmetric path for Telegram roots:

- classify Telegram root `/task ...` command;
- generate `session_id`;
- create or reuse the Telegram topic row;
- create the peer Lark anchor thread;
- create the bridge row;
- persist the inbound Telegram root message;
- emit a `mirror` event for the accepted inbound user message after persistence and bootstrap succeed;
- proceed with normal enrichment.

For Lark-originated roots, the same materialization step must also ensure a `session_bridges` row exists. If the bridge does not yet exist, enrichment should create the peer Telegram topic in the configured forum group, persist `telegram_threads`, then persist `session_bridges`. After the accepted inbound Lark user message is persisted, enrichment should emit a `mirror` event rather than sending to Telegram directly.

### 18.2 Telegram thread continuations need inherited metadata lookup

Add `TelegramThreadContextFetcher` that reads:

- `telegram_threads` by `topic_id`
- `telegram_messages` for prompt history
- `session_bridges` for peer mapping when a mirrored action is required

It should return the same shape the enrichment poller already expects:

- `threadContext`
- `inheritedTaskType`
- `inheritedSessionId`
- `inheritedExecutor`
- `inheritedExecutorModel`

### 18.3 Cleanup and `/status`

`/status`, `/new`, and `/end` semantics should work identically on Telegram topics.

That means:

- `/status` uses inherited `session_id` and existing task-daemon status API;
- `/new` updates both `telegram_threads` and `lark_threads` executor/model metadata for the shared session;
- `/end` marks both thread rows ended, publishes final replies to both channels, and deletes persisted rows for the session after delivery succeeds.

## 19. API and RabbitMQ Implications

No new topological concept is required beyond what already exists for generalized task events, but queue configuration must reflect the richer Telegram role.

Required updates:

- keep the existing `telegram-messages` queue as the Telegram task-event consumer queue;
- route `phase`, `result`, and `mirror` events there;
- keep the existing Lark task-event consumer queue and route `phase`, `result`, and `mirror` events there as well;
- no second Telegram queue is required in V1;
- `/tasks`, `/jobs`, and `/results` validation must accept Telegram task sources;
- `/results` validation must accept `mirror` as a task-event kind;
- shared/API phase-emitter validation must allow `telegram-listener` for the Telegram `received` phase.

## 20. Config Changes

### 20.1 New/updated env vars

`packages/daemon/telegram-result/src/config.ts` should load:

- `API_URL`
- `POLL_INTERVAL_MS`
- `LOG_LEVEL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_FORUM_GROUP_ID`

`TELEGRAM_CHAT_ID` should be removed from the bridged-session path. If retained temporarily for migration compatibility, it must be documented as legacy and unused for normal parity flows.

### 20.2 Compose and docs

Update:

- `docker-compose.yml`
- root env example/docs
- any dev scripts that currently assume Telegram only needs a chat id

## 21. Testing Strategy

### 21.1 Shared contract tests

Add/update tests for:

- widened `TaskSource`
- Telegram inbound envelope validation/classification
- bridge repository helpers
- Telegram history repository behavior

### 21.2 Migration tests

Add migrator coverage for:

- creation of `telegram_threads`, `telegram_messages`, and `session_bridges`
- schema version/journal update
- repository CRUD over the new tables

### 21.3 Telegram daemon tests

Add tests for:

- forum-group startup validation
- inbound `getUpdates` polling and filtering
- non-forum group rejection publishing synthetic failure result
- topic creation for Lark-originated sessions
- Telegram-root session bootstrap creating a Lark anchor
- phase/result delivery into topics
- loop prevention for mirrored messages

### 21.4 Cross-channel integration-style unit tests

Add focused unit/integration tests around orchestrated flows:

1. Lark root `/task ...` creates session, Telegram topic, and bridge row.
2. Telegram topic root `/task ...` creates session, Lark root anchor, and bridge row.
3. Lark user reply mirrors into Telegram topic but does not re-enqueue as a Telegram task.
4. Telegram user reply mirrors into Lark thread but does not re-enqueue as a Lark task.
5. `/status`, `/new`, and `/end` behave consistently from either channel.
6. cleanup removes rows from `lark_*`, `telegram_*`, and `session_bridges`.

## 22. Rollout Notes

- This feature should ship with migrations and read/write cutover in the same release.
- There is no backfill path for old sessions.
- Existing hardcoded Telegram chat result delivery behavior is superseded by topic-based delivery for parity mode.
- Operators must configure a forum-enabled Telegram group before enabling the daemon.

## 23. Open Design Choices Resolved

These were clarified and are fixed for V1:

- Telegram deployment scope: one hardcoded/configured forum-enabled group only.
- Topic creation: auto-create peer topic/thread both directions.
- Mirroring: bidirectional with persistence-based loop prevention.
- Non-forum group behavior: reject through the results queue path only.
- Session ownership: strict `1` Lark thread `<->` `1` Telegram topic `<->` `1` session.
