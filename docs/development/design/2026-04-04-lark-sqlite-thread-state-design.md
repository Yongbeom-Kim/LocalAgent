# Design: Lark Thread State Backed by SQLite

**Date:** 2026-04-04
**Status:** Draft
**Depends on:** Lark thread reply routing (implemented), thread metadata inheritance (implemented), session ID enrichment (implemented), `/new` executor/model inheritance (implemented), `/status` thread lookup (implemented), `/end` cleanup flow (implemented)

## 1. Problem

The current Lark thread flow reconstructs state from the Lark Open API on demand.

Today, when a new Lark thread reply arrives, the system:

1. calls Lark `getMessage` to determine whether the message belongs to a thread and to recover `thread_id`/`root_id` (used as `root_message_id` in this spec);
2. calls Lark `listMessages` for the entire thread;
3. re-parses bot reply text to recover the current `task_type`, `session_id`, `executor`, and `executor_model`;
4. rebuilds the conversational history string from the remote thread every time.

That design works, but it makes every thread continuation depend on remote reconstruction of data that the system already observed previously. It also spreads thread-state durability across user-visible bot replies rather than a shared internal storage layer.

The user wants to replace that remote reconstruction path with a local SQLite database that is written incrementally as Lark messages are received or sent. After this change, thread/session lookup and prompt-history construction should read from SQLite instead of reconstructing from Lark.

## 2. Goal

Introduce a shared SQLite-backed Lark history store with the following properties:

- all inbound Lark messages are persisted when received;
- all outbound Lark messages sent by LocalAgent are persisted when sent;
- thread history, current session metadata, and inherited routing metadata are read from SQLite, not reconstructed from Lark message history;
- `/end` and GC delete the relevant persisted rows by `session_id`;
- both raw Lark content and normalized message content are stored;
- all DB access is implemented in `packages/shared` and imported by the relevant services;
- schema versioning and migrations are explicit and owned by a dedicated migration package/service;
- there is no user-facing contract change.

## 3. Non-Goals

- No backfill of existing Lark threads that predate the feature.
- No fallback to Lark thread reconstruction after rollout.
- No Telegram persistence in this rollout.
- No generalized cross-channel database abstraction in the first schema.
- No change to the visible Lark reply header contract (`task_type:`, `session_id:`, `executor:`, `model:` remain user-visible).
- No change to the current invariant that one Lark thread maps to one LocalAgent session.
- No new audit/event store beyond the required message history and thread metadata.

## 4. User Decisions Captured

- First rollout is **Lark only**.
- There is **no backfill** for existing active threads.
- There is **one shared SQLite file** for all services in a deployment.
- `/end` and GC use **hard deletes**.
- SQLite becomes the **only** source of truth for thread history/session lookup after cutover.
- Persist **all outbound Lark messages** through a shared DB writer path.
- Keep `thread_id` indexed even though lifecycle deletion is by `session_id`.
- Cut over reads and writes in the **same release**.
- Migration tooling is required.
- Use an **ORM/query-builder with migration tooling**, not ad hoc raw SQL-only migration management.
- Use SQLite WAL mode plus short transactions for concurrency.
- Store **both** normalized text and raw content.
- Use a **dedicated migration package/service** for schema upgrades.
- Keep the current invariant that **thread and session are 1:1**.
- Use a simplified Lark-prefixed schema: `lark_threads` and `lark_messages`.
- `/new` remains the same session; it updates stored thread metadata and its bot reply is also stored as a normal message with a marker.

## 5. Current State

### 5.1 What the listener receives today

The current `lark-listener` handler receives, from `im.message.receive_v1`, fields that include:

- `sender.sender_id.open_id`
- `sender.sender_type`
- `message.message_id`
- `message.chat_type`
- `message.message_type`
- `message.content`
- `message.mentions`

The current repo-level event shape used by `MessageHandler` does **not** treat `thread_id` or `root_id` as directly available listener inputs.

### 5.2 What the system fetches from Lark today

The current `ThreadContextFetcher` calls:

- `GET /im/v1/messages/{message_id}` to determine thread membership and recover `root_id` and `thread_id`;
- `GET /im/v1/messages?container_id_type=thread&container_id={thread_id}&sort_type=ByCreateTimeAsc` to fetch the full thread history.

### 5.3 What state is reconstructed today

The current thread continuation path reconstructs and parses:

- `threadContext`
- inherited `task_type`
- inherited `session_id`
- inherited `executor`
- inherited `executor_model`
- `/new` fence behavior using the visible marker `New session instance started.`

This means the system already depends on these as thread-scoped durable facts; it just stores them in remote message history instead of a local datastore.

## 6. Scope Assessment

This feature is one subsystem, not multiple independent projects:

- one SQLite-backed persistence layer for Lark thread state;
- one migration/bootstrap mechanism;
- one read-path replacement for thread-context reconstruction.

It does touch multiple services, but they all participate in a single coherent thread-history subsystem.

## 7. Approaches Considered

### Approach A: Replace remote reconstruction with SQLite as the canonical Lark thread store (recommended)

Persist inbound and outbound Lark messages as they happen, maintain canonical thread metadata in SQLite, and read thread history/inherited metadata from SQLite during enrichment.

**Pros**

- directly solves the user’s stated problem;
- eliminates repeated full-thread remote reconstruction;
- centralizes state in a shared package rather than bot-reply parsing as the primary store;
- keeps current user contract intact;
- creates a clean foundation for later Telegram support.

**Cons**

- introduces a real datastore and migration lifecycle;
- requires coordinated changes across multiple daemons;
- requires a first-write lookup of `thread_id`/`root_id` for inbound messages.

### Approach B: SQLite write-through cache, but keep Lark API fallback on miss

Persist messages locally but keep fallback to remote reconstruction when DB rows are missing or incomplete.

**Pros**

- more forgiving during rollout;
- lower immediate risk if write coverage is incomplete.

**Cons**

- contradicts the chosen requirement that DB is the only source of truth after cutover;
- preserves the remote-reconstruction complexity indefinitely;
- makes correctness harder to reason about because two sources of truth remain live.

### Approach C: Keep reconstruction logic, but add a derived cache of parsed thread metadata only

Persist only the latest parsed thread/session metadata and keep history reconstruction remote.

**Pros**

- smaller schema;
- fewer write paths.

**Cons**

- does not solve prompt-history reconstruction cost;
- still depends on remote full-thread fetches;
- only partially addresses the user request.

## 8. Recommendation

Adopt **Approach A**.

The requested change is not “cache some metadata.” It is “stop reconstructing history from the Lark Open API and instead query a SQLite database for message history, session id, and related state.” A canonical SQLite store is the only approach that meets that requirement cleanly.

## 9. Proposed Design

### 9.1 Core invariants

This design intentionally codifies the following current-system invariants:

1. One Lark thread maps to exactly one LocalAgent session.
2. `/new` does **not** create a new `session_id`; it starts a fresh executor instance within the same session/thread.
3. Thread-scoped routing metadata consists of:
   - `task_type`
   - `session_id`
   - `executor`
   - `executor_model`
4. SQLite becomes the canonical read source for all Lark thread history and thread metadata after rollout.

If a future feature intentionally breaks the thread/session 1:1 invariant, that should be a new design cycle and a schema migration, not hidden flexibility in V1.

### 9.2 Database topology

- One shared SQLite file on the host/volume.
- All services open connections to the same DB file through `packages/shared` repository APIs.
- SQLite runs in WAL mode.
- DB transactions must stay short and localized to one repository operation.
- No service other than the dedicated migrator upgrades schema.

### 9.3 Table names

Use Lark-prefixed tables now to leave room for a future Telegram-specific schema without forcing the first migration to pretend it is channel-agnostic.

Chosen tables:

- `lark_threads`
- `lark_messages`

### 9.4 Schema

#### Timestamp representation

All `*_at_ms` columns are **milliseconds since Unix epoch (UTC)**.

- For inbound messages: derive `created_at_ms` from the Lark message create time (converting seconds -> ms if needed).
- For outbound messages: set `created_at_ms` from local wall clock at persist time (or from any send response timestamp if available).
- Ordering uses `(created_at_ms, message_id)` to remain deterministic even if multiple messages share the same millisecond.

```sql
CREATE TABLE lark_threads (
  -- Stable per-thread key even before Lark assigns a thread container id.
  -- For root messages: root_message_id == message_id.
  -- For thread replies: root_message_id comes from Lark "root_id".
  root_message_id TEXT PRIMARY KEY,
  -- Lark thread container id when available (null for non-thread root messages).
  thread_id TEXT UNIQUE,
  session_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,                 -- fixed to 'lark' for this schema family
  chat_type TEXT,
  task_type TEXT NOT NULL,
  executor TEXT NOT NULL,
  executor_model TEXT NOT NULL,
  status TEXT NOT NULL,                 -- 'active' | 'ended'
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER
);

CREATE INDEX idx_lark_threads_session_id
  ON lark_threads(session_id);

CREATE INDEX idx_lark_threads_thread_id
  ON lark_threads(thread_id);

CREATE INDEX idx_lark_threads_status_updated_at
  ON lark_threads(status, updated_at_ms DESC);

CREATE TABLE lark_messages (
  message_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                 -- fixed to 'lark'
  root_message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT,
  direction TEXT NOT NULL,              -- 'inbound' | 'outbound'
  sender_type TEXT NOT NULL,            -- 'user' | 'bot'
  message_type TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  normalized_text TEXT,
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (root_message_id) REFERENCES lark_threads(root_message_id)
);

CREATE INDEX idx_lark_messages_thread_created_at
  ON lark_messages(root_message_id, created_at_ms ASC, message_id);

CREATE INDEX idx_lark_messages_session_created_at
  ON lark_messages(session_id, created_at_ms ASC, message_id);

CREATE INDEX idx_lark_messages_thread_message_id
  ON lark_messages(root_message_id, message_id);
```

#### Why no separate `sessions` table?

Because the user explicitly wants to simplify around the current invariant that thread and session are 1:1. In this design, `lark_threads` is the canonical thread row **and** the canonical session-metadata row.

#### Why keep `session_id` on `lark_messages` if thread/session are 1:1?

Even with the 1:1 invariant, duplicating `session_id` on message rows is still useful:

- `/end` and GC delete by `session_id` without a join;
- session-based queries remain cheap and explicit;
- future internal code that already deals in `session_id` does not need to translate through `thread_id` first.

### 9.5 Metadata stored structurally

The following thread-scoped metadata must live structurally in `lark_threads`, not only in visible bot reply text:

- `session_id`
- `task_type`
- `executor`
- `executor_model`
- `status`
- `created_at_ms`
- `updated_at_ms`
- `ended_at_ms`

The visible Lark reply header remains user-facing and unchanged, but it is no longer the canonical internal source of truth.

### 9.6 `metadata_json` contents

`metadata_json` exists to preserve message-specific fields without creating schema churn in V1.

Expected contents include, as needed:

- inbound sender identifiers that are useful later;
- mentions array;
- Lark-specific callback details not promoted to first-class columns;
- a `/new` marker on the bot reply that establishes the new executor/model selection;
- future outbound classification flags.

For `/new`, the bot reply should be stored as a normal `lark_messages` row and marked in `metadata_json`, for example with a shape like:

```json
{
  "event_kind": "new_instance_reply",
  "skip_continue": true
}
```

The exact JSON key naming can be finalized during implementation, but the important design constraint is: `/new` must be queryable as a persisted message event without needing a separate transitions table.

### 9.7 Inbound write path

When `lark-listener` receives a message:

1. normalize text/content exactly as today for task submission purposes;
2. determine `thread_id` and `root_message_id` before the DB write;
3. upsert `lark_threads` if needed;
4. insert the inbound row into `lark_messages`;
5. continue existing command parsing/submission flow.

#### How thread identity is learned

Because the current listener event shape does not provide `thread_id`/`root_id` directly in this repo, the listener must do one Lark `getMessage` lookup on inbound write when needed.

That lookup should determine:

- whether the message is in a thread;
- the canonical `thread_id`;
- the canonical `root_message_id`.

This is intentionally much smaller than the current reconstruction path. V1 still makes a single `getMessage` call at ingest time, but it removes the much more expensive repeated `listMessages` + reparse path from enrichment reads.

#### Root messages vs thread replies

For root messages that do not belong to a thread, the system still needs a canonical thread row because the same message may later become the root of a reply thread. In V1, the stable identity is `root_message_id`:

- root message: `root_message_id == message_id`, `thread_id` is null;
- later thread replies: `root_message_id` stays the root id, and `thread_id` is set once the Lark thread container id is known.

This avoids having to invent a fake `thread_id` for pre-thread roots while still allowing future queries to use either `root_message_id` (always known) or `thread_id` (known once a real thread exists).

Implementation detail can be finalized later, but the repository contract must hide that complexity from callers.

### 9.8 Outbound write path

All outbound Lark messages sent by LocalAgent in this workflow must be persisted through shared DB APIs.

For V1, that includes at least:

- normal task-result replies from `lark-result`;
- direct best-effort in-thread replies from `lark-listener` used for local usage errors.

The design target is broader than the current two call sites: every future service that sends a Lark message should use the shared writer path so outbound persistence does not drift.

Write ordering requirement:

- send Lark message;
- on success, persist the outbound message row and update `lark_threads` metadata if the message changes canonical thread state.

If send succeeds but DB persistence fails, the system should log loudly and retry according to the local caller’s failure policy. The design does **not** require transactional coupling between Lark and SQLite because they are separate systems, but it does require explicit observability around that failure mode.

### 9.9 Canonical read path after cutover

After rollout, thread-context and metadata reads must come from SQLite only.

The enrichment daemon should no longer reconstruct thread history by listing all Lark thread messages. Instead it should query shared repositories for:

- thread row by `root_message_id`, `thread_id`, or `message_id`;
- ordered messages for that thread;
- current stored `task_type`, `session_id`, `executor`, `executor_model`.

### 9.10 Query patterns

#### Query: resolve thread/session metadata for an incoming Lark message

```sql
SELECT thread_id, session_id, task_type, executor, executor_model, status
FROM lark_threads
WHERE root_message_id = ? OR thread_id = ?;
```

#### Query: resolve thread identity from a known Lark message id

This is the common enrichment entrypoint when a daemon starts with `message_id`.

```sql
SELECT root_message_id, thread_id, session_id
FROM lark_messages
WHERE message_id = ?;
```

#### Query: build history for prompt construction

```sql
SELECT direction, sender_type, message_type, normalized_text, raw_content, metadata_json, created_at_ms
FROM lark_messages
WHERE root_message_id = ?
ORDER BY created_at_ms ASC, message_id;
```

#### Query: lookup by session id for `/end` or GC

```sql
SELECT thread_id, session_id, status
FROM lark_threads
WHERE session_id = ?;
```

#### Delete: `/end`

```sql
DELETE FROM lark_messages WHERE session_id = ?;
DELETE FROM lark_threads WHERE session_id = ?;
```

#### Delete: GC candidate rows

```sql
SELECT session_id
FROM lark_threads
WHERE status = 'ended' AND ended_at_ms < ?;
```

Then delete matching `lark_messages` and `lark_threads` rows in one transaction.

### 9.11 Prompt-history formatting from DB rows

The DB stores both `raw_content` and `normalized_text`. Prompt construction should use normalized content where available.

Formatting rule for the thread history string:

- inbound user rows -> `user: <normalized_text>`
- outbound bot rows -> `assistant: <normalized_text>`

The formatting path should **not** depend on re-parsing visible `task_type:` / `session_id:` / `executor:` / `model:` lines to discover state. Those lines remain visible in outbound message text, but thread-scoped state now comes from `lark_threads`.

For prompt hygiene, the history builder may still strip the visible metadata header lines from stored outbound `normalized_text` before composing the history string. That is now a prompt-formatting concern, not a state-recovery concern.

### 9.12 Handling `/new`

Current invariant: `/new` keeps the same `session_id`.

When `/new` succeeds:

1. the outbound bot reply is persisted in `lark_messages`;
2. that message row is marked in `metadata_json` as a `/new` event;
3. `lark_threads.executor` and `lark_threads.executor_model` are updated to the effective chosen pair;
4. `lark_threads.updated_at_ms` is updated.

Because `task_type` remains thread-scoped, the same row also continues to represent the current inherited task type for later thread replies.

There is no separate `sessions` row and no session transition table in V1.

### 9.13 Handling `/end`

When `/end` is accepted and resolved to an existing session:

1. `lark_threads.status` may be updated to `ended` and `ended_at_ms` set as part of local bookkeeping;
2. the cleanup path deletes `lark_messages` and `lark_threads` by `session_id`;
3. this hard-delete behavior remains the external lifecycle contract.

The transient `ended` state exists mainly so the cleanup/GC logic and observability can be explicit before deletion. V1 should not rely on long-lived ended rows.

### 9.14 Handling GC

Because V1 uses hard deletes and no long-lived archive rows, GC has two roles:

1. existing session workspace cleanup in the filesystem;
2. DB cleanup safety net for any session rows intentionally marked ended but not yet deleted due to transient failure or ordering issues.

This preserves the requested “delete on `/end` or GC” semantics without assuming `/end` DB deletion is the only cleanup opportunity.

### 9.15 Shared package responsibilities

All DB operations must live in `packages/shared`.

Shared should own:

- DB config and file-path resolution;
- DB connection factory;
- repository interfaces and implementations;
- SQL/ORM schema definitions referenced by the migrator package;
- write helpers for inbound/outbound Lark message persistence;
- read helpers for thread metadata/history lookup;
- delete helpers by `session_id`;
- schema-version compatibility checks used by non-migrator services.

Service packages should **not** open ad hoc SQLite connections or embed their own SQL.

### 9.16 Migration ownership and lifecycle

Use a dedicated migration package/service.

#### Why not auto-migrate from shared on open?

A shared package is code reused by many processes. If every daemon can open the DB and opportunistically migrate schema, then startup races become normal behavior and migration coordination becomes implicit multi-process locking logic.

That is avoidable and unnecessary. The dedicated migrator keeps schema upgrades explicit.

#### Chosen model

- Add a new migration package/service responsible for schema creation and upgrades.
- Normal services fail fast if the DB schema is missing or outdated.
- Migration tooling should record schema version in the normal migration mechanism of the chosen library.

This design intentionally separates:

- **schema ownership** -> dedicated migrator package/service;
- **repository usage** -> `packages/shared`;
- **business writes/reads** -> existing daemons via shared repositories.

### 9.17 ORM / query-builder choice

The user asked for migration tooling and all DB operations centralized in shared.

The exact library can be finalized during implementation planning, but the design requires:

- SQLite support;
- explicit migrations;
- small typed repository calls suitable for a multi-package TypeScript monorepo;
- no heavy runtime service layer beyond what SQLite needs.

The plan should compare a lightweight TypeScript SQLite-friendly stack and recommend one, but the architecture does **not** depend on a specific brand name beyond “typed schema + migration tooling.”

### 9.18 Concurrency model

Because many services access the same SQLite file, the design assumes:

- SQLite WAL mode;
- short write transactions;
- repository methods that do small, bounded units of work;
- no long-held write locks in request/poll loops.

This is sufficient for the current deployment model and is simpler than introducing a dedicated DB writer queue/service for V1.

### 9.19 Rollout and cutover

Chosen rollout: same release writes and reads.

That means the implementation must ensure:

- inbound write coverage exists before enrichment switches to DB-only reads;
- outbound write coverage exists before relying on DB rows for current metadata/history;
- startup fails fast if migrator has not run.

There is no backfill and no fallback, so deployment order matters operationally.

Recommended deploy order:

1. run migrator;
2. deploy services with DB writes and DB reads enabled together.

## 10. Package / File Impact

Expected package impact:

- `packages/shared`
  - DB config
  - connection/repository layer
  - Lark history/thread persistence types and helpers
- new migration package/service
  - schema definitions / migration runner wiring
- `packages/daemon/lark-listener`
  - inbound persistence before submission
  - lightweight thread-id/root-id lookup on ingest (root-id is stored as `root_message_id`)
  - persist direct usage-reply outbound messages
- `packages/daemon/lark-result`
  - persist outbound reply messages and update thread metadata
- `packages/daemon/task-enrichment`
  - replace `ThreadContextFetcher` remote history reconstruction with DB-backed reads
- `packages/daemon/task`
  - cleanup/GC calls into shared DB delete helpers
- deployment/config/docs
  - shared DB path
  - migrator lifecycle
  - startup ordering

## 11. Risks and Mitigations

### Risk 1: DB rows missing for a newly received thread message

Because there is no fallback, a missed write could make thread continuation fail.

**Mitigation:**

- persist inbound message before task submission where possible;
- fail loudly on write failures;
- add integration tests that prove write-before-read ordering for the same message lifecycle.

### Risk 2: Successful Lark send but failed outbound DB persistence

The user sees a bot reply, but SQLite misses the event.

**Mitigation:**

- centralize outbound sends through shared-aware wrappers;
- log and retry DB persistence failures explicitly;
- test notifier/replier integration around persistence hooks.

### Risk 3: Confusion between visible bot headers and canonical internal metadata

Developers may keep parsing visible text even after the DB is canonical.

**Mitigation:**

- replace DB callers, not just add them;
- document that `lark_threads` is the canonical metadata source;
- limit header-text parsing to prompt-format sanitization only.

### Risk 4: Future Telegram support pressures the schema shape

A later Telegram rollout may want reusable tables.

**Mitigation:**

- keep the first migration explicitly Lark-prefixed;
- design repository boundaries so Telegram can add parallel repositories later;
- avoid pretending the schema is already cross-channel when it is not.

## 12. Testing Strategy

### Unit tests

- shared repository CRUD for `lark_threads` and `lark_messages`
- metadata updates for `/new`
- delete-by-session helpers
- DB-backed history formatter
- schema-version check behavior

### Service tests

- `lark-listener` persists inbound message rows before task submission
- `lark-listener` persists direct reply messages for local usage errors
- `lark-result` persists outbound task-result replies and updates canonical thread metadata
- `task-enrichment` reads thread history/metadata from DB rather than calling remote reconstruction APIs
- `cleanup` and GC delete DB rows by `session_id`

### Integration tests

- end-to-end thread continuation using only DB-backed reads
- `/new` updates executor/model in `lark_threads` while preserving the same `session_id`
- `/end` removes both thread and message rows
- no-backfill behavior for pre-existing thread rows is explicit and well-handled

## 13. Open Implementation Choices to Finalize in Planning

These are implementation choices, not design ambiguities:

- exact ORM/query-builder library selection;
- exact repository file layout under `packages/shared`;
- exact migrator package/service name and startup contract;
- exact `metadata_json` key names;
- exact DB path env var names and compose wiring.

## 14. Acceptance Criteria

This feature is complete when:

1. New Lark inbound and outbound messages are persisted into SQLite.
2. Enrichment no longer reconstructs thread history from Lark `listMessages`.
3. Thread-scoped metadata (`session_id`, `task_type`, `executor`, `executor_model`) is read from SQLite.
4. `/new` updates stored thread metadata without changing the session/thread identity.
5. `/end` and GC hard-delete relevant DB rows by `session_id`.
6. All DB access lives in `packages/shared`.
7. Schema migrations are owned by a dedicated migration package/service.
8. The user-facing Lark contract remains unchanged.
