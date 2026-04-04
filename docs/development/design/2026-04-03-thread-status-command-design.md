# Design: Thread `/status` Command for Live Executor Presence

**Date:** 2026-04-03
**Status:** Draft
**Depends on:** Lark thread reply routing (implemented), thread state inheritance (implemented), singleton task-daemon per machine (assumed)

## Problem

Users working inside a bot thread currently have no cheap way to ask whether the thread's executor is still actively running. The existing thread controls are:

- natural-language continuation, which creates more work;
- `/new`, which starts a new session instance;
- `/end`, which cleans up the current session.

There is no thread-only command that reports the live execution state of the current inherited session. As a result, users cannot distinguish "the agent is still working" from "the last turn is done and safe to continue" without inspecting logs or waiting for another bot reply.

## Goal

Add a new thread-only slash command, `/status`, that replies in the same thread with the existing result metadata header block and a human-readable running/not-running message in the output section:

- `Executor is running`
- `Executor is not running`

The status answer must come from live task-daemon state, not from inferred job/result history.

## User Decisions

- `/status` is valid only in a thread reply.
- V1 reports only running vs not running.
- The reply keeps the current Lark result header format.
- Source of truth is task-daemon state.

## Assumption

This design explicitly assumes a singleton task-daemon per machine. The live running-state check is process-local and is only correct if one task-daemon process owns execution for that machine's sessions.

This is acceptable for the current system because the user approved the singleton-per-machine model. If the deployment later becomes multi-replica per machine, this design must be revisited.

## Non-Goals

- Reporting queued, failed, or completed lifecycle states.
- Changing root-message command behavior.
- Introducing a general-purpose job status dashboard.
- Solving cross-process or multi-replica task-daemon coordination beyond the singleton assumption.
- Changing the existing result reply header schema.

## Approaches Considered

### Approach 1: Task-daemon live status endpoint backed by in-memory session state

Expose a small API from the task-daemon that answers whether a given `session_id` is currently executing. The enrichment daemon resolves thread state, calls the endpoint, and publishes a synthetic result reply that preserves the existing header block.

**Why chosen:**

- matches the explicit "task daemon state" requirement;
- uses the state the daemon already maintains while jobs are in flight;
- avoids teaching the enrichment daemon about task-daemon lock-file internals;
- keeps `/status` semantics aligned with the actual executor lifecycle.

### Approach 2: Enrichment daemon inspects shared session lock files directly

Thread enrichment would recover `session_id`, then read the session `.lock` file under `SESSION_BASE_DIR` to infer whether execution is in progress.

**Why not chosen:**

- couples enrichment to task-daemon implementation details;
- answers "is a live lock present" rather than directly asking the task daemon;
- makes future lock-format changes part of the `/status` contract accidentally.

### Approach 3: Infer status from job/result history

Use jobs/results in RabbitMQ or persisted result events to guess whether work is still running.

**Why not chosen:**

- rejected by user requirement;
- stale or ambiguous for in-progress work;
- answers workflow history, not live executor state.

## Design

### 1. External command contract

**File:** `COMMANDS.md`

Add a new section:

```text
/status
```

Rules:

- valid only in thread replies;
- no arguments or trailing content;
- root-message use is context invalid;
- `/status foo` is shape invalid.

Also update thread-reply help text so `/status` appears alongside natural language, `/new`, and `/end`.

### 2. Lark listener parses `/status` into a dedicated control task

**File:** `packages/daemon/lark-listener/src/message-handler.ts`

Add `/status` parsing parallel to `/new`, `/end`, and `/gc`.

Behavior:

- bare `/status` submits a control task, recommended internal `task_type: 'status'`;
- `/status` with trailing args or extra content returns the same usage-hint path used by other malformed commands;
- `/statusfoo` remains invalid, not a command match.

The listener still does not know whether the message is in a thread. Thread-vs-root validation remains in enrichment, following existing command architecture.

Note: update the listener usage-hint string so `/status` is discoverable when the user sends a malformed command.

### 3. Shared routing helpers and control-task typing include `/status`

**Files:**

- `packages/shared/src/types.ts`
- `packages/shared/src/routing-errors.ts`
- `packages/shared/src/index.ts`

Changes:

- add `'status'` to `CONTROL_TASK_TYPES`;
- widen thread-help text from `natural language, /new, or /end` to `natural language, /status, /new, or /end`;
- add a thread-only formatter that can emit a `/status`-specific root rejection message.

This keeps the command contract centralized and avoids hard-coding inconsistent thread help strings across daemons.

### 4. Task daemon exposes live running-state check

**Files:**

- `packages/daemon/task/src/task-poller.ts`
- `packages/daemon/task/src/task-daemon.ts`
- `packages/api/src/routes/...` is not the right home for the state itself; the API remains a transport layer.

`TaskPoller` already tracks live execution via:

- `inFlightJobs: Map<string, Promise<void>>`
- `activeSessions: Set<string>`

Add a small read-only method such as:

- `isSessionActive(sessionId: string): boolean`

This method should reflect whether the session is currently executing in that task-daemon process.

Then expose a small HTTP endpoint from the task-daemon process, recommended shape:

- `GET /status/:sessionId`
- response `{ session_id, running }`

Design constraints:

- expose it on the internal daemon network, not as a public user-facing API;
- minimal read-only surface;
- no dependency on API or RabbitMQ for the answer;
- task-daemon remains the owner of this state.

The exact port can come from a new env/config value with a documented default.

Important deployment note: `task-enrichment-daemon` and `task-daemon` are separate services in this repo, so `localhost` is not the correct transport boundary between them. The status lookup must use an internal service URL such as `http://task-daemon:<port>` (compose service-to-service) or an equivalent configurable daemon-to-daemon base URL.

Configuration (recommended):

- `TASK_DAEMON_STATUS_PORT` (task-daemon bind port, default `7070`)
- `TASK_DAEMON_STATUS_URL` (task-enrichment base URL; examples: `http://task-daemon:7070` in Compose, `http://127.0.0.1:7070` for local bare-metal or single-host dev)

`docker-compose.yml` should set these env vars for the two services (without publishing the port to the host).

### 5. Enrichment daemon owns thread `/status` semantics

**File:** `packages/daemon/task-enrichment/src/enrichment-poller.ts`

Add a `/status` control-task branch near other control task handling.

Flow:

1. Recover thread metadata using the existing `ThreadContextFetcher`.
2. Reject root `/status` using the same thread-only rejection pattern as `/new` and `/end`.
3. If thread metadata is incomplete and no inherited `session_id` is available, publish a rejection result.
4. Call the task-daemon internal status endpoint with the inherited `session_id`.
5. Publish a synthetic result reply through `/results`, not `/jobs`.
6. ACK the task.

This is intentionally not a real execution job. `/status` is a query, not work for an executor.

Implementation constraints:

- task-enrichment should apply a short timeout (recommended <= 1s) when calling the status endpoint so `/status` does not hang the enrichment poll loop.
- task-enrichment must use the configured base URL (for example `TASK_DAEMON_STATUS_URL`) rather than hard-coding `localhost`.

### 6. Reply formatting preserves current metadata headers

**Files:**

- `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- `packages/daemon/lark-result/src/adapters/lark-notifier.ts`

The user asked to keep the current reply headers. The cleanest way is to publish a normal result object that already contains:

- inherited `executor`
- inherited `executor_model`
- inherited `task_type`
- inherited `session_id`
- current `task_id`
- synthetic `job_id`
- `status`
- `exit_code`

and set `stdout` to either:

- `Executor is running`
- `Executor is not running`

This reuses the existing `LarkNotifier` formatting with no `/status`-specific notifier branch.

Recommended values:

- `task_type`: inherited thread task type, not `'status'`, so reply headers stay aligned with the thread's actual executor context;
- `job_id`: reuse `task.task_id` or a synthetic deterministic id, consistent with existing enrichment-side rejection results;
- `status`: `'success'` when the status lookup succeeds;
- `exit_code`: `0` for successful lookup, `null` or failure path only if the lookup itself fails.

### 7. Failure handling

`/status` has three failure classes:

1. **Wrong context**
   Root-message `/status` should reply with a thread-only error.

2. **Missing thread state**
   If thread recovery succeeds but no inherited `session_id` is available, reply with a failure message such as: `The /status command requires an existing session in this thread.`

3. **Task-daemon status lookup failure**
   If the local status endpoint is unreachable or errors, publish a failure result stating that live executor status could not be checked.

These remain result replies in thread so the user gets immediate feedback.

## Data Flow

```text
Lark thread reply `/status`
  -> lark-listener submits task_type `status`
  -> enrichment fetches thread context
  -> enrichment inherits session_id/executor/model/task_type
  -> enrichment calls task-daemon status endpoint (internal daemon URL)
  -> enrichment publishes synthetic result
  -> lark-result-daemon replies in thread with normal header block
     plus `Executor is running` or `Executor is not running`
```

## Testing Strategy

### Lark listener

- bare `/status` submits `task_type: 'status'`;
- `/status foo` returns usage;
- `/statusfoo` is not treated as `/status`.

### Shared routing helpers

- thread-help text includes `/status`;
- thread-only formatter supports `/status`.

### Enrichment poller

- rejects `/status` outside thread;
- rejects `/status` when thread session metadata is missing;
- publishes success result with inherited headers and `Executor is running` when endpoint returns running;
- publishes success result with inherited headers and `Executor is not running` when endpoint returns false;
- publishes failure result when endpoint errors.

### Task daemon

- `TaskPoller.isSessionActive()` reflects active session lifecycle accurately;
- active while a job promise is in flight;
- inactive after the finally-block removes the session;
- status endpoint returns expected JSON and handles unknown sessions as `running: false`.

### Cross-daemon integration

- enrichment uses configured task-daemon status base URL, not `localhost`;
- request timeout/error handling is covered;
- container-to-container path works with current compose-style service separation.

### Command contract docs

- `COMMANDS.md` documents `/status` grammar, valid context, and invalid forms.

## Files Expected to Change

| File | Change |
|------|--------|
| `COMMANDS.md` | Add `/status` external contract |
| `packages/daemon/lark-listener/src/message-handler.ts` | Parse `/status` |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Add `/status` parser coverage |
| `packages/shared/src/types.ts` | Add `status` control task type |
| `packages/shared/src/routing-errors.ts` | Add `/status` to thread-help and thread-only errors |
| `packages/shared/src/index.ts` | Re-export any new helpers/types |
| `packages/daemon/task/src/task-poller.ts` | Expose active-session query |
| `packages/daemon/task/src/task-daemon.ts` | Start internal task-daemon status endpoint (HTTP server) |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` and/or new endpoint tests | Verify active-session behavior and endpoint responses |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Add `/status` handling |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Add `/status` behavior coverage |

## Risks

- The singleton assumption is explicit. Multi-replica task-daemon deployment would make process-local status incomplete.
- A separate internal daemon endpoint adds a small integration surface that needs timeout and error handling.
- Reusing inherited `task_type` in the reply headers is intentional for continuity, but implementers must avoid accidentally exposing `task_type: status` in the final thread message.

## Recommendation

Proceed with a thread-only `/status` control task whose semantics are owned by the enrichment daemon and whose running/not-running answer is fetched from an internal task-daemon status endpoint (reachable from task-enrichment via a configurable daemon-to-daemon URL) backed by `TaskPoller.activeSessions`.

This is the smallest design that matches the requested UX, preserves the current reply headers, and stays faithful to the user's requirement that the answer come from live task-daemon state.
