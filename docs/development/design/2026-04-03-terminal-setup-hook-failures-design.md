# Design: Terminal Setup Hook Failures

**Date**: 2026-04-03
**Status**: Approved
**Author**: Codex

---

## Overview

Refine setup-hook failure handling so that when a setup hook exits nonzero, the task daemon immediately returns a failure result to the user and does not run any executor or executor fallback. The returned result should use `status: "failure"`, `exit_code: 1`, the original `task_type`, raw hook `stdout`, raw hook `stderr`, and omit `executor` / `executor_model` because execution never started.

This behavior also applies to setup-hook timeouts, which should be normalized to the same terminal pre-executor failure contract.

---

## Problem Statement

The task daemon already runs `setup_hook` during environment preparation, before executor dispatch. However:

1. Setup-hook failures are currently surfaced as generic environment setup failures.
2. The failure path drops the hook's raw `stdout` and `stderr` from the published task result.
3. The orchestrator does not distinguish setup-hook terminal failures from other setup errors at the type level.
4. The desired user contract is stricter: a failed setup hook must stop execution immediately and return a concrete failure result without trying any executor, fallback executor, or `new_instance` retry.

This matters because setup hooks are operator-defined preconditions for execution. If they fail, executor fallback is not a meaningful recovery path.

---

## Goals

1. Treat any setup-hook nonzero exit as a terminal task failure before executor dispatch.
2. Treat setup-hook timeout the same way as a terminal setup-hook failure.
3. Return a concrete task result with `exit_code: 1` and raw hook `stdout` / `stderr`.
4. Ensure no executor attempt, fallback attempt, or `new_instance` retry runs after setup-hook failure.
5. Preserve existing `.workspace-ready` reuse behavior: reused workspaces skip setup hooks entirely.
6. Preserve existing cleanup behavior for failed fresh workspace setup.

## Non-Goals

- Changing behavior for unrelated environment setup failures such as marketplace clone errors or plugin resolution errors.
- Introducing a new result status, failure subtype, or structured failure-reason field.
- Re-running setup hooks for reused workspaces.
- Changing notifier formatting beyond forwarding the raw result fields that already exist.

---

## Design

### 1. Introduce a dedicated setup-hook failure type

Add a new exported error class in `packages/daemon/task/src/services/setup-hook-runner.ts`:

```ts
export class SetupHookExecutionError extends Error {
  readonly exit_code = 1;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}
```

This type represents terminal pre-executor hook failure only. It is thrown when:

- the hook process exits nonzero; or
- the hook process times out.

The type carries normalized result data so downstream code does not need to infer behavior from message strings.

### 2. Update SetupHookRunner to capture raw output and normalize failures

`SetupHookRunner.run()` should continue to execute `bash -c <script>` in the job workspace, but failure handling changes:

- On success (`exit code 0`): return `void` as today.
- On nonzero exit: throw `SetupHookExecutionError` with:
  - `exit_code: 1`
  - `stdout`: raw captured stdout, default `''`
  - `stderr`: raw captured stderr if present; otherwise a minimal generated message derived from the process error
  - `timedOut: false`
- On timeout: throw `SetupHookExecutionError` with:
  - `exit_code: 1`
  - `stdout`: raw partial stdout if available
  - `stderr`: raw partial stderr plus a timeout message if stderr is empty or insufficient
  - `timedOut: true`

**Timeout detection:** Node's `execFile` timeout path does not always provide a numeric exit code. Implementation should treat timeouts as hook failures by detecting timeout-related error fields (for example `err.killed === true` and/or a timeout-derived `err.signal`) rather than relying on `err.code`.

Important detail: the thrown error must preserve raw output fields separately from the human-readable `message`. The `message` is for logs; the orchestrator result should be built from `stdout` and `stderr` fields.

### 3. Keep JobEnvironment responsible for setup, not result shaping

`JobEnvironment.setup()` should not start returning a result union. It should continue to either:

- return `ExecutionEnvironment`, or
- throw an error.

For setup-hook failures, it simply rethrows `SetupHookExecutionError` after performing existing cleanup behavior. This keeps environment preparation isolated from task result publication.

Existing behavior remains unchanged for:

- `.workspace-ready` reuse: hook is skipped
- debug-mode preservation of failed workspace
- lock-file-aware cleanup
- non-hook setup failures such as git clone or missing plugin directory

### 4. Update TaskOrchestrator to short-circuit on typed setup-hook failures

`TaskOrchestrator.handle()` should catch `SetupHookExecutionError` separately from generic setup failures.

When that typed error is caught, it must immediately return:

```ts
{
  job_id: job.job_id,
  task_id: job.task_id,
  task_type: job.task_type,
  status: 'failure',
  exit_code: 1,
  stdout: hookError.stdout,
  stderr: hookError.stderr,
}
```

Notably:

- `executor` and `executor_model` are omitted.
- `runExecutors()` is never called.
- `new_instance` retry logic is never entered because setup completed unsuccessfully before execution began.

Generic setup failures still return the existing shape:

```ts
{
  status: 'failure',
  exit_code: null,
  stdout: '',
  stderr: `Environment setup failed: ...`,
}
```

### 5. No API or notifier schema changes

The existing result schema already supports the required fields:

- `status`
- `exit_code`
- `stdout`
- `stderr`
- optional `executor` / `executor_model`

No new wire fields are needed. The result consumers in Lark and Telegram already render the published fields, so the visible change is that setup-hook failures will now show raw hook output instead of only a wrapped environment-setup error string.

**Output size:** setup hooks can emit large output. The implementation should apply the same byte-based truncation used by executors (`truncate(..., MAX_RESULT_OUTPUT_BYTES)`) to both hook `stdout` and hook `stderr` before returning/publishing a result. The task poller may still apply additional display truncation (for example `MAX_SNIPPET_CHARS` on `stdout`).

---

## Data Flow

```text
JobEnvironment.setup(job)
  -> SetupHookRunner.run(...)
       -> exit 0
            -> return ExecutionEnvironment
       -> exit nonzero or timeout
            -> throw SetupHookExecutionError { exit_code: 1, stdout, stderr }
  -> TaskOrchestrator.handle(job)
       -> catch SetupHookExecutionError
       -> return terminal failure result
       -> TaskPoller publishes result and ACKs job
```

---

## Alternatives Considered

### A. Typed setup-hook failure in JobEnvironment

Recommended.

Pros:
- Narrow change to the hook-specific failure path
- Prevents executor fallback and retry through explicit control flow
- Avoids brittle string parsing
- Keeps environment setup and result shaping loosely coupled

Cons:
- Introduces a new error type

### B. Return a result union from JobEnvironment.setup()

Pros:
- Makes the pre-executor result path explicit in method signatures

Cons:
- Broadens `JobEnvironment` from setup orchestration into result construction
- Requires wider signature changes for a narrow feature

### C. Parse generic thrown errors in TaskOrchestrator

Pros:
- Minimal code churn

Cons:
- Brittle and message-dependent
- Easy to regress later
- Blurs hook failures with unrelated environment setup problems

---

## File Changes

| File | Change |
|------|--------|
| `packages/daemon/task/src/services/setup-hook-runner.ts` | Add `SetupHookExecutionError`; capture stdout/stderr and normalize nonzero exit + timeout into typed terminal failures |
| `packages/daemon/task/src/services/job-environment.ts` | Preserve cleanup behavior and rethrow typed hook failures unchanged |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Catch `SetupHookExecutionError` and return terminal failure result without executor metadata |
| `packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts` | Assert typed error fields for nonzero exit and timeout, including raw output capture |
| `packages/daemon/task/src/services/__tests__/job-environment.test.ts` | Assert typed hook failures still trigger existing cleanup semantics |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Assert setup-hook failure returns `exit_code: 1`, forwards raw stdout/stderr, omits executor metadata, and skips executor/retry paths |

---

## Testing

1. `SetupHookRunner`
- Success case still passes.
- Nonzero exit with stderr throws `SetupHookExecutionError` carrying `stdout`, `stderr`, `exit_code: 1`, `timedOut: false`.
- Timeout throws `SetupHookExecutionError` carrying `exit_code: 1`, `timedOut: true`, and usable `stderr`.
- Env var injection coverage remains.

2. `JobEnvironment`
- Existing cleanup behavior remains for hook failure in debug false / debug true / lock-file cases.
- Hook reuse skip remains unchanged for `.workspace-ready` workspaces.

3. `TaskOrchestrator`
- Setup-hook typed failure returns terminal failure result before any executor is instantiated.
- `new_instance` jobs with setup-hook failure do not enter retry loop.
- Generic environment setup failures still return `exit_code: null` and wrapped stderr.

4. Regression safety
- Existing executor fallback behavior remains unchanged for executor-level failures.
- Existing task result publishing path remains unchanged.

---

## Risks and Mitigations

- Risk: timeout errors may not include useful stderr.
  Mitigation: normalize timeout failures to `exit_code: 1` and synthesize a minimal timeout stderr when necessary.

- Risk: future code may accidentally catch and wrap the typed error as a generic environment failure.
  Mitigation: use a dedicated exported class and explicit orchestrator branch with focused unit tests.

- Risk: result consumers may rely on executor metadata always existing on failures.
  Mitigation: preserve current optional schema semantics; add tests covering setup-hook failure result shape without executor fields.

---

## Compatibility

- Backwards compatible for jobs without `setup_hook`.
- Backwards compatible for successful hooks.
- Backwards compatible for generic setup failures unrelated to hook nonzero exit or timeout.
- Intentional user-visible change for hook failure results: raw hook output is surfaced directly and `exit_code` becomes `1` instead of `null`.
