# `/kill` Command and In-Flight Executor Termination Design

**Date:** 2026-04-03
**Status:** Draft

## 1. Overview

Add a `/kill` command that can be used inside an existing Lark thread to stop the currently running LocalAgent-managed executor process for that thread's session. The command must not target arbitrary PIDs or other sessions. It preserves the session and workspace so the user can continue the thread afterward.

The existing code has no persistent handle to the active child process for a session. Each executor spawns its own child and waits for completion inline, so a later control command cannot locate or terminate the live process. The design introduces a shared task-daemon cancellation registry plus a common executor-side cancellation interface. Each executor adapter still owns its own spawn details and kill semantics, but all adapters register their live child in a uniform way.

## 2. Goals

- Users can type `/kill` in a Lark thread to stop the currently running executor child for that thread session.
- `/kill` is thread-only, like `/new` and `/end`.
- `/kill` never targets arbitrary OS processes or other sessions.
- Session metadata and workspace remain intact after kill.
- Kill behavior is consistent across killable executors: send `SIGTERM`, wait up to 15 seconds, then send `SIGKILL` if the child is still alive.
- Kill results are reported back to the thread with captured stdout/stderr up to the kill point and a clear signal-path summary.
- If no active process exists, `/kill` returns success with `No active process`.

## 3. Non-Goals

- Killing setup-hook subprocesses.
- Killing built-in executors such as cleanup.
- Canceling queued same-session jobs.
- Targeting arbitrary PIDs, arbitrary sessions, or historical jobs.
- Introducing a richer result transport than the existing text reply path.

## 4. Command and Pipeline Shape

### 4.1 External command contract

Add `/kill` to `COMMANDS.md` with these semantics:

- Grammar: `/kill`
- Valid context: thread reply only
- Invalid forms: any root use, any trailing arguments, any extra content
- Accepted behavior: stop the active managed process for the current thread session, if one exists
- Session remains alive after `/kill`

Thread reply help text should become `Thread replies must be natural language, /new, /end, or /kill.` and thread-only command rejections should include `/kill` where relevant.

### 4.2 Internal task type

Add a new control task type: `kill`.

Flow:

1. Lark listener parses `/kill` and submits `task_type: 'kill'`, empty payload.
2. Enrichment poller validates that the command is used inside a thread and inherits the thread `session_id`.
3. Enrichment produces a `kill` job routed to the built-in executor path, not to an agent CLI.
4. Task poller allows the kill job to run without waiting on the same-session lock.
5. Task orchestrator resolves the kill request against the active-process registry for that session.
6. Lark result daemon replies with a normal text result containing status, signal path, and captured output.

This mirrors `/end`: it stays inside the normal pipeline and keeps auditability and result reporting uniform.

### 4.3 Thread-only enforcement location

The Lark listener does not know whether a message is in a recoverable bot thread. Like `/new` and `/end`, it should only parse `/kill` syntactically and submit the task. Thread-only enforcement remains in enrichment after thread lookup.

That means a root `/kill` is handled as follows:

1. listener parses and submits `task_type: 'kill'`
2. enrichment detects `kind === 'not_thread'`
3. enrichment publishes the standard thread-only rejection: `The /kill command can only be used inside a thread.`

This keeps command-context validation aligned with the current architecture.

## 5. Architecture

### 5.1 Shared active-process registry

Introduce a task-daemon service responsible for exactly one active kill target per session:

- Keyed by `session_id`
- Stores only the currently live killable executor attempt
- Replaced atomically when executor fallback moves from one child to another
- Cleared when the child exits or registration scope ends

Stored metadata should include:

- `session_id`
- `job_id`
- `task_id`
- `executor`
- `executor_model`
- a kill handle owned by the executor adapter
- accessors for captured `stdout` and `stderr` buffers up to the current point

This registry exists only in the task-daemon process. `/kill` is defined as killing the currently active managed process in that daemon for the inherited session.

### 5.2 Session lock interaction

`/kill` cannot be treated exactly like a normal same-session job, because the current task poller acquires the session lock before execution. If a long-running executor is holding the lock, a queued `kill` job for the same `session_id` would otherwise be NACKed and requeued until the original job finishes, which defeats the feature.

Design decision: `kill` jobs bypass same-session lock acquisition in `TaskPoller`.

- normal jobs keep the existing `SessionLockManager.acquire()` behavior
- `kill` jobs are dispatched immediately without acquiring the session lock
- `kill` jobs also skip lock release in the `finally` path because they never owned the lock
- the active job continues to own and release the session lock as usual when its child exits after cancellation

This is the narrowest change that preserves the current pipeline while making `/kill` effective.

Current-scope assumption: v1 targets the current task-daemon process that owns the active executor child. Multi-daemon active-execution routing is out of scope for this feature.

### 5.3 Shared executor cancellation contract

Extend the task-daemon executor contract so killable executors participate in a common lifecycle. The contract should stay narrow:

- executors still expose `execute(job, env)`
- killable executors receive shared runtime services needed to register an active child
- each adapter implements its own `kill` behavior for its child handle, behind a common shape

Recommended shape:

- add a task-daemon service layer such as `active-execution-registry.ts`
- add an executor helper or interface for registering a live child and providing a `terminate(graceMs)` method
- keep built-in executors outside this contract; they simply never register a kill target

This preserves your requirement that each executor adapter implement its own kill, while still giving the orchestrator one uniform way to invoke cancellation.

### 5.4 Why not `.kill()` directly?

Calling `child.kill()` with no signal is not sufficient for the intended behavior because:

- default signal handling is implicit rather than explicit
- the required UX is deterministic `SIGTERM`, then `SIGKILL` after 15 seconds
- the system must report which path occurred
- the system must avoid guessing whether a process already exited during the grace window

Design decision: use explicit signals.

- First: `child.kill('SIGTERM')`
- Wait up to `15_000ms`
- If still running: `child.kill('SIGKILL')`
- If the process exits during the grace period, report that as a successful kill outcome

## 6. Detailed runtime behavior

### 6.1 Killable executors

Killable in v1:

- `claude`
- `claude-w`
- `cursor`
- `ttcodex`

Not killable in v1:

- setup-hook subprocesses
- `builtin` executor work such as cleanup
- `gc` built-in execution path

If `/kill` is issued while only a non-killable path is active, the result is success with `No active process`.

### 6.2 Registration lifecycle

For each killable executor attempt:

1. Spawn child.
2. Start capturing stdout/stderr buffers.
3. Register the live child in the shared registry under `session_id`.
4. On normal exit, spawn error, or cancellation completion, unregister if the registry still points to that same child.

The active record must be identity-safe and explicit about buffer ownership:

- `register()` returns an opaque token or identity handle
- `unregister(sessionId, token)` clears only if the active entry still matches that token
- the record exposes read access to the current stdout/stderr buffers without waiting for the executor promise to resolve
- truncation still happens at final `TaskResultSubmission` time, but the live buffers used by `/kill` should be bounded in-memory using the same byte-limit discipline as normal executor output capture

Executor fallback behavior is important:

- if `continue` mode is active, the registry points at the `continue` child only while it is live
- if `continue` fails and the adapter falls back to fresh execution, the old registration is cleared and the fresh child becomes the new active target
- there is never more than one active kill target per session

### 6.3 Process tree signaling

Agent CLIs may spawn subprocess trees. Directly signaling only the immediate child may leave grandchildren alive.

Design requirement for killable executors:

- spawn the child in a killable process-group configuration that allows terminating the whole executor tree on supported platforms
- on POSIX, prefer signaling the process group rather than only the direct child
- if an executor cannot guarantee whole-tree termination in its environment, document it as best-effort and keep the adapter-local kill behavior explicit

The implementation plan should treat process-tree termination as part of executor kill correctness, not an optional enhancement.

### 6.4 Kill task execution

When the orchestrator handles a `kill` job:

1. Skip environment setup, same as other built-in control paths.
2. Query the active-process registry for `job.session_id`.
3. If missing, return a successful result with `stdout: No active process` and empty `stderr`.
4. If present, invoke the registered kill handle.
5. Wait for the kill result summary from the adapter/runtime helper.
6. Return a successful `TaskResultSubmission` with:
   - `task_type: 'kill'`
   - `session_id`
   - `stdout` containing a structured summary and captured process output up to the kill point
   - `stderr` containing captured stderr up to the kill point

All terminal kill outcomes are `status: 'success'`:

- active child terminated after `SIGTERM`
- active child needed `SIGKILL`
- child exited naturally during grace window after `SIGTERM`
- no active process

Unexpected internal kill failures, such as an exception while signaling, are regular `failure` results.

### 6.5 Result formatting

Use the existing text result path. Add a structured summary at the top of `stdout`, for example:

```text
Kill outcome: terminated active process
Executor: claude
Model: sonnet
Signal path: SIGTERM -> exited
Wait duration: 842ms
Captured stdout:
...
```

Or:

```text
Kill outcome: terminated active process
Executor: cursor
Model: auto
Signal path: SIGTERM -> SIGKILL
Wait duration: 15000ms
Captured stdout:
...
```

Or:

```text
Kill outcome: no-op
No active process
```

`stderr` should remain the raw captured stderr up to the kill point so the notifier can continue showing it in the existing result model.

`exit_code` for `/kill` results should be normalized to `0` for successful kill/no-op outcomes. The killed child's own exit code or terminating signal should be described in the summary text rather than surfaced as a failing `/kill` result.

## 7. File-level design

### 7.1 Command parsing and routing

Modify:

- `COMMANDS.md`
- `packages/daemon/lark-listener/src/message-handler.ts`
- `packages/shared/src/routing-errors.ts`
- `packages/shared/src/types.ts`
- `packages/api/src/routes/tasks.ts`

Changes:

- parse `/kill` exactly like `/end`: bare command only
- reject `/kill anything`
- add `kill` to control task types
- allow explicit executor/model omission for `kill` like other control tasks
- add thread-only error messaging for `/kill`

### 7.2 Enrichment

Modify:

- `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- `packages/daemon/task-enrichment/src/enrichment-service.ts`
- `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` only if command allowlists or fences need adjustment
- `packages/daemon/task-enrichment/config/builtin.yaml`

Behavior:

- `kill` is thread-only and requires Lark task source plus inherited session
- `kill` does not prepend thread context
- `kill` uses built-in execution routing, similar to cleanup
- unlike `/new`, `/kill` does not change task type inheritance or session state

### 7.3 Task-daemon runtime

Create:

- `packages/daemon/task/src/services/active-execution-registry.ts`
- optional helper such as `packages/daemon/task/src/services/killable-process.ts`

Modify:

- `packages/daemon/task/src/ports/task-executor.ts`
- `packages/daemon/task/src/core/task-orchestrator.ts`
- `packages/daemon/task/src/task-poller.ts`
- `packages/daemon/task/src/adapters/claude-executor.ts`
- `packages/daemon/task/src/adapters/claude-w-executor.ts`
- `packages/daemon/task/src/adapters/cursor-executor.ts`
- `packages/daemon/task/src/adapters/ttcodex-executor.ts`
- `packages/daemon/task/src/adapters/cleanup-executor.ts` only if constructor signatures need alignment

Behavior:

- orchestrator owns one shared registry instance
- task poller dispatches `kill` jobs without acquiring the same-session lock
- killable adapters register their active child with live output accessors
- kill jobs are resolved by a built-in orchestrator path, not by spawning another CLI
- cleanup and setup-hook remain outside kill handling

### 7.4 Result reporting

Modify:

- `packages/daemon/lark-result/src/adapters/lark-notifier.ts` only if minor wording changes are needed

No schema change is required. The existing result payload can carry the kill summary via `stdout` and the captured stderr via `stderr`.

## 8. Alternatives considered

### Approach 1: Directly call `.kill()` inside `/kill` command handler

Rejected.

- no shared session lookup for the active child
- command handler is in the listener process, not the task-daemon process where the child exists
- does not fit the existing pipeline or audit trail
- does not support the required explicit `SIGTERM` then `SIGKILL` behavior cleanly

### Approach 2: Session lock file stores PID and `/kill` signals the PID from another daemon

Rejected.

- violates the requirement to target only the LocalAgent-managed active process in-memory
- PID-based cross-process signaling is brittle and can hit stale or reused PIDs
- does not preserve access to captured stdout/stderr buffers up to kill point

### Approach 3: Orchestrator-level shared registry plus per-adapter kill implementation

Chosen.

- keeps kill scope aligned with the running task-daemon process
- preserves captured output and executor metadata
- keeps adapter-specific spawn details inside the adapter
- provides one uniform cancellation contract across executors

## 9. Risks and mitigations

- Race: `/kill` arrives just as the child exits.
  Mitigation: registry lookup and unregister must be identity-checked; missing or already-finished target returns `No active process` or a successful grace-window exit.

- Race: `/kill` and fallback child replacement happen concurrently.
  Mitigation: registration replacement and unregister must be token-based so a stale `continue` child cannot clear the newer `fresh` child entry.

- Executor fallback swaps child handles while `/kill` is issued.
  Mitigation: registry replacement is atomic per session and always points to exactly one active child.

- Deployment risk: another daemon process consumes the `kill` job.
  Mitigation: v1 explicitly assumes the active child and `kill` request are handled within the same task-daemon process. If the deployment later becomes multi-daemon, `/kill` needs daemon affinity or an out-of-band control channel.

- Signal delivery succeeds but close event is delayed.
  Mitigation: central helper waits on process exit with explicit timeout and reports escalation path.

- Output grows large before kill.
  Mitigation: keep using existing truncation limits on final submission; registry buffers can append normally and final result truncation remains the outer cap.

## 10. Acceptance criteria

- `/kill` is accepted only as a bare thread reply.
- listener only parses `/kill`; enrichment remains the thread-only enforcement point.
- `/kill` inherits the current thread session and never targets another session.
- if a long-running executor is active for a session, `/kill` stops it promptly without waiting for same-session lock release.
- Killable executors register one active child per session.
- `/kill` sends `SIGTERM`, waits 15 seconds, then sends `SIGKILL` if needed.
- If the child exits during the grace period, the result is successful and reported as such.
- If nothing killable is active, the result is successful with `No active process`.
- Session remains reusable after `/kill`.
- Built-in cleanup and setup hooks are not kill targets.
- Result replies include clear signal-path reporting and captured output up to the kill point.
- Process-tree termination is handled explicitly by each killable executor adapter rather than assuming direct-child `.kill()` is sufficient.
