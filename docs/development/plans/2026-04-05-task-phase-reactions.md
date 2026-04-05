# Task Phase Reactions Implementation Plan

**Goal:** Add an extensible task-phase event model and implement Lark intermediate reactions for `received`, `enriching`, `queued`, and `executing`, with reaction cleanup on `completed` and no final-state reaction.

**Architecture:** Introduce a shared task-phase contract and carry phase updates through a generalized version of the existing results transport rather than a second exchange/queue flow. Existing daemons emit channel-agnostic phase events at the lifecycle boundaries they already own, and the refactored Lark result consumer maps phase events to a single current reaction per thread message while still handling terminal result replies and persisting best-effort observability metadata.

**Tech Stack:** TypeScript, Express, amqplib, Vitest, Drizzle/SQLite, existing LocalAgent daemon packages.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/shared/src/types.ts` | Shared phase constants, ordering helpers, and task-phase event interfaces |
| `packages/shared/src/constants.ts` | Shared event-kind/constants updates for the generalized task-event transport |
| `packages/shared/src/index.ts` | Export the new phase symbols |
| `packages/api/src/services/rabbitmq.ts` | Generalize the existing results exchange/queue contract so it carries discriminated task events while preserving delivery tracking |
| `packages/api/src/routes/results.ts` | Publish, poll, and ACK generalized task events on the existing results route |
| `packages/api/src/app.ts` | Keep the existing results route wired while its payload contract is generalized |
| `packages/api/src/__tests__/routes/results.test.ts` | Route coverage for generalized task-event APIs |
| `packages/daemon/lark-listener/src/message-handler.ts` | Emit `received` phase after accepted task submission |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Assert `received` phase publication |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Emit `enriching`, `queued`, and terminal cleanup phase for rejections |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Assert phase emission sequencing |
| `packages/daemon/task/src/task-poller.ts` | Emit `executing` after immediate ACK and before orchestration |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Assert `executing` emission ordering |
| `packages/daemon/lark-result/src/lark-poller.ts` | Poll generalized task events for Lark and dispatch by event kind |
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

In `packages/shared/src/constants.ts`, add only the shared symbols needed for generalized task-event handling:

```ts
export const TASK_EVENT_KINDS = ['result', 'phase'] as const;
```

Export the new symbols from `packages/shared/src/index.ts`.

- [ ] **Step 4: Run the shared tests to verify they pass**

Run: `npm test --prefix packages/shared -- src/__tests__/types.test.ts`
Expected: shared task-phase tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/constants.ts packages/shared/src/index.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): add task event contract"
```

### Task 2: Generalize the existing results API to carry task events

**Files:**
- Modify: `packages/api/src/services/rabbitmq.ts`
- Modify: `packages/api/src/routes/results.ts`
- Modify: `packages/api/src/app.ts`
- Modify: `packages/api/src/__tests__/routes/results.test.ts`

- [ ] **Step 1: Write failing API route tests for generalized task-event payloads**

Update `packages/api/src/__tests__/routes/results.test.ts` with tests like:

```ts
it('returns 201 when a valid phase task event is published', async () => {
  // POST /results with event_kind: phase
  // Assert response includes server-assigned `event_id` + `emitted_at`.
});

it('returns 400 for an invalid phase value', async () => {
  // POST /results with event_kind: phase and invalid phase
});

it('returns 200 with the next task event from the lark queue', async () => {
  // GET /results/next/lark-messages
});

it('returns 404 when acking an unknown task event delivery', async () => {
  // POST /results/:queue/:id/ack
});
```

- [ ] **Step 2: Run the API route tests to verify failure**

Run: `npm test --prefix packages/api -- src/__tests__/routes/results.test.ts`
Expected: the new phase-event cases fail because the current results route only accepts terminal result payloads.

- [ ] **Step 3: Generalize result transport types and queue helpers in `RabbitMQService`**

Update `packages/api/src/services/rabbitmq.ts` to:

- reuse the existing `results` exchange and bound queues instead of asserting a second phase-specific topology
- generalize the publish/get helpers from terminal `TaskResult` payloads to a discriminated `TaskEvent` union
- reuse the existing queue delivery map pattern for both `phase` and `result` events

No new RabbitMQ access pattern is needed; extend the current `/results` transport in place.

- [ ] **Step 4: Generalize `results` routes**

Update `packages/api/src/routes/results.ts` so:

- `POST /results` accepts both `event_kind: 'result'` and `event_kind: 'phase'`
- `GET /results/next/:queueName` returns either kind of task event from the queue
- `POST /results/:queueName/:id/ack` continues to ACK the queue delivery

Keep the existing terminal result behavior intact while widening validation and serialization for phase events. Preserve `RabbitMQUnavailableError` handling.

Contract requirement (from design spec):

- `POST /results` must accept `TaskPhaseEventSubmission` when `event_kind: 'phase'` and respond with a full `TaskPhaseEvent`.
- The API must assign `event_id` and `emitted_at` for phase events (do not require emitters to generate them).

- [ ] **Step 5: Run the API tests**

Keep `packages/api/src/app.ts` pointing at the same results router.

Run: `npm test --prefix packages/api -- src/__tests__/routes/results.test.ts`
Expected: results route tests pass for both terminal and phase event payloads.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/services/rabbitmq.ts packages/api/src/routes/results.ts packages/api/src/app.ts packages/api/src/__tests__/routes/results.test.ts
git commit -m "feat(api): generalize results transport for task events"
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

Introduce a simple HTTP adapter alongside the existing submitter that posts phase events to `/results` with `event_kind: 'phase'`.

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
- Modify: `packages/daemon/lark-result/src/lark-poller.ts`
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

Refactor `lark-poller.ts` so it continues consuming the existing Lark queue but branches by event kind:

- `GET /results/next/lark-messages`
- dispatch `event_kind: 'phase'` to `lark-phase-notifier`
- dispatch `event_kind: 'result'` to the existing final notifier
- `POST /results/lark-messages/:id/ack`

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
git add packages/daemon/lark-result/src/lark-poller.ts packages/daemon/lark-result/src/adapters/lark-phase-notifier.ts packages/daemon/lark-result/src/phase-reaction-mapper.ts packages/daemon/lark-result/src/index.ts packages/daemon/lark-result/src/__tests__/lark-phase-notifier.test.ts packages/daemon/lark-result/src/adapters/lark-notifier.ts
git commit -m "feat(lark-result): handle phase events on the existing lark queue"
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
git commit -m "feat(lark): clear intermediate phase reactions on completion"
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
git commit -m "test(lark): verify task phase reaction flow"
```
