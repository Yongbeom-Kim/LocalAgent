# Mandatory Task Session ID Implementation Plan

**Goal:** Require every queued task to have a canonical `session_id`, with producers generating one before enqueue when they want a fresh session.

**Architecture:** Tighten the `/tasks` intake contract so accepted tasks always carry `session_id`, keep channel-owned canonicalization in Lark/Telegram listeners, and move fresh-session generation for generic/direct producers to the producer side instead of enrichment.

**Tech Stack:** TypeScript, Express, Vitest, UUID generation, RabbitMQ-backed task intake

---

### Task 1: Tighten `/tasks` Validation

**Files:**
- Modify: `packages/api/src/routes/tasks.ts`
- Test: `packages/api/src/__tests__/routes/tasks.test.ts`

- [ ] **Step 1: Reject missing or empty `session_id` at intake**

Update `/tasks` request validation so `session_id` is required and must be a non-empty string for every accepted request.

- [ ] **Step 2: Always include `session_id` on the enqueued task object**

Remove the conditional spread for `session_id` when constructing `Task`.

- [ ] **Step 3: Update route tests for the new contract**

Replace the legacy “returns 201 without session_id/context_ref” assertion with failure cases for missing and empty `session_id`, while keeping success coverage for canonical tasks.


### Task 2: Make Direct Producers Generate Fresh Session IDs

**Files:**
- Modify: `packages/cli/src/commands/submit.ts`
- Test: `packages/cli/src/__tests__/submit.test.ts`

- [ ] **Step 1: Generate a UUID in CLI submit when caller omits `--session-id`**

Use `uuid.v4()` to derive `sessionId = options.sessionId ?? uuidv4()`.

- [ ] **Step 2: Always send `session_id` in CLI task payloads**

Update request body construction to unconditionally include the resolved session id.

- [ ] **Step 3: Update CLI tests**

Assert that both explicit and implicit CLI submissions send `session_id`.


### Task 3: Verify First-Party Producer Compliance

**Files:**
- Review or modify if needed:
  - `packages/daemon/lark-listener/src/adapters/lark-session-resolver.ts`
  - `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
  - `packages/daemon/telegram-inbound/src/adapters/telegram-session-resolver.ts`
  - `packages/daemon/telegram-inbound/src/adapters/telegram-task-submitter.ts`
  - `packages/daemon/task-scheduler/src/submitter.ts`

- [ ] **Step 1: Confirm Lark accepted tasks already resolve `session_id` before submit**

Do not change behavior unless a gap is found.

- [ ] **Step 2: Confirm Telegram accepted tasks already resolve `session_id` before submit**

Do not change behavior unless a gap is found.

- [ ] **Step 3: Confirm scheduler still generates a fresh session id before submit**

Keep current behavior and adjust tests only if the new intake contract requires it.


### Task 4: Remove Sessionless Enrichment Assumptions

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Identify generic intake fallback generation that becomes unreachable**

Remove or tighten normal-path logic that expects a task to reach enrichment without `session_id`.

- [ ] **Step 2: Keep thread-inherited session behavior where it still matters**

Do not break `/status`, `/new`, `/end`, or inherited thread metadata flows.

- [ ] **Step 3: Update enrichment tests**

Remove tests that rely on ordinary task intake generating `session_id` after dequeue, and keep regression coverage for valid phase publishing with preexisting session ids.


### Task 5: Tighten Shared Task Types

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Make `TaskSubmission.session_id` required**

Update shared types so direct callers cannot model a valid enqueue request without `session_id`.

- [ ] **Step 2: Make `Task.session_id` required**

Align the queued task shape with the new intake invariant.

- [ ] **Step 3: Fix compile/test fallout**

Update any first-party callers or tests still relying on optional session ids.


### Task 6: Verify With Targeted Tests

**Files:**
- Test commands only

- [ ] **Step 1: Run API task route tests**

Run: `pnpm --filter @local-agent/api test -- --runInBand packages/api/src/__tests__/routes/tasks.test.ts`

- [ ] **Step 2: Run CLI submit tests**

Run: `pnpm --filter @local-agent/cli test -- --runInBand packages/cli/src/__tests__/submit.test.ts`

- [ ] **Step 3: Run shared type tests**

Run: `pnpm --filter @local-agent/shared test -- --runInBand packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 4: Run enrichment tests if behavior changed**

Run: `pnpm --filter @local-agent/task-enrichment-daemon test -- --runInBand packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

