# Immediate Burst Polling For Interval-Based Daemons Implementation Plan

**Goal:** Make interval-based daemon pollers immediately re-poll within the same timer tick after a successful work fetch so ready backlog drains without waiting for the next fixed interval.

**Architecture:** Apply a consistent burst-polling pattern across interval-based pollers: refactor each poller into a single-pass function that returns `{ fetchedWork: boolean }`, then make `start()` run that pass repeatedly with no delay while `fetchedWork` is true, falling back to the normal delayed timer when a pass finds no work. Keep `task-daemon` capacity/backoff semantics local (including its “hit capacity with/without fetched work” interval policy from the design spec), and apply the same fetch-based continuation rule to enrichment and outbound result pollers.

**Tech Stack:** TypeScript, Node.js 20, Vitest, Rush monorepo, existing daemon polling architecture

---

## File Map

| File | Responsibility |
|------|----------------|
| `packages/daemon/task/src/task-poller.ts` | Add burst polling semantics while preserving task-daemon capacity and interval reset rules |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Add focused tests for burst continuation/termination and fetch-based continuation |
| `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` | Cover task-daemon burst behavior alongside capacity-specific semantics |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Add burst loop semantics for `/tasks/next` polling |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Add focused tests for enrichment burst continuation/stopping |
| `packages/daemon/lark-result/src/lark-poller.ts` | Add burst loop semantics for result queue polling |
| `packages/daemon/lark-result/src/__tests__/lark-poller.test.ts` | Add focused tests for lark result burst continuation/stopping |
| `packages/daemon/telegram-outbound/src/telegram-poller.ts` | Add burst loop semantics for telegram outbound result polling |
| `packages/daemon/telegram-outbound/src/__tests__/telegram-poller.test.ts` | Add focused tests for telegram burst continuation/stopping |
| (No shared helper) | Keep changes local to each poller to avoid cross-package churn; share only the pattern |

## Task 1: Finalize the pass-result contract and burst loop shape

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts`
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/lark-result/src/lark-poller.ts`
- Modify: `packages/daemon/telegram-outbound/src/telegram-poller.ts`

- [ ] **Step 1: Define a pass-result contract in each poller that explicitly reports whether the pass fetched work**

```ts
type PollPassResult = {
  fetchedWork: boolean;
};
```

Expected: each in-scope poller has an explicit way to report whether a pass should trigger an immediate follow-up.

- [ ] **Step 2: Standardize a burst-loop template for all four pollers**

Use this as the target structure (adapt naming as needed):

```ts
start(intervalMs: number): void {
  this.running = true;
  const loop = async () => {
    // Burst: keep polling while we keep successfully fetching work.
    while (this.running) {
      const { fetchedWork } = await this.pollPass();
      if (!fetchedWork) break;
    }

    if (this.running) {
      this.timer = setTimeout(loop, intervalMs);
    }
  };
  loop();
}
```

Constraint: burst continuation must be fetch-based (`200` fetch), not end-to-end success.

- [ ] **Step 3: Do not introduce a base class or shared helper**

Expected: the code remains close to current poller structure.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/task/src/task-poller.ts packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/lark-result/src/lark-poller.ts packages/daemon/telegram-outbound/src/telegram-poller.ts
git commit -m "refactor: define burst poll pass contract"
```

## Task 2: Add task-daemon burst polling semantics

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts`
- Test: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Test: `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`

- [ ] **Step 1: Write failing tests for task-daemon burst continuation**

Add tests covering:

- one pass that gets at least one `200` job fetch should report `fetchedWork = true` or equivalent;
- a follow-up pass that finds no dispatchable jobs should stop the burst;
- a pass where all `GET /jobs/next/:session_id` calls return `204` should not continue the burst;
- a pass that fetched a job but later hit ACK failure still counts as work fetched;
- a pass that dispatched work and later reached capacity should stop bursting and schedule the normal base interval.
- a pass that hits capacity *before any successful fetch* should behave like today (increase backoff) and should not trigger burst continuation.

- [ ] **Step 2: Refactor `pollOnce()` into an explicit single-pass function plus burst scheduling loop**

Representative target shape:

```ts
private async pollPass(): Promise<{ fetchedWork: boolean; hitCapacity: boolean }> {
  // current session discovery + fetch loop
}

start(intervalMs: number): void {
  this.basePollInterval = intervalMs;
  this.currentPollInterval = intervalMs;
  this.running = true;

  const loop = async () => {
    let continueBurst = false;
    do {
      const result = await this.pollPass();
      continueBurst = result.fetchedWork && !result.hitCapacity;
    } while (this.running && continueBurst);

    if (this.running) {
      this.timer = setTimeout(loop, this.currentPollInterval);
    }
  };

  loop();
}
```

Expected: task-daemon can burst inside one timer tick without losing its existing control over interval state.

- [ ] **Step 3: Preserve the chosen task-daemon-specific interval rules**

Implement these exact semantics:

- fetch-based continuation means any `200` from `GET /jobs/next/:session_id` counts as work fetched;
- if the pass later reaches capacity after dispatching work, stop bursting immediately;
- if the pass dispatched work and later reached capacity, the next scheduled delay remains the base interval, not an increased backoff;
- keep `resetPollInterval()` in job completion exactly as it behaves today.
- interval update policy when capacity is hit (from the design spec):
  - if the pass hits capacity and did not fetch any work: apply existing backoff increase
  - if the pass hits capacity but did fetch work: do not apply a backoff increase; keep base interval for the next scheduled tick

Note: to make this implementable, the task-daemon pass function should explicitly decide whether to call `increasePollInterval()` or `resetPollInterval()` (or set `currentPollInterval = basePollInterval`) based on its `(hitCapacity, fetchedWork)` pair.

- [ ] **Step 4: Keep existing auth/error behavior unchanged**

Expected: auth failures still stop the poller, and general errors still log and end the pass.

- [ ] **Step 5: Run targeted task-daemon tests**

Run:

```bash
pnpm --filter @local-agent/task-daemon test -- --run src/__tests__/task-poller.test.ts src/__tests__/task-poller-concurrent.test.ts
```

Expected: burst-specific task-daemon tests pass, and existing task-daemon polling tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task/src/task-poller.ts packages/daemon/task/src/__tests__/task-poller.test.ts packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts
git commit -m "feat(task-daemon): add immediate burst polling"
```

## Task 3: Add enrichment burst polling semantics

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing enrichment tests for burst continuation and stopping**

Add tests covering:

- a `200` response from `GET /tasks/next` triggers an immediate follow-up pass;
- a later `204` stops the burst and returns to the timer;
- a `200` fetch followed by downstream failure (job publish failure, result publish failure, or ACK failure depending on the path under test) still counts as fetched work for continuation purposes.

Add one concrete new test case in code (skeleton):

```ts
it('bursts when tasks are available: 200 then 200 then 204', async () => {
  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(createTask({ task_id: 't1' })) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'j1' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(createTask({ task_id: 't2' })) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'j2' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
    .mockResolvedValueOnce({ status: 204 });

  // Prefer: call an extracted `runBurstOnce()` helper used by `start()`,
  // so the test does not need to rely on real timers.
});
```

- [ ] **Step 2: Refactor enrichment polling into a pass function that returns `fetchedWork`**

Representative target shape:

```ts
private async pollPass(): Promise<PollPassResult> {
  const res = await fetch(`${this.apiUrl}/tasks/next`, ...);
  if (res.status === 204) return { fetchedWork: false };
  if (res.status !== 200) return { fetchedWork: false };
  // existing task handling
  return { fetchedWork: true };
}
```

- [ ] **Step 3: Update `start(intervalMs)` to burst until a pass returns `fetchedWork: false`**

Expected: enrichment immediately drains ready tasks while `/tasks/next` keeps returning work.

- [ ] **Step 4: Run targeted enrichment tests**

Run:

```bash
pnpm --filter @local-agent/task-enrichment-daemon test -- --run src/__tests__/enrichment-poller.test.ts
```

Expected: enrichment burst tests and existing enrichment poller tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): add immediate burst polling"
```

## Task 4: Add lark-result burst polling semantics

**Files:**
- Modify: `packages/daemon/lark-result/src/lark-poller.ts`
- Test: `packages/daemon/lark-result/src/__tests__/lark-poller.test.ts`

- [ ] **Step 1: Write failing lark-result tests for burst continuation and stopping**

Add tests covering:

- a `200` response from `GET /results/next/lark-messages` triggers an immediate follow-up pass;
- a follow-up `204` stops the burst;
- a `200` fetch followed by notifier failure still counts as work fetched.

Add one concrete new test case in code (skeleton):

```ts
it('bursts on backlog: 200 then 200 then 204', async () => {
  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ event_kind: 'result', event: sampleResult }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ event_kind: 'result', event: { ...sampleResult, result_id: 'res-2' } }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
    .mockResolvedValueOnce({ status: 204 });

  // Prefer: call an extracted `runBurstOnce()` helper used by `start()`.
});
```

- [ ] **Step 2: Refactor lark-result polling into a pass function returning `fetchedWork`**

Expected: the pass result is determined by fetch response, not downstream notifier success.

- [ ] **Step 3: Update `start(intervalMs)` to continue bursting while `fetchedWork` stays true**

Expected: lark-result drains queued result events faster under backlog.

- [ ] **Step 4: Run targeted lark-result tests**

Run:

```bash
pnpm --filter @local-agent/lark-result-daemon test -- --run src/__tests__/lark-poller.test.ts
```

Expected: burst tests and existing lark poller tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-result/src/lark-poller.ts packages/daemon/lark-result/src/__tests__/lark-poller.test.ts
git commit -m "feat(lark-result): add immediate burst polling"
```

## Task 5: Add telegram-outbound burst polling semantics

**Files:**
- Modify: `packages/daemon/telegram-outbound/src/telegram-poller.ts`
- Test: `packages/daemon/telegram-outbound/src/__tests__/telegram-poller.test.ts`

- [ ] **Step 1: Write failing telegram-outbound tests for burst continuation and stopping**

Add tests covering:

- a `200` response from `GET /results/next/telegram-messages` triggers an immediate follow-up pass;
- a follow-up `204` stops the burst;
- a `200` fetch followed by downstream notifier failure still counts as work fetched.

Add one concrete new test case in code (skeleton):

```ts
it('bursts on backlog: 200 then 200 then 204', async () => {
  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ event_kind: 'result', event: sampleResult }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ event_kind: 'result', event: { ...sampleResult, result_id: 'res-2' } }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
    .mockResolvedValueOnce({ status: 204 });

  // Prefer: call an extracted `runBurstOnce()` helper used by `start()`.
});
```

- [ ] **Step 2: Refactor telegram poller into a pass function returning `fetchedWork`**

Expected: telegram outbound uses the same fetch-based continuation rule as lark-result.

- [ ] **Step 3: Update `start(intervalMs)` to continue bursting while `fetchedWork` stays true**

Expected: telegram outbound drains queued events faster under backlog.

- [ ] **Step 4: Run targeted telegram-outbound tests**

Run:

```bash
pnpm --filter @local-agent/telegram-outbound-daemon test -- --run src/__tests__/telegram-poller.test.ts
```

Expected: burst tests and existing telegram poller tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/telegram-outbound/src/telegram-poller.ts packages/daemon/telegram-outbound/src/__tests__/telegram-poller.test.ts
git commit -m "feat(telegram-outbound): add immediate burst polling"
```

## Task 6: Run cross-poller verification

**Files:**
- Modify: none unless regressions are found
- Test: all four targeted daemon poller suites

- [ ] **Step 1: Run the task-daemon targeted suite again after all poller changes**

```bash
pnpm --filter @local-agent/task-daemon test -- --run src/__tests__/task-poller.test.ts src/__tests__/task-poller-concurrent.test.ts
```

Expected: task-daemon burst semantics and existing concurrency expectations still hold.

- [ ] **Step 2: Run the enrichment targeted suite again after all poller changes**

```bash
pnpm --filter @local-agent/task-enrichment-daemon test -- --run src/__tests__/enrichment-poller.test.ts
```

Expected: enrichment burst semantics and existing task handling behavior still hold.

- [ ] **Step 3: Run the lark-result targeted suite again after all poller changes**

```bash
pnpm --filter @local-agent/lark-result-daemon test -- --run src/__tests__/lark-poller.test.ts
```

Expected: result queue burst semantics and existing phase/result delivery behavior still hold.

- [ ] **Step 4: Run the telegram-outbound targeted suite again after all poller changes**

```bash
pnpm --filter @local-agent/telegram-outbound-daemon test -- --run src/__tests__/telegram-poller.test.ts
```

Expected: telegram burst semantics and existing result/mirror delivery behavior still hold.

- [ ] **Step 5: Commit final fixes if verification uncovered any regressions**

```bash
git add packages/daemon/task/src packages/daemon/task-enrichment/src packages/daemon/lark-result/src packages/daemon/telegram-outbound/src
git commit -m "test: verify burst polling across daemons"
```

## Task 7: Push Branch And Open PR

**Goal:** Publish the change on a feature branch and open a GitHub PR.

**Files:**
- Modify: none

- [ ] **Step 1: Create and switch to a feature branch**

```bash
git checkout -b feat/immediate-burst-polling
```

- [ ] **Step 2: Push branch to origin**

```bash
git push -u origin feat/immediate-burst-polling
```

- [ ] **Step 3: Open a pull request**

Use your standard GitHub flow (`gh pr create` if available, otherwise open via the web UI).

## Review Notes

- This plan intentionally keeps `telegram-inbound-daemon` unchanged.
- This plan intentionally adds no new burst-specific logs.
- Burst continuation is explicitly fetch-based: a successful upstream fetch (`200`) is enough to trigger immediate follow-up even if later handling fails.
- The recommended implementation structure is a shared pattern (no new shared helper module), not a heavy inheritance hierarchy.
