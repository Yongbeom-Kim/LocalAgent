# Lark Listener Thin Wrapper Implementation Plan

**Goal:** Refactor the Lark ingress path so `lark-listener` only normalizes and enqueues Lark messages while `task-enrichment` owns command semantics, authoritative SQLite state, and downstream rejection behavior.

**Architecture:** Introduce a normalized internal `lark_inbound` envelope emitted by `lark-listener`, keep only the narrow listener-side metadata lookup needed to resolve root/thread identifiers, remove listener-side SQLite and command-policy ownership, and teach `task-enrichment` to parse, persist, classify, and route inbound Lark messages using the existing results pipeline for user-visible rejections. Preserve the current external Lark command contract while moving authority downstream.

**Tech Stack:** TypeScript, Node.js, Vitest, Express API, SQLite/Drizzle shared repository, existing Lark daemons

---

## File Structure

- Modify: `packages/daemon/lark-listener/src/index.ts`
- Modify: `packages/daemon/lark-listener/src/config.ts`
- Modify: `packages/daemon/lark-listener/src/message-handler.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/lark-replier.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/lark-message-metadata-resolver.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/config.test.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/lark-content.ts`
- Modify: `packages/shared/src/db/lark-history-repository.ts`
- Modify: `packages/shared/src/__tests__/db/lark-history-repository.test.ts`
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/task-enrichment/src/index.ts`
- Modify: `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`
- Modify as needed: `COMMANDS.md`

## Task 1: Define the normalized `lark_inbound` contract in shared code

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/lark-content.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/__tests__/types.test.ts`
- Modify: `packages/shared/src/__tests__/lark-content.test.ts`

- [ ] **Step 1: Add failing tests for the normalized envelope contract**

Cover:

- a typed internal envelope for Lark inbound tasks
- envelope field requirements (match design spec section 8.2):
  - required: `platform`, `schema_version`, `message_id`, `root_message_id`, `chat_type`, `sender_open_id`, `sender_type`, `message_type`, `raw_content`, `mentions`, `is_normalizable`, `occurred_at_ms`
  - optional: `thread_id` (nullable)
  - conditional: `normalized_text` required when `is_normalizable = true`
- required `root_message_id` semantics (`root_message_id = message_id` for root messages)
- nullable `thread_id` semantics for non-threaded/root messages
- serialization-safe fields for `raw_content`, `normalized_text`, `is_normalizable`, and sender/message metadata
- content normalization helpers that distinguish usable vs non-usable message types

- [ ] **Step 2: Run the shared tests to verify the new expectations fail**

Run:

```bash
cd packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/types.test.ts src/__tests__/lark-content.test.ts
```

Expected: failures for missing `lark_inbound` contract types or helper behavior.

If tests fail earlier with a module-resolution error such as `Failed to load url drizzle-orm/libsql/sqlite3`, resolve that pre-existing test/runtime issue first (otherwise Tasks 4/6 cannot be validated).

- [ ] **Step 3: Implement the minimal shared contract**

Add:

- a `LarkInboundEnvelope` type
- a `schema_version` literal (v1)
- helper return shapes that let the listener mark `is_normalizable` without embedding policy

Also update exports:

- ensure `packages/shared/src/index.ts` re-exports `LarkInboundEnvelope` (and any new helper types) so daemons can import from `@local-agent/shared`

- [ ] **Step 4: Re-run the shared tests**

Run:

```bash
cd packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/types.test.ts src/__tests__/lark-content.test.ts
```

Expected: PASS.

## Task 2: Strip listener bootstrapping down to ingress-only dependencies

**Files:**
- Modify: `packages/daemon/lark-listener/src/index.ts`
- Modify: `packages/daemon/lark-listener/src/config.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/config.test.ts` if startup assumptions change

- [ ] **Step 1: Add or update a startup-focused test if one does not already cover dependency wiring**

Cover:

- no SQLite bootstrapping in the listener entrypoint
- only metadata-resolver wiring needed for root/thread identity resolution remains in the listener entrypoint
- handler construction with only ingress dependencies

- [ ] **Step 2: Run the targeted listener tests to verify the expectation fails**

Run:

```bash
cd packages/daemon/lark-listener
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/config.test.ts src/__tests__/message-handler.test.ts
```

Expected: failure or missing assertions covering old dependency wiring.

- [ ] **Step 3: Update `index.ts` and config loading to remove SQLite dependencies**

Ensure startup wires only:

- config
- submitter
- best-effort replier
- best-effort reactor
- narrow metadata resolver for root/thread identifiers
- dedup
- message handler

Also update `config.ts` so `lark-listener` no longer requires `LOCAL_AGENT_DB_PATH` or loads `SqliteConfig`.

- [ ] **Step 4: Re-run the targeted listener tests**

Run:

```bash
cd packages/daemon/lark-listener
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/config.test.ts src/__tests__/message-handler.test.ts
```

Expected: PASS.

## Task 3: Convert the listener message handler to normalized-envelope submission only

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/lark-replier.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/lark-message-metadata-resolver.ts`

- [ ] **Step 1: Rewrite listener tests first**

Update tests so they assert:

- every inbound message is submitted as `task_type: 'lark_inbound'`
- payload is a JSON envelope, not a parsed workflow task
- envelope contains resolved `root_message_id` / `thread_id`
- envelope includes `occurred_at_ms` sourced from the event timestamp when available, otherwise `Date.now()`
- envelope includes `mentions` normalized from the Lark event (empty array when absent)
- metadata-resolution fallback uses `root_message_id = message_id` and `thread_id = null` when lookup cannot resolve thread identity
- malformed command shapes are still enqueued, not locally rejected
- success still triggers `react()`
- `/tasks` enqueue failure triggers a generic reply and no reaction
- no SQLite repository methods are called from the handler
- non-normalizable message types are still enqueued with `is_normalizable: false` and `normalized_text` omitted or null

- [ ] **Step 2: Run the listener tests to verify they fail against the old behavior**

Run:

```bash
cd packages/daemon/lark-listener
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/message-handler.test.ts src/__tests__/task-submitter.test.ts
```

Expected: failures because the handler still parses commands and writes history.

- [ ] **Step 3: Implement the minimal listener refactor**

Make `MessageHandler`:

- dedup by `message_id`
- resolve root/thread identifiers via the narrow metadata resolver
- normalize the Lark event into the shared `LarkInboundEnvelope`
- submit `task_type: 'lark_inbound'` with the JSON envelope payload
- do not set `executor` / `executor_model` on `lark_inbound` submissions
- always include `task_source: { source: 'lark', message_id }` so downstream results can reply in-thread
- reply only on enqueue failure
- react only on enqueue success

Adapter failure guardrails (match design spec section 8.7):

- if the event is missing `message_id` or `content` such that a minimally valid envelope cannot be constructed, do not enqueue; best-effort reply only if `message_id` is available
- if thread metadata resolution fails, fall back to `root_message_id = message_id` and `thread_id = null`

Narrow `LarkReplier` usage to a generic enqueue-failure helper message. Narrow `LarkMessageMetadataResolver` usage to envelope identity resolution only.

- [ ] **Step 4: Re-run the listener tests**

Run:

```bash
cd packages/daemon/lark-listener
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/message-handler.test.ts src/__tests__/task-submitter.test.ts
```

Expected: PASS.

## Task 4: Move inbound Lark persistence and state mutation authority into shared repository helpers for enrichment

**Files:**
- Modify: `packages/shared/src/db/lark-history-repository.ts`
- Modify: `packages/shared/src/__tests__/db/lark-history-repository.test.ts`

- [ ] **Step 1: Add repository tests for the new split ownership model**

Cover separate operations for:

- recording raw inbound audit/history rows without inventing authoritative thread state
- creating or updating authoritative thread/session state only after classification
- idempotent inbound persistence keyed by `message_id`
- preserving existing thread updates for `/new`, `/end`, and outbound results

Also cover the audit-only placeholder behavior required by the current schema FK:

- inbound audit persistence creates/updates a placeholder `lark_threads` row if needed, with `status = 'audit_only'` and `session_id = root_message_id`
- downstream thread-context recovery must treat `status = 'audit_only'` as not-authoritative (it must not be used as inherited session/task defaults)

- [ ] **Step 2: Run repository tests to verify the expected split is not implemented yet**

Run:

```bash
cd packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/db/lark-history-repository.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Refactor repository APIs**

Introduce or reshape methods so enrichment can (without requiring new DB columns):

- persist inbound message audit rows first, even before a session_id exists
- update thread state explicitly after accepted classification (including assigning the real session_id)
- look up thread relationships using envelope-provided `root_message_id` / `thread_id` plus SQLite-held message identity

Concrete constraint to handle (current schema has FK from `lark_messages.root_message_id -> lark_threads.root_message_id` and `lark_threads.session_id` is non-null):

- inbound audit persistence must ensure a `lark_threads` row exists, but it must be an **audit-only placeholder** that does not imply an active workflow thread
- recommended placeholder strategy: insert/upsert `lark_threads` with:
  - `session_id = root_message_id` (stable placeholder)
  - `status = 'audit_only'`
  - `task_type = 'unknown'` (or equivalent neutral value)
  - `executor` / `executor_model` set to existing defaults
  - `thread_id` populated when available

After classification succeeds, enrichment calls `upsertLarkThreadState(...)` to set the real `session_id`, `task_type`, executor/model, and status.

Recommended method split (names can vary, but keep the boundary explicit):

- `recordInboundAuditMessage(envelope: LarkInboundEnvelope): Promise<void>`
- `upsertLarkThreadState(params: UpsertLarkThreadStateParams): Promise<void>` (existing)

- [ ] **Step 4: Re-run repository tests**

Run:

```bash
cd packages/shared
node ../../common/scripts/install-run-rushx.js test -- src/__tests__/db/lark-history-repository.test.ts
```

Expected: PASS.

## Task 5: Teach enrichment to parse and classify `lark_inbound`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Add failing enrichment tests for the new ingress contract**

Cover:

- decoding `lark_inbound` envelopes
- preserving existing `/task`, `/new`, `/status`, `/end`, and `/gc` contract behavior
- root malformed `/task` still yields the usage reply
- threaded `/task ...` still yields the thread-specific rejection
- non-normalizable inputs are rejected downstream
- inbound messages are persisted before rejection publication
- `lark_inbound` is persisted before any thread-context fetch or thread preflight that depends on SQLite history
- duplicate `message_id` deliveries do not double-persist or double-advance thread state
- accepted inputs update thread state only after classification
- rejected inputs publish failure/help results with `task_source` preserved for correct Lark routing

- [ ] **Step 2: Run the enrichment tests to verify they fail**

Run:

```bash
cd packages/daemon/task-enrichment
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/enrichment-poller.test.ts
```

Expected: FAIL because `lark_inbound` is not yet recognized.

- [ ] **Step 3: Implement `lark_inbound` handling in `enrichment-poller.ts`**

Add a first-stage branch that:

- parses the JSON envelope
- persists the inbound message audit record
- treats inbound `message_id` as an idempotency key
- derives message meaning from `normalized_text`, `message_type`, and `is_normalizable`
- emits the same rejection text/behavior now covered by `COMMANDS.md`
- bypasses any existing thread preflight that assumes the inbound message is already present in SQLite
- routes accepted work into the existing enrichment/job flow

Required behavior details (match design spec section 8.5):

- determine root vs thread using the envelope:
  - root: `message_id === root_message_id`
  - thread reply: `message_id !== root_message_id`
- always ACK the `lark_inbound` task after:
  - persisting the inbound audit record, and
  - either publishing a rejection result or successfully creating a job

Task shape requirements:

- `lark_inbound` tasks must be submitted with `task_source: { source: 'lark', message_id }` and enrichment must preserve that `task_source` on any rejection results.

Dependency wiring requirement:

- update `packages/daemon/task-enrichment/src/index.ts` so `EnrichmentPoller` has access to `LarkHistoryRepository` (or a narrow writer interface) for inbound audit persistence and thread state updates

- [ ] **Step 4: Re-run the enrichment tests**

Run:

```bash
cd packages/daemon/task-enrichment
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/enrichment-poller.test.ts
```

Expected: PASS.

## Task 6: Rework thread-context recovery around enrichment-owned persisted data

**Files:**
- Modify: `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`

- [ ] **Step 1: Add failing thread-context tests for the new persisted inbound flow**

Cover:

- resolving root vs thread using persisted inbound message identity
- no enrichment-side dependence on Lark API metadata fetches
- thread recovery still honoring `/new` fences and inherited executor/model/session state
- audit-only placeholder rows are not treated as authoritative thread state (return `error` for thread replies whose root thread row is still `status = 'audit_only'`)

- [ ] **Step 2: Run the thread-context tests to verify they fail**

Run:

```bash
cd packages/daemon/task-enrichment
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/thread-context-fetcher.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Update `ThreadContextFetcher` to match the new persistence shape**

Use only envelope-provided `root_message_id` / `thread_id` plus repository-backed identity and thread data. Do not add new Lark API fetches in enrichment.

Explicitly treat `lark_threads.status = 'audit_only'` (and/or `task_type = 'unknown'`) as non-authoritative:

- for thread replies, return `kind: 'error'` so enrichment can reject with the existing thread-recovery failure behavior
- for root messages, continue returning `not_thread`

- [ ] **Step 4: Re-run the thread-context tests**

Run:

```bash
cd packages/daemon/task-enrichment
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/thread-context-fetcher.test.ts
```

Expected: PASS.

## Task 7: Verify downstream result behavior remains compatible with listener/enrichment ownership changes

**Files:**
- Inspect and modify only if needed: `packages/daemon/lark-result/src/lark-poller.ts`
- Inspect and modify only if needed: `packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify tests only if existing assumptions break

- [ ] **Step 1: Add or update result-daemon tests only if the new rejection flow breaks assumptions**

Focus on whether more failure/help messages now arrive through the normal results path.

- [ ] **Step 2: Run the targeted Lark result tests**

Run:

```bash
cd packages/daemon/lark-result
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-poller.test.ts src/__tests__/lark-notifier.test.ts
```

Expected: PASS, or reveal any notifier assumption that depended on listener-local replies.

- [ ] **Step 3: Apply minimal compatibility fixes if needed**

Avoid redesigning result routing. Keep this task narrow.

- [ ] **Step 4: Re-run the targeted Lark result tests**

Run:

```bash
cd packages/daemon/lark-result
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/lark-poller.test.ts src/__tests__/lark-notifier.test.ts
```

Expected: PASS.

## Task 8: Verify contract-level regressions across the Lark boundary

**Files:**
- Modify as needed: `COMMANDS.md`
- Modify tests across listener, enrichment, and shared packages if contract wording assertions require updates

- [ ] **Step 1: Compare implemented behavior against `COMMANDS.md`**

Check:

- root `/task` grammar
- thread-only `/new`, `/status`, `/end`
- root-only `/gc`
- malformed-command rejection classes
- natural-language thread continuation behavior

- [ ] **Step 2: Update `COMMANDS.md` only if wording must clarify unchanged semantics**

Do not introduce new command behavior in this step.

- [ ] **Step 3: Run the focused Lark contract tests**

Run:

```bash
cd packages/daemon/lark-listener
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/message-handler.test.ts

cd ../task-enrichment
node ../../../common/scripts/install-run-rushx.js test -- src/__tests__/enrichment-poller.test.ts src/__tests__/thread-context-fetcher.test.ts
```

Expected: PASS.

## Task 9: Run the full verification set for touched packages

**Files:**
- No new files; verification only

- [ ] **Step 1: Run shared package tests**

Run:

```bash
cd packages/shared
node ../../common/scripts/install-run-rushx.js test
```

Expected: PASS.

- [ ] **Step 2: Run listener package tests**

Run:

```bash
cd packages/daemon/lark-listener
node ../../../common/scripts/install-run-rushx.js test
```

Expected: PASS.

- [ ] **Step 3: Run enrichment package tests**

Run:

```bash
cd packages/daemon/task-enrichment
node ../../../common/scripts/install-run-rushx.js test
```

Expected: PASS.

- [ ] **Step 4: Run Lark result tests**

Run:

```bash
cd packages/daemon/lark-result
node ../../../common/scripts/install-run-rushx.js test
```

Expected: PASS.

- [ ] **Step 5: Run repo-level build + tests (matches PR merge gate)**

Run:

```bash
node common/scripts/install-run-rush.js update
node common/scripts/install-run-rush.js build
node common/scripts/run-rush-project-tests.js
```

Expected: PASS.

## Task 10: Review diff and prepare the implementation PR

**Files:**
- Review only the files touched above

- [ ] **Step 1: Inspect the final diff for boundary violations**

Confirm:

- listener does not own workflow parsing
- listener does not depend on SQLite
- listener metadata lookup is limited to root/thread identity resolution for the envelope
- enrichment owns authoritative persistence
- no new Lark API metadata fetches were introduced downstream

- [ ] **Step 2: Inspect the final diff for contract drift**

Run: `git diff -- packages/daemon/lark-listener packages/daemon/task-enrichment packages/shared COMMANDS.md`

Expected: only architectural-boundary changes consistent with the design doc.

- [ ] **Step 3: Write the implementation summary for the PR**

Include:

- listener/enrichment responsibility split
- normalized `lark_inbound` envelope
- SQLite ownership move
- confirmation that external command behavior is preserved

- [ ] **Step 4: Commit in focused slices**

Suggested commit sequence:

1. `feat(shared): add normalized lark inbound contract`
2. `refactor(lark-listener): make ingress enqueue-only`
3. `refactor(task-enrichment): own lark parsing and sqlite state`
4. `test(lark): cover thin-listener contract regressions`
