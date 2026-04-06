# Design: Executor Availability Precheck

**Date:** 2026-04-06
**Status:** Ready for implementation planning
**Impacts:** task-daemon executor port, task orchestrator fallback flow, per-executor adapter tests

## Problem

The task daemon currently discovers missing executor binaries too late.

Today the flow is:

1. `TaskOrchestrator` selects an executor preference.
2. The executor starts its normal `execute(...)` path.
3. The first subprocess spawn fails if the required binary is not available in `PATH`.
4. The failure is reported through the same generic spawn-error path as other runtime failures.

That has two gaps:

- the core orchestration layer has no explicit fail-fast readiness boundary for executor availability;
- there is no dedicated executor-port hook for future quick checks beyond binary presence.

## Goal

Add a fail-fast precheck to the executor port so the orchestrator can validate executor availability before each executor attempt.

The feature should:

1. add a new executor-port method for a quick readiness check;
2. have the orchestrator call that method before each executor preference attempt;
3. make current external executors use `command -v` against their required binaries in `PATH` (POSIX);
4. return a structured precheck result instead of throwing;
5. treat a failed precheck exactly like an executor failure for fallback purposes;
6. keep builtin cleanup in the contract with a no-op success precheck for now.

Precheck is explicitly:

- fast (single-digit subprocesses), non-throwing, and side-effect free;
- local-only in V1 (no network/auth/model availability checks);
- used only to fail fast on obvious unavailability (missing dependencies in `PATH`).

## User Decisions

- The core logic must run the precheck before each executor attempt.
- All executors must implement the new executor-port method.
- A failed precheck is treated as a normal executor failure, so later executor preferences still run.
- The precheck result should be structured, not exception-based.
- Required binaries and precheck logic stay inside each executor implementation.
- No shared precheck utility is needed; duplicated tiny helper logic inside executors is acceptable.
- The design should leave room for future non-binary quick checks.
- Executors may choose whether to fail on first missing dependency or report all missing dependencies.
- For the current executors, all missing binaries should be reported.
- Error copy should stay simple.
- The orchestrator should emit an explicit precheck log, but control flow stays identical to ordinary executor failure.
- Builtin cleanup should implement the method now as a no-op success, leaving room for future minimal config checks later.

## Non-Goals

- No daemon-startup-wide executor scan.
- No new task result status, precheck status, or retry class.
- No config-driven executor dependency registry.
- No shared helper module for dependency checks.
- No install guidance or long remediation text in failure messages.
- No change to executor preference ordering.
- No change to the executor-internal continue-vs-fresh execution flow.

## Existing Context

### 1. The executor port only exposes `execute`

`packages/daemon/task/src/ports/task-executor.ts` currently defines:

```ts
export interface TaskExecutor {
  execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission>;
}
```

There is no port-level readiness method, so the orchestrator cannot fail fast without directly knowing executor-specific binary names.

Note: `TaskResultSubmission` already supports optional `executor` and `executor_model` fields, and `TaskOrchestrator` currently annotates executor results with those fields.

### 2. The orchestrator already owns fallback semantics

`packages/daemon/task/src/core/task-orchestrator.ts` already:

- iterates executor preferences in order;
- annotates the result with `executor` and `executor_model`;
- logs when one preference fails and the next will be tried.

That makes it the correct place to run a port-level precheck and translate a failed precheck into the same failure/fallback path used for normal execution failures.

### 3. Current executors depend on `PATH` binaries

Current external executors ultimately spawn these binaries:

- `ClaudeExecutor` -> `claude`
- `ClaudeWExecutor` -> `claude-w`
- `CursorExecutor` -> `agent`
- `TTCodexExecutor` -> `ttadk`

`CleanupExecutor` performs local filesystem and SQLite cleanup and does not currently depend on a command in `PATH`.

## Approaches Considered

### Approach 1: Port-level structured precheck, orchestrator-owned invocation (recommended)

Add `precheck(...)` to the `TaskExecutor` port. The orchestrator calls it before `execute(...)`. Each executor owns its own quick checks and returns a small structured result.

**Pros**

- Matches the requirement that the core logic invokes the check through the port.
- Keeps executor-specific dependency knowledge inside the executors.
- Leaves a clean extension point for future non-binary quick checks.
- Preserves the orchestrator's existing fallback logic.

**Cons**

- Requires touching every executor implementation and its tests.
- Introduces some duplicated tiny helper code across executors.

### Approach 2: Orchestrator-side executor dependency registry

Keep the port unchanged and let `TaskOrchestrator` own a map from executor type to required binaries.

**Pros**

- Smaller interface change.
- Less duplicated check code.

**Cons**

- Violates the decision that all executors expose the check through the port.
- Couples orchestrator core logic to executor-specific dependency details.
- Makes future non-binary executor checks awkward.

### Approach 3: Let each executor self-check inside `execute()`

Each executor performs `command -v` at the top of its own `execute()` method.

**Pros**

- Minimal code churn.
- No interface change.

**Cons**

- Fails the requirement that the core logic runs the precheck.
- Blurs fail-fast readiness with normal execution flow.
- Makes explicit precheck logging and dedicated fallback reasoning weaker.

## Recommended Approach

Adopt **Approach 1**.

The executor port gains a structured `precheck(...)` method. The orchestrator invokes it immediately before each executor preference attempt. A failed precheck is converted into the same `TaskResultSubmission` failure shape used for ordinary executor failures, then fallback proceeds unchanged.

## Design

### 1. Extend the executor port with a structured precheck result

Update `packages/daemon/task/src/ports/task-executor.ts` so the port includes:

```ts
export type ExecutorPrecheckResult =
  | { ok: true }
  | { ok: false; stderr: string };

export interface TaskExecutor {
  precheck(env: ExecutionEnvironment): Promise<ExecutorPrecheckResult>;
  execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission>;
}
```

Design constraints:

- The result stays intentionally small.
- The failure branch carries only a human-readable message; the orchestrator will forward it into `TaskResultSubmission.stderr`.
- No shared precheck status enum is added.

Error-handling contract:

- Executors should not throw from `precheck(...)`.
- The orchestrator still treats a thrown precheck error as `{ ok: false }` (see below) so fallback behavior is robust.

### 2. Orchestrator-owned precheck flow

`TaskOrchestrator.runExecutors(...)` becomes:

1. resolve executor from the preference;
2. call `executor.precheck(env)`;
3. if precheck returns `{ ok: false }`:
   - log an explicit precheck failure with executor/model context;
   - build a normal `TaskResultSubmission` failure for that preference;
   - skip `execute(...)` for that executor;
   - continue to the next preference if one exists;
4. if precheck returns `{ ok: true }`, proceed with the existing `execute(...)` path.

If `precheck(...)` throws, the orchestrator must catch that error and treat it as a failed precheck:

- log an explicit precheck failure;
- map it to the same `TaskResultSubmission` failure shape as a non-throwing `{ ok: false }`, using a simple message like:

```text
Executor "<executor>" precheck threw: <error message>
```

Result mapping on precheck failure:

```ts
{
  job_id: job.job_id,
  task_id: job.task_id,
  task_type: job.task_type,
  session_id: job.session_id,
  status: 'failure',
  exit_code: null,
  stdout: '',
  stderr: precheck.stderr,
  executor: pref.executor,
  executor_model: pref.executor_model,
}
```

Note: include `session_id` to match the standard `TaskResultSubmission` shape.

Important behavior notes:

- Precheck failure introduces a single new branch that bypasses `execute(...)`, but it must reuse the same fallback semantics.
- The existing "executor failed, trying next preference" behavior remains the same.
- The precheck runs once per executor preference attempt, not once per executor-internal continue/fresh subprocess branch.
- For `new_instance` retries, the precheck will run again on each retry attempt (since executor preferences are retried).

### 3. Executor-owned quick checks

Each executor will implement its own `precheck(...)` method.

For current executors:

| Executor | Current required binaries | Precheck behavior |
|----------|---------------------------|-------------------|
| `claude` | `claude` | report all missing binaries in a simple message |
| `claude-w` | `claude-w` | report all missing binaries in a simple message |
| `cursor` | `agent` | report all missing binaries in a simple message |
| `ttcodex` | `ttadk` | report all missing binaries in a simple message |
| `builtin` | none | return success with no checks |

The executor-local implementation pattern should be intentionally simple:

1. define a tiny local array of required binary names;
2. run `command -v` for each required binary against the current process `PATH`;
3. gather missing names;
4. return `{ ok: false, stderr: ... }` if any are missing, otherwise `{ ok: true }`.

No common utility module is introduced.

### 4. `command -v` contract

The check should explicitly use `command -v` from a shell, because the requirement is to validate binary discoverability in `PATH`.

Design requirement:

- each external executor uses shell-driven `command -v` checks for its declared binary names (POSIX);
- the implementation may run one shell command per binary or another tiny executor-local variant that still preserves the same `command -v` semantics.

If/when Windows support becomes a requirement, define the equivalent `PATH`-discoverability check at that time.

The design does not require a shared shell helper, escaping utility, or centralized process wrapper.

Safety note:

- Binary names are literal constants in code (not derived from job payload or user input), so the shell command string is not user-influenced.

### 5. Failure message shape

Messages should stay simple and executor-owned.

Recommended current format:

```text
Executor "claude-w" unavailable: missing required binaries in PATH: claude-w
```

For multiple binaries:

```text
Executor "example" unavailable: missing required binaries in PATH: foo, bar
```

This keeps the copy short while still making the cause and missing dependencies explicit.

### 6. Builtin executor behavior

`CleanupExecutor` must implement the new port method even though it does not currently use `PATH` binaries.

V1 behavior:

```ts
async precheck(_env: ExecutionEnvironment): Promise<ExecutorPrecheckResult> {
  return { ok: true };
}
```

This preserves interface uniformity and leaves room for future fast config checks without forcing them into this feature.

### 7. Logging

The orchestrator should add an explicit warning log for precheck failures, separate from execution and throw paths.

Recommended log shape:

```ts
logger.warn(
  { job_id: job.job_id, executor: pref.executor, model: pref.executor_model, stderr: precheck.stderr },
  'Executor precheck failed, trying next preference',
);
```

If the failed precheck is on the last preference, the existing end-of-loop error path still emits the final exhaustion log.

### 8. Test strategy

#### Orchestrator tests

Add coverage that proves:

1. `precheck(...)` is called before `execute(...)`.
2. a failed precheck prevents `execute(...)` for that executor.
3. a failed precheck falls through to the next executor preference.
4. the final failure result is annotated with the executor metadata of the last failed preference.
5. builtin cleanup still participates in the contract without breaking cleanup tasks.

#### Executor adapter tests

Add focused `precheck(...)` tests per adapter that prove:

1. success when all required binaries are found;
2. failure with the simple message when required binaries are missing;
3. current external executors report all missing binaries they check for;
4. builtin cleanup returns success without checking `PATH`.

Existing `execute(...)` tests should remain mostly unchanged because the orchestrator, not the executor itself, owns the new precheck invocation.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/daemon/task/src/ports/task-executor.ts` | Modify | Add `ExecutorPrecheckResult` and `precheck(env)` to the port |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Modify | Invoke precheck before each executor attempt and map failures into standard result submissions |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Modify | Cover precheck success, precheck failure fallback, and no-execute-on-precheck-failure behavior |
| `packages/daemon/task/src/adapters/claude-executor.ts` | Modify | Add executor-owned `command -v` precheck for `claude` |
| `packages/daemon/task/src/adapters/claude-w-executor.ts` | Modify | Add executor-owned `command -v` precheck for `claude-w` |
| `packages/daemon/task/src/adapters/cursor-executor.ts` | Modify | Add executor-owned `command -v` precheck for `agent` |
| `packages/daemon/task/src/adapters/ttcodex-executor.ts` | Modify | Add executor-owned `command -v` precheck for `ttadk` |
| `packages/daemon/task/src/adapters/cleanup-executor.ts` | Modify | Add no-op success precheck |
| `packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts` | Modify | Add `precheck(...)` coverage |
| `packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts` | Modify | Add `precheck(...)` coverage |
| `packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts` | Modify | Add `precheck(...)` coverage |
| `packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts` | Modify | Add `precheck(...)` coverage |
| `packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts` | Modify | Add no-op `precheck(...)` coverage |

## Acceptance Criteria

1. Every `TaskExecutor` implementation exposes `precheck(env)`.
2. `TaskOrchestrator` calls `precheck(env)` before `execute(...)` for every executor preference.
3. Current external executors use `command -v` against their required binaries in `PATH` (POSIX).
4. Current external executors report all missing binaries they check for.
5. `CleanupExecutor` returns precheck success without performing a binary lookup.
6. A failed precheck returns a normal task failure result with `exit_code: null` and simple error text.
7. A failed precheck never calls `execute(...)` for that executor.
8. Executor fallback ordering is unchanged after precheck failure.
9. The orchestrator emits an explicit precheck log entry.
10. No new status model, config surface, or shared precheck utility is introduced.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Shell-based `command -v` checks add small per-attempt overhead | Limit checks to a tiny binary list and run them only once per executor preference attempt |
| Duplicated helper logic drifts slightly between executors | Keep the helper tiny and test each executor directly |
| Future contributors accidentally add checks inside `execute(...)` instead of the port method | The design keeps the port contract explicit and adds orchestrator tests that prove precheck precedes execute |
