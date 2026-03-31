# Design: Pre-Setup Hook for Task Types

**Date**: 2026-03-31
**Status**: Approved
**Author**: Claude Code

---

## Overview

Extend the enrichment YAML config to support a per-task-type `setup_hook` — an inline bash script that runs in the job's temp working directory before any executor is invoked. This enables users to configure environment preparation steps (e.g., cloning a repo, installing dependencies) that are specific to a task type.

---

## Problem Statement

The task daemon creates a fresh temp directory (`/tmp/localagent-job-{job_id}`) for each job and then immediately invokes the executor (claude/ttadk). There is currently no mechanism to prepare that directory before the executor runs — e.g., cloning a repo, creating a `.env`, or installing dependencies. Users must either embed such commands in the task payload or rely on the executor to do setup, which pollutes the task prompt.

---

## Goals

1. Allow arbitrary bash scripts to run after the temp dir is created, before any executor attempt.
2. Configure per task type in the enrichment YAML, alongside existing `executors` and `marketplaces`.
3. Pass job metadata as environment variables so the script can branch on task type or payload.
4. Fail the job cleanly if the hook exits non-zero.
5. Support per-rule timeout configuration.

## Non-Goals

- Multiple hooks per rule (one `setup_hook` per rule is sufficient).
- Teardown hooks (post-execution cleanup).
- Hook scripts referenced by file path (inline-only for now).
- Re-running the hook between executor fallback attempts.

---

## Design

### 1. YAML Config Schema

Add two optional fields to each enrichment rule:

```yaml
rules:
  coding-task:
    setup_hook: |
      git clone https://github.com/org/repo .
      npm ci --ignore-scripts
    setup_hook_timeout_ms: 120000   # optional, default: 300000 (5 min)
    executors:
      - executor: claude_code
        executor_model: sonnet
    marketplaces:
      - url: https://github.com/org/plugins
        plugins: [my-plugin]

  default:
    executors:
      - executor: claude_code
        executor_model: sonnet
```

- `setup_hook` — optional multiline bash script string. If absent, no hook runs.
- `setup_hook_timeout_ms` — optional integer milliseconds. Defaults to `300_000` (5 minutes).

### 2. Shared Types

Add optional fields to `JobSubmission` and `Job` in `packages/shared/src/types.ts`:

```typescript
export interface JobSubmission {
  // existing fields ...
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}

export interface Job {
  // existing fields ...
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}
```

These fields are optional so the change is fully backwards-compatible with existing jobs in the queue that lack these fields.

### 3. EnrichmentService

Update `EnrichmentRule` interface and `enrich()` method in `packages/daemon/task-enrichment/src/enrichment-service.ts`:

```typescript
interface EnrichmentRule {
  executors: Array<{ executor: string; executor_model: string }>;
  marketplaces?: Array<{ url: string; plugins: string[] }>;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}
```

`enrich()` passes the fields through to `JobSubmission`:

```typescript
return {
  // existing fields ...
  setup_hook: rule.setup_hook,
  setup_hook_timeout_ms: rule.setup_hook_timeout_ms,
};
```

### 4. SetupHookRunner (new service)

Create `packages/daemon/task/src/services/setup-hook-runner.ts`:

```typescript
export class SetupHookRunner {
  async run(
    script: string,
    workDir: string,
    jobContext: { job_id: string; task_id: string; task_type: string; payload: string },
    timeoutMs: number,
  ): Promise<void>
}
```

**Execution details**:
- Invokes `bash -c <script>` via `execFile` (not `exec`) to avoid shell injection from script string being passed as argument directly — the script is the `-c` argument, not user-interpolated into a shell command.
- Sets `cwd` to `workDir`.
- Injects environment variables:
  - `LOCALAGENT_JOB_ID`
  - `LOCALAGENT_TASK_ID`
  - `LOCALAGENT_TASK_TYPE`
  - `LOCALAGENT_PAYLOAD`
  - Inherits the daemon process environment (`...process.env`).
- On non-zero exit: throws an error with stderr content included.
- Stdout/stderr always emitted as structured log lines (pino `info`/`error`).

### 5. JobEnvironment Integration

`JobEnvironment.setup()` calls `SetupHookRunner.run()` after marketplace cloning (if any) and before returning the `ExecutionEnvironment`:

```
setup(job):
  1. mkdirSync(workDir)
  2. Clone marketplaces (existing)
  3. If job.setup_hook:
       timeoutMs = job.setup_hook_timeout_ms ?? DEFAULT_SETUP_HOOK_TIMEOUT_MS
       runner.run(job.setup_hook, workDir, jobContext, timeoutMs)
  4. return { workDir, pluginDirs }
```

On hook failure, `setup()` cleans up `workDir` (same as the existing marketplace-failure path) and re-throws, which causes `TaskOrchestrator` to return a `failure` result with the hook error in `stderr`.

The `JobEnvironment` constructor receives a `SetupHookRunner` instance (constructor injection, consistent with existing `debug` flag approach).

### 6. TaskOrchestrator

No changes required. Existing error handling in `handle()` already catches `setup()` failures and returns a failure result:

```typescript
try {
  env = await this.jobEnv.setup(job);
} catch (error) {
  return { status: 'failure', stderr: `Environment setup failed: ${error.message}` };
}
```

---

## Data Flow

```
enrichment.yaml
  └── EnrichmentService.enrich(task)
        └── JobSubmission { setup_hook, setup_hook_timeout_ms, executors, ... }
              └── RabbitMQ jobs queue
                    └── Job { setup_hook, setup_hook_timeout_ms, executors, ... }
                          └── TaskOrchestrator.handle(job)
                                └── JobEnvironment.setup(job)
                                      ├── mkdirSync(workDir)
                                      ├── clone marketplaces
                                      └── SetupHookRunner.run(script, workDir, ctx, timeout)
                                            └── bash -c <script>  [cwd=workDir]
                                                  exports: LOCALAGENT_JOB_ID, LOCALAGENT_TASK_ID, LOCALAGENT_TASK_TYPE, LOCALAGENT_PAYLOAD
```

---

## File Changes

| File | Change |
|------|--------|
| `packages/shared/src/types.ts` | Add optional `setup_hook`, `setup_hook_timeout_ms` to `JobSubmission` and `Job` |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Add fields to `EnrichmentRule`; pass through in `enrich()` |
| `packages/daemon/task-enrichment/config/enrichment.yaml` | No required change (fields are optional) |
| `packages/daemon/task/src/services/setup-hook-runner.ts` | **New file** — `SetupHookRunner` class |
| `packages/daemon/task/src/services/job-environment.ts` | Accept `SetupHookRunner`; call it in `setup()` after marketplace clone |
| `packages/daemon/task/src/task-daemon.ts` | Instantiate `SetupHookRunner` and pass to `JobEnvironment` |

---

## Constants

```typescript
export const DEFAULT_SETUP_HOOK_TIMEOUT_MS = 300_000; // 5 minutes
```

Defined in `packages/shared/src/constants.ts` alongside existing defaults.

---

## Testing

- **Unit tests for `SetupHookRunner`**: successful script, non-zero exit, timeout, env var injection.
- **Unit tests for `EnrichmentService`**: rule with `setup_hook` produces correct `JobSubmission` fields; rule without `setup_hook` produces `undefined` fields.
- **Unit tests for `JobEnvironment`**: mock `SetupHookRunner`; verify called with correct args when `job.setup_hook` is set; verify not called when absent; verify cleanup on hook failure.
- **Existing tests**: should pass without modification (optional fields, backwards-compatible).

---

## Security Considerations

- The hook script is authored by the operator (in the enrichment YAML config file), not sourced from task payloads submitted by end users. It is operator-controlled configuration, equivalent in trust to the executor and marketplace settings.
- `execFile('bash', ['-c', script])` is used — the script content is passed as a single argument, not interpolated into a shell string, so there is no shell-injection vector from the script string itself.
- `LOCALAGENT_PAYLOAD` is passed as an environment variable (not shell-interpolated), so payload content cannot inject into the hook script.
- Operators should be aware that the hook runs with the same OS user as the daemon process.

---

## Backwards Compatibility

- All new fields are optional (`?`). Existing enrichment rules without `setup_hook` are unaffected.
- Existing `Job` messages in the RabbitMQ queue (missing the new fields) will deserialize with `undefined` for `setup_hook`, which is handled correctly (no hook is run).
