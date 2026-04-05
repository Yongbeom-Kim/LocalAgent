# Task Phase Reactions Implementation Plan

**Goal:** Add an extensible task-phase event model and implement Lark intermediate reactions for `received`, `enriching`, `queued`, and `executing`, with reaction cleanup on `completed` and no final-state reaction.

**Architecture:** Introduce a shared task-phase contract and a new API-managed `task-phases` fanout exchange. Existing daemons emit channel-agnostic phase events at the lifecycle boundaries they already own, and a Lark-specific consumer inside the Lark result package maps those events to a single current reaction per thread message while persisting best-effort observability metadata.

**Tech Stack:** TypeScript, Express, amqplib, Vitest, Drizzle/SQLite, existing LocalAgent daemon packages.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/shared/src/types.ts` | Shared phase constants, ordering helpers, and task-phase event interfaces |
| `packages/shared/src/constants.ts` | Queue and exchange names for task-phase fanout |
| `packages/shared/src/index.ts` | Export the new phase symbols |
| `packages/api/src/services/rabbitmq.ts` | Declare task-phase exchange/queue topology and support delivery tracking for task-phase queues |
| `packages/api/src/routes/task-phases.ts` | Publish, poll, and ACK task-phase events |
| `packages/api/src/app.ts` | Register task-phase routes |
| `packages/api/src/__tests__/routes/task-phases.test.ts` | Route coverage for task-phase APIs |
| `packages/daemon/lark-listener/src/message-handler.ts` | Emit `received` phase after accepted task submission |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Assert `received` phase publication |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Emit `enriching`, `queued`, and terminal cleanup phase for rejections |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Assert phase emission sequencing |
| `packages/daemon/task/src/task-poller.ts` | Emit `executing` after immediate ACK and before orchestration |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Assert `executing` emission ordering |
| `packages/daemon/lark-result/src/task-phase-poller.ts` | Poll task-phase events for Lark |
| `packages/daemon/lark-result/src/adapters/lark-phase-notifier.ts` | Translate phases to reactions and cleanup |
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Reuse shared cleanup helper and keep final reply text behavior |
| `packages/daemon/lark-result/src/__tests__/lark-phase-notifier.test.ts` | Verify reaction mapping and cleanup behavior |
| `packages/shared/src/db/lark-history-repository.ts` | Persist phase-reaction metadata/failure markers |
| `packages/shared/src/db/schema.ts` and migrator files | Not used in V1 (no schema changes). Reserved for a future persisted monotonic guard if needed |

### Task 1: Add shared task-phase contracts first

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write failing shared-type tests**

Add tests in `packages/shared/src/__tests__/types.test.ts` for:

```ts
it('exports the supported task phases in lifecycle order', () => {
  expect(TASK_PHASES).toEqual(['received', 'enriching', 'queued', 'executing', 'completed']);
});

it('validates task phase event payloads', () => {
  expect(isValidTaskPhase('queued')).toBe(true);
  expect(isValidTaskPhase('unknown')).toBe(false);
});

it('compares task phases monotonically', () => {
  expect(compareTaskPhases('queued', 'executing')).toBeLessThan(0);
});
```

- [ ] **Step 2: Run the shared tests to verify failure**

Run: `npm test --prefix packages/shared -- src/__tests__/types.test.ts`
Expected: tests fail because task-phase constants and helpers do not exist yet.

- [ ] **Step 3: Add the shared phase model**

In `packages/shared/src/types.ts`, add:

- `TASK_PHASES`
- `TaskPhase`
- `isValidTaskPhase(value)`
- `compareTaskPhases(a, b)`
- `TaskPhaseEventSubmission`
- `TaskPhaseEvent`

Spec alignment requirement (must-do):

- `TaskPhaseEvent` must include server-assigned `event_id` and `emitted_at`.
- `metadata.emitted_by` must be constrained to `'lark-listener' | 'task-enrichment' | 'task-daemon'`.

In `packages/shared/src/constants.ts`, add:

```ts
export const DEFAULT_TASK_PHASES_EXCHANGE_NAME = 'task-phases';
export const DEFAULT_LARK_TASK_PHASES_QUEUE_NAME = 'lark-task-phases';
```

Export the new symbols from `packages/shared/src/index.ts`.

- [ ] **Step 4: Run the shared tests to verify they pass**

Run: `npm test --prefix packages/shared -- src/__tests__/types.test.ts`
Expected: shared task-phase tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/constants.ts packages/shared/src/index.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): add task phase event contract"
```

### Task 2: Expose API support for task-phase publish, poll, and ACK

**Files:**
- Modify: `packages/api/src/services/rabbitmq.ts`
- Add: `packages/api/src/routes/task-phases.ts`
- Modify: `packages/api/src/app.ts`
- Add: `packages/api/src/__tests__/routes/task-phases.test.ts`

- [ ] **Step 1: Write failing API route tests for task-phase endpoints**

Create `packages/api/src/__tests__/routes/task-phases.test.ts` with tests like:

```ts
it('returns 201 when a valid task phase event is published', async () => {
  // POST /task-phases
  // Assert response includes server-assigned `event_id` + `emitted_at`.
});

it('returns 400 for an invalid phase value', async () => {
  // POST /task-phases with phase: invalid
});

it('returns 200 with the next task phase event from a queue', async () => {
  // GET /task-phases/next/lark-task-phases
});

it('returns 404 when acking an unknown task phase delivery', async () => {
  // POST /task-phases/:queue/:id/ack
});
```

- [ ] **Step 2: Run the API route tests to verify failure**

Run: `npm test --prefix packages/api -- src/__tests__/routes/task-phases.test.ts`
Expected: tests fail because the route does not exist.

- [ ] **Step 3: Add task-phase topology and queue helpers in `RabbitMQService`**

Update `packages/api/src/services/rabbitmq.ts` to:

- assert `DEFAULT_TASK_PHASES_EXCHANGE_NAME`
- assert and bind `DEFAULT_LARK_TASK_PHASES_QUEUE_NAME`
- reuse the existing queue delivery map pattern for task-phase events

No new RabbitMQ access pattern is needed; follow the existing `/results` design closely.

- [ ] **Step 4: Implement `task-phases` routes**

Create `packages/api/src/routes/task-phases.ts` with:

- `POST /task-phases`
- `GET /task-phases/next/:queueName`
- `POST /task-phases/:queueName/:id/ack`

Use the existing results route behavior as the template, including `RabbitMQUnavailableError` handling.

Contract requirement (from design spec):

- `POST /task-phases` must accept a `TaskPhaseEventSubmission` and respond with a full `TaskPhaseEvent`.
- The API must assign `event_id` and `emitted_at` (do not require emitters to generate them).

- [ ] **Step 5: Register the route and run the API tests**

Register the new router in `packages/api/src/app.ts`.

Run: `npm test --prefix packages/api -- src/__tests__/routes/task-phases.test.ts`
Expected: task-phase route tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/services/rabbitmq.ts packages/api/src/routes/task-phases.ts packages/api/src/app.ts packages/api/src/__tests__/routes/task-phases.test.ts
git commit -m "feat(api): add task phase event routes"
```

### Task 3: Emit `received` from the Lark listener

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`

- [ ] **Step 1: Write the failing listener test**

Add a test in `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`:

```ts
it('publishes a received task phase after successful task submission', async () => {
  // accepted lark message -> submitter succeeds -> phase publisher called with phase: received
});
```

Model the publisher as a small dependency so the test can assert the exact call.

- [ ] **Step 2: Run the listener tests to verify failure**

Run: `npm test --prefix packages/daemon/lark-listener -- src/__tests__/message-handler.test.ts`
Expected: new test fails because no phase publisher exists.

- [ ] **Step 3: Add a small task-phase publisher adapter and wire `received` emission**

Introduce a simple HTTP adapter alongside the existing submitter that posts to `/task-phases`.

In `message-handler.ts`:

- emit `received` only after `submitter.submit(...)` returns a `taskId`
- include `task_id`, `task_type`, `task_source`, and `emitted_by: 'lark-listener'`
- keep the phase emit best-effort: log failures and continue

Spec alignment requirement (must-do):

- remove the listener's direct Lark reaction side-effect (today's `OnIt` behavior).
- the listener should not call any Lark reaction API directly after this change; phase reactions are owned by the Lark phase consumer.

- [ ] **Step 4: Run the listener tests to verify they pass**

Run: `npm test --prefix packages/daemon/lark-listener -- src/__tests__/message-handler.test.ts`
Expected: listener tests pass, including `received` phase coverage.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/adapters/task-submitter.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts
git commit -m "feat(lark-listener): emit received task phase"
```

### Task 4: Emit `enriching`, `queued`, and terminal cleanup for enrichment rejections

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Add or Modify: `packages/daemon/task-enrichment/src/adapters/task-phase-publisher.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing enrichment-poller tests**

Add tests that assert:

```ts
it('publishes enriching after a task is accepted for enrichment', async () => {
  // dequeued task -> phase publish with enriching before job creation
});

it('publishes queued after POST /jobs succeeds', async () => {
  // successful job creation -> phase publish queued
});

it('publishes completed before returning an enrichment rejection result', async () => {
  // rejected task clears any intermediate Lark reaction later
});
```

- [ ] **Step 2: Run the enrichment tests to verify failure**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/enrichment-poller.test.ts`
Expected: tests fail because no phase publisher exists.

- [ ] **Step 3: Implement phase publication in `EnrichmentPoller`**

Add a best-effort publisher dependency and emit:

- `enriching` after the task is dequeued and deemed processable
- `queued` after `POST /jobs` returns `201`
- `completed` before publishing a direct rejection result

Do not emit `queued` if job creation fails.

- [ ] **Step 4: Run the enrichment tests to verify they pass**

Run: `npm test --prefix packages/daemon/task-enrichment -- src/__tests__/enrichment-poller.test.ts`
Expected: enrichment tests pass with the new phase sequence.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/adapters/task-phase-publisher.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(task-enrichment): emit enriching and queued phases"
```

### Task 5: Emit `executing` from the task daemon

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts`
- Add or Modify: `packages/daemon/task/src/adapters/task-phase-publisher.ts`
- Modify: `packages/daemon/task/src/__tests__/task-poller.test.ts`

- [ ] **Step 1: Write the failing task-poller test**

Add a test such as:

```ts
it('publishes executing after immediate job ack and before orchestrator.handle', async () => {
  // fetch job -> ack job -> publish executing -> execute -> post result
});
```

Also add a negative test asserting no `executing` event is published when the immediate ACK fails.

- [ ] **Step 2: Run the task-poller tests to verify failure**

Run: `npm test --prefix packages/daemon/task -- src/__tests__/task-poller.test.ts`
Expected: tests fail because no phase publisher exists.

- [ ] **Step 3: Implement the `executing` emission**

After the immediate `/jobs/:sessionId/:jobId/ack` succeeds, publish `executing` before calling `orchestrator.handle(job)`.

Payload should include:

- `task_id`
- `session_id`
- `task_type`
- `task_source`
- the selected executor/model if known from the job
- `emitted_by: 'task-daemon'`

- [ ] **Step 4: Run the task-poller tests to verify they pass**

Run: `npm test --prefix packages/daemon/task -- src/__tests__/task-poller.test.ts`
Expected: task-poller tests pass with the new ordering.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/task-poller.ts packages/daemon/task/src/adapters/task-phase-publisher.ts packages/daemon/task/src/__tests__/task-poller.test.ts
git commit -m "feat(task-daemon): emit executing task phase"
```

### Task 6: Build the Lark phase consumer and reaction mapper

**Files:**
- Add: `packages/daemon/lark-result/src/task-phase-poller.ts`
- Add: `packages/daemon/lark-result/src/adapters/lark-phase-notifier.ts`
- Add: `packages/daemon/lark-result/src/phase-reaction-mapper.ts`
- Modify: `packages/daemon/lark-result/src/index.ts`
- Add: `packages/daemon/lark-result/src/__tests__/lark-phase-notifier.test.ts`

- [ ] **Step 1: Write failing notifier tests for intermediate phases**

Create `packages/daemon/lark-result/src/__tests__/lark-phase-notifier.test.ts` covering:

```ts
it('adds the mapped reaction for received', async () => {});
it('replaces the prior reaction when phase advances', async () => {});
it('clears bot-owned phase reactions on completed without adding a replacement', async () => {});
it('ignores non-lark task sources', async () => {});
it('records a failure marker when reaction updates fail', async () => {});
it('does not remove or mutate non-phase reactions (user or other emojis)', async () => {});
```

- [ ] **Step 2: Run the Lark result tests to verify failure**

Run: `npm test --prefix packages/daemon/lark-result -- src/__tests__/lark-phase-notifier.test.ts src/__tests__/lark-notifier.test.ts`
Expected: new notifier tests fail because the phase consumer does not exist.

- [ ] **Step 3: Implement the phase reaction mapper and notifier**

Add a mapper like:

```ts
export function getReactionForPhase(phase: TaskPhase): string | null {
  switch (phase) {
    case 'received': return 'OnIt';
    case 'enriching': return 'Eye';
    case 'queued': return 'Hourglass';
    case 'executing': return 'Runner';
    case 'completed': return null;
  }
}
```

In `lark-phase-notifier.ts`:

- ignore events whose `task_source?.source !== 'lark'`
- remove any existing **bot-owned phase reaction** previously applied by this feature before applying the new phase
  - only consider reactions in the configured phase-emoji set (the mapper output set)
  - do not remove or mutate user reactions
  - do not use a blanket “remove all reactions” API
- add the mapped reaction for intermediate phases
- on `completed`, only clear reactions
- log and persist metadata events via `LarkHistoryRepository`

Implementation note (must-do for safety):

- add a reusable helper (e.g. `clearBotOwnedPhaseReactions(...)`) that:
  - lists reactions on a message
  - identifies deletable items that correspond to the bot actor AND are in the phase-emoji set
  - deletes only those reaction instances
  - logs and swallows errors (best-effort)
  - records `phase_reactions.attempts[]` metadata for both success and failure

If the current Lark API wrapper does not expose enough information to identify the bot-owned items safely, implement that capability first (per design spec); do not ship a version that risks removing user reactions.

- [ ] **Step 4: Add the poller and wire it into the daemon entrypoint**

Create `task-phase-poller.ts` mirroring the existing result poller:

- `GET /task-phases/next/lark-task-phases`
- call notifier
- `POST /task-phases/lark-task-phases/:id/ack`

Ordering/idempotency guard (recommended in design spec):

- keep a small in-memory monotonic guard keyed by `task_source.message_id` with a short TTL.
- ignore obvious phase regressions (e.g. current `executing`, incoming `queued`).
- still ACK the delivery (best-effort) after logging that it was ignored.

ACK policy (best-effort):

- ACK deliveries even when reaction application fails (after logging + metadata persistence), otherwise the queue can get stuck retrying a permanently failing reaction.

Start the poller from `packages/daemon/lark-result/src/index.ts` using the existing config pattern.

- [ ] **Step 5: Run the Lark result tests to verify they pass**

Run: `npm test --prefix packages/daemon/lark-result -- src/__tests__/lark-phase-notifier.test.ts src/__tests__/lark-notifier.test.ts`
Expected: phase notifier tests pass and existing notifier tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/lark-result/src/task-phase-poller.ts packages/daemon/lark-result/src/adapters/lark-phase-notifier.ts packages/daemon/lark-result/src/phase-reaction-mapper.ts packages/daemon/lark-result/src/index.ts packages/daemon/lark-result/src/__tests__/lark-phase-notifier.test.ts packages/daemon/lark-result/src/adapters/lark-notifier.ts
git commit -m "feat(lark-result): apply reactions from task phase events"
```

### Task 7: Persist phase-reaction observability metadata

**Files:**
- Modify: `packages/shared/src/db/lark-history-repository.ts`
- Modify: `packages/shared/src/__tests__/db/lark-history-repository.test.ts`

No DB schema changes required for V1 (store metadata in existing `lark_messages.metadata_json`).

- [ ] **Step 1: Write the failing repository tests**

Add tests for whichever persistence shape is chosen.

Minimum required coverage:

```ts
it('records outbound phase reaction metadata on success', async () => {});
it('records a phase reaction failure marker', async () => {});
```

- [ ] **Step 2: Run the repository tests to verify failure**

Run: `npm test --prefix packages/shared -- src/__tests__/db/lark-history-repository.test.ts`
Expected: tests fail because the repository has no phase metadata helpers yet.

- [ ] **Step 3: Implement metadata persistence**

Preferred minimal approach:

- add a repository helper that updates (merges) `metadataJson` for the *source message row* by `messageId`:
  - `appendLarkPhaseReactionAttempt(messageId, attempt)`
  - stores under `phase_reactions`:
    - `last`: `{ phase, applied_at, event_id }` (only when a phase reaction is successfully applied or cleared)
    - `attempts`: bounded list (keep last N=20) of `{ phase, action: 'set' | 'clear', ok, at, event_id, error? }`
  - if `metadataJson` is null/invalid JSON, treat it as `{}` and overwrite with the merged object

Only add a schema migration if a later iteration needs a persisted monotonic guard beyond `metadataJson`.

- [ ] **Step 4: Run the repository tests to verify they pass**

Run: `npm test --prefix packages/shared -- src/__tests__/db/lark-history-repository.test.ts`
Expected: repository tests pass with phase metadata coverage.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/db/lark-history-repository.ts packages/shared/src/__tests__/db/lark-history-repository.test.ts
git commit -m "feat(shared): persist lark phase reaction metadata"
```

### Task 8: Emit `completed` from the terminal path and verify the end-to-end phase sequence

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts` or another terminal emitter location chosen during implementation
- Modify: `packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Modify: `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`

- [ ] **Step 1: Add failing tests for terminal cleanup sequencing**

Add tests asserting:

```ts
it('publishes completed when a terminal result is published (success and failure)', async () => {});
it('clears bot-owned phase reactions before posting the final reply text', async () => {});
it('does not remove or mutate non-phase reactions during final cleanup', async () => {});
it('does not leave an intermediate phase reaction after a failure reply', async () => {});
```

- [ ] **Step 2: Run the terminal-path tests to verify failure**

Run: `npm test --prefix packages/daemon/task -- src/__tests__/task-poller.test.ts`
Run: `npm test --prefix packages/daemon/lark-result -- src/__tests__/lark-notifier.test.ts`
Expected: tests fail because `completed` emission/cleanup sequencing is not wired yet.

- [ ] **Step 3: Implement terminal `completed` emission and cleanup reuse**

Choose one terminal emission point and keep it consistent:

- preferred: emit `completed` alongside result publication in `task-poller.ts`

Then update `lark-notifier.ts` to reuse the same cleanup helper without assuming final replies are the only cleanup trigger.

Implementation requirement (must-do):

- replace the existing blanket reaction cleanup in `LarkNotifier` (currently implemented as “remove all reactions”) with the bot-owned phase-reaction cleanup helper described in Task 6.
- update `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts` accordingly so tests assert we only attempt to clear bot-owned phase reactions.

Ordering requirement (from design spec):

- In `LarkNotifier`, clear bot-owned phase reactions (best-effort) **before** posting the final text reply.
- Do not rely on the async `completed` event to arrive before the reply.

- [ ] **Step 4: Run the focused daemon tests to verify they pass**

Run: `npm test --prefix packages/daemon/task -- src/__tests__/task-poller.test.ts`
Run: `npm test --prefix packages/daemon/lark-result -- src/__tests__/lark-notifier.test.ts src/__tests__/lark-phase-notifier.test.ts`
Expected: terminal phase cleanup behavior passes and no final reaction remains.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/task-poller.ts packages/daemon/lark-result/src/adapters/lark-notifier.ts packages/daemon/task/src/__tests__/task-poller.test.ts packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts
git commit -m "feat(task-phases): clear intermediate reactions on completion"
```

### Task 9: Run the package test suites that cover the full feature surface

**Files:**
- Modify as needed based on failures from previous tasks

- [ ] **Step 1: Run the shared and API package suites**

Run: `npm test --prefix packages/shared`
Run: `npm test --prefix packages/api`
Expected: all shared and API tests pass.

- [ ] **Step 2: Run the daemon package suites touched by the feature**

Run: `npm test --prefix packages/daemon/lark-listener`
Run: `npm test --prefix packages/daemon/task-enrichment`
Run: `npm test --prefix packages/daemon/task`
Run: `npm test --prefix packages/daemon/lark-result`
Expected: all touched daemon suites pass.

- [ ] **Step 3: Fix any failing tests and rerun until green**

Stay within the agreed design:

- intermediate reactions only
- no final reaction
- cross-channel event model with Lark-only consumer implementation

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "test(task-phases): verify lark reaction phase flow"
```
