# Design: Immediate Burst Polling For Interval-Based Daemons

**Date:** 2026-04-09
**Status:** Draft
**Depends on:** Existing interval-based daemon polling loops, per-session task queue discovery, result queue polling, enrichment intake polling

## Problem

Several LocalAgent daemons poll their upstream API on a fixed interval, currently `5000ms` in compose. When upstream already has more than one ready item, the daemon still waits for the next timer tick after successfully fetching one item. That creates an artificial idle gap between immediately-available work items.

Examples:

- `task-daemon` may discover multiple active sessions with ready jobs, dispatch one or more jobs, then wait until the next scheduled timer before checking whether more sessions are already ready.
- `task-enrichment-daemon` may enrich one task and then wait even though `/tasks/next` already has another task available.
- `lark-result-daemon` and `telegram-outbound-daemon` may deliver one result/event and then wait even though the result queue already has more items available.

This is primarily a latency and throughput issue, not a correctness issue. The user expectation is that once a daemon proves there is backlog, it should immediately poll again and drain the ready backlog instead of idling for one full interval.

## Goals

1. Remove the unnecessary fixed-interval gap after a successful fetch from interval-based daemon pollers.
2. Keep the existing fixed-interval idle behavior when no work is available.
3. Preserve poller-specific behavior that already exists today, especially `task-daemon` concurrency/backoff semantics.
4. Keep the implementation small, explicit, and testable.

## Non-Goals

- Changing `telegram-inbound-daemon` update polling semantics.
- Changing `lark-listener-daemon`, which is websocket-driven rather than interval-polled.
- Adding new metrics, counters, or extra logs for burst polling.
- Replacing polling with push-based consumption.
- Redesigning poller inheritance or introducing a heavy abstract base framework.

## Scope

In scope:

- `packages/daemon/task/src/task-poller.ts`
- `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- `packages/daemon/lark-result/src/lark-poller.ts`
- `packages/daemon/telegram-outbound/src/telegram-poller.ts`

Explicitly out of scope:

- `packages/daemon/telegram-inbound/src/telegram-update-poller.ts`
- `packages/daemon/lark-listener/src/index.ts` and dedup cleanup timer

## Desired Behavior

### Definitions

To keep implementation decisions consistent across pollers, this spec uses the following terms:

- **Successful fetch**: the poller receives a `200` response from its upstream “next item” fetch endpoint.
- **Fetched work (pass result)**: a poll pass observed at least one successful fetch. Burst continuation is based on this.
- **Dispatched work (task-daemon only)**: the poller added at least one job promise to `inFlightJobs` for execution.
- **Hit capacity (task-daemon only)**: `inFlightJobs.size >= MAX_CONCURRENT_SESSIONS` at a point where the poller would otherwise try to fetch or dispatch more work.

### Shared burst rule

For every in-scope poller, one timer tick should no longer mean “perform exactly one `pollOnce()` call.” Instead, one timer tick should mean:

1. Call `pollOnce()`.
2. If that pass observed at least one successful work fetch (`200` response from the upstream work-fetch endpoint), immediately call `pollOnce()` again with no timer delay.
3. Continue immediate follow-up passes until a pass observes no successful work fetches.
4. Once no successful fetch occurs, schedule the normal delayed timer again.

This turns a single timer tick into a burst that drains currently-ready backlog.

### What counts as a successful fetch

The continuation trigger is intentionally fetch-based, not end-to-end-success-based.

A poll pass counts as having found work when the poller receives a `200` response from the upstream fetch endpoint that normally means “here is a work item to process,” even if later handling fails.

Chosen rule:

- `task-daemon`: any `200` from `GET /jobs/next/:session_id`
- `task-enrichment-daemon`: any `200` from `GET /tasks/next`
- `lark-result-daemon`: any `200` from `GET /results/next/:queue_name`
- `telegram-outbound-daemon`: any `200` from `GET /results/next/:queue_name`

This matches the user’s explicit preference that the poller should keep draining once backlog is proven, even if downstream handling for a fetched item later fails.

### Empty-pass termination

If a burst pass discovers candidate sessions or reaches the fetch endpoint but all fetch attempts come back empty (`204`, or task-daemon equivalent of no dispatchable job), the burst ends and the poller returns to the normal timer.

There is no extra retry pass for “maybe the discovery endpoint was stale.”

### Logging

No new logs are added purely for burst behavior.

Existing logs remain sufficient:

- fetch/processing logs already show work movement;
- existing warning/error logs already show failures;
- no extra “burst started/stopped” observability is required in v1.

## Poller-Specific Semantics

### 1. Task daemon

`task-daemon` already has special semantics:

- active-session discovery;
- `MAX_CONCURRENT_SESSIONS` cap;
- `currentPollInterval` backoff when the poller hits capacity;
- reset to base interval when a job completes.

These remain local to `task-daemon`.

#### Task-daemon burst rule

Within one burst pass:

1. List active sessions.
2. Iterate sessions until either:
   - session list is exhausted, or
   - `inFlightJobs.size >= maxConcurrency`.
3. A pass is considered successful for burst continuation if any `GET /jobs/next/:session_id` returns `200`, even if the later ACK or execution path fails.
4. If the pass reaches capacity after dispatching work, the burst stops immediately.

Notes:

- “Successful fetch” is intentionally decoupled from successful ACK/execution. A `200` fetch counts as fetched work even if the immediate ACK later fails and execution is refused.
- A pass that only sees already-active sessions (skipped by `activeSessions`) counts as “no work fetched” and ends the burst.
- If capacity is reached before any successful fetch occurs, the pass is treated as “no work fetched” and existing backoff behavior applies.

#### Task-daemon scheduling after a capacity-reaching burst

The user selected this explicit behavior:

- if a burst pass both dispatched work and later hit capacity, the next scheduled timer should still use the normal base interval, because that burst already drained what it could.

This is intentionally different from today’s pure backoff trigger and should be stated clearly in implementation.

To make this implementable without guesswork, the task-daemon interval update policy becomes:

- If a pass **hits capacity** and **did not fetch any work**: keep the existing backoff behavior (increase `currentPollInterval` as today).
- If a pass **hits capacity** but **did fetch work**: do not apply a backoff increase for that pass; keep the interval at the normal base interval for the next scheduled tick.

This preserves the user-selected behavior: do not penalize a productive burst pass that already drained what it could.

#### Task-daemon completion reset

`resetPollInterval()` on job completion remains unchanged.

That means:

- completion still resets the timer state to base interval;
- no extra completion-triggered immediate wakeup is introduced;
- the feature remains about burst polling inside a timer tick, not out-of-band wakeups.

### 2. Enrichment daemon

`task-enrichment-daemon` has a single upstream fetch source: `GET /tasks/next`.

Desired burst semantics:

1. If `/tasks/next` returns `200`, process that task.
2. After processing completes for that pass, immediately fetch again.
3. Continue until `/tasks/next` returns `204` or other non-work response.
4. Then schedule the normal delayed timer.

This keeps burst behavior simple and unbounded while work is continuously available.

### 3. Lark result daemon

`lark-result-daemon` polls `GET /results/next/lark-messages` and handles result, phase, or mirror events.

Desired burst semantics:

1. If `/results/next/lark-messages` returns `200`, process and ACK that event.
2. Immediately poll again.
3. Continue until the fetch returns `204`.

The same fetch-based continuation rule applies even if downstream notification fails, because the queue still demonstrated backlog.

### 4. Telegram outbound daemon

`telegram-outbound-daemon` matches the result-daemon pattern.

Desired burst semantics:

1. If `/results/next/telegram-messages` returns `200`, process and ACK that event.
2. Immediately poll again.
3. Continue until the fetch returns `204`.

## Approaches Considered

### Approach 1: One extra immediate poll only

After a successful fetch, run exactly one additional immediate `pollOnce()` and then always return to the timer.

Why not chosen:

- it improves the “two items ready” case but still leaves delay for longer backlog;
- it treats one immediate retry as a patch rather than actually draining ready work.

### Approach 2: Completion-triggered wakeups

Keep fixed intervals, but trigger an immediate poll when a running job or handler completes.

Why not chosen:

- it is a different trigger model from the user’s requested “two tasks are already queued” case;
- it adds asynchronous wakeup behavior beyond the current polling loop contract.

### Approach 3: Burst polling inside one timer tick

Treat one timer tick as a burst that keeps polling while successful fetches continue.

Why chosen:

- directly matches the desired latency improvement;
- preserves the current architecture and timer ownership;
- small enough to apply consistently to multiple pollers.

## Implementation Shape

### Recommended structure

Use one small shared helper or shared poll-loop pattern for burst scheduling semantics, while keeping poller-specific fetch/dispatch logic inside each poller.

Recommendation rationale:

- avoids duplicating the same “continue burst vs return to timer” logic across four pollers;
- avoids introducing a heavyweight abstract base class into code that does not currently share one;
- lets `task-daemon` keep its unique capacity/backoff policy local.

Concretely, the shared unit should be limited to loop semantics such as:

- invoking one pass function;
- checking whether that pass reported “work fetched”;
- repeating immediately while true;
- scheduling the delayed timer when the burst ends.

The helper should not encode HTTP details, queue names, ACK behavior, or task-daemon-specific capacity logic.

### Pass return contract

To support burst semantics cleanly, each poller pass should expose whether it fetched work.

Representative shape:

```ts
type PollPassResult = {
  fetchedWork: boolean;
};
```

The exact type name is not important, but the contract should be explicit instead of inferred from side effects.

For `task-daemon`, the pass result may also need a small amount of local scheduling detail so it can distinguish:

- no work found;
- work found and drained to non-capacity steady state;
- work found but the pass ended because capacity was reached.

That detail should remain private to the task-daemon implementation unless a second poller actually needs it.

## Failure Handling

The feature should not change existing error policy.

- Auth failures still stop the relevant daemon where that is already the current behavior.
- Non-auth fetch failures still log and end the current pass.
- Downstream processing failures still follow each poller’s existing handling.

Burst continuation is based on whether the pass fetched work, not whether all later downstream operations succeeded.

## Testing Strategy

Add focused unit tests for burst continuation and stopping conditions only.

### Task daemon

Add tests covering:

- immediate continuation when at least one `GET /jobs/next/:session_id` returns `200`;
- burst termination when the next pass finds no dispatchable jobs;
- no continuation when all fetches return empty responses;
- capacity-reaching burst preserving the chosen scheduling semantics;
- existing completion reset behavior remaining intact.

### Enrichment daemon

Add tests covering:

- immediate follow-up when `/tasks/next` returns `200`;
- stopping when the next pass returns `204`;
- continuation despite downstream publish/ACK failure after a successful fetch.

### Lark result daemon

Add tests covering:

- immediate follow-up after a `200` event fetch;
- stopping on `204`;
- continuation despite downstream notify failure after a successful fetch.

### Telegram outbound daemon

Add tests covering:

- immediate follow-up after a `200` event fetch;
- stopping on `204`;
- continuation despite downstream notify failure after a successful fetch.

Timer-driven integration tests for the `start()` loop are intentionally not required in this feature. The existing codebase already tests most poller logic through direct `pollOnce()` calls, and the new work should keep that testing style.

## Risks And Mitigations

### Risk: Busy looping when upstream is perpetually non-empty

For non-capacity pollers, the chosen design intentionally keeps bursting until upstream returns empty. This can produce long bursts under sustained backlog.

Why acceptable in v1:

- this is the desired throughput behavior;
- those pollers already process one item per pass and can naturally drain backlogs faster this way;
- no user requested a hard burst cap.

### Risk: Task-daemon backoff semantics become subtly inconsistent

Task-daemon already has bespoke interval state. Burst continuation could accidentally interact with backoff in surprising ways.

Mitigation:

- keep task-daemon interval policy explicit in code and tests;
- do not over-generalize task-daemon capacity logic into the shared helper.

### Risk: Shared helper becomes an abstraction trap

If the helper grows to include too much poller-specific knowledge, it will make future changes harder.

Mitigation:

- keep the helper narrow and scheduling-only;
- leave fetch/ACK/process behavior inside each poller.

## Acceptance Criteria

1. In-scope pollers immediately perform follow-up polls after successful fetches within the same timer tick.
2. In-scope pollers return to their normal delayed timer when a pass fetches no work.
3. `task-daemon` preserves its existing completion reset behavior.
4. `task-daemon` keeps capacity handling local and does not add completion-triggered wakeups.
5. `telegram-inbound-daemon` remains unchanged.
6. No new burst-specific logs are added.
