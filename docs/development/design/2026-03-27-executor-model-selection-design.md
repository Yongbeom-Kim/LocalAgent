# Executor Model Selection Design

**Date:** 2026-03-27
**Type:** Feature enhancement
**Packages:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/cli`, `@local-agent/daemon`

## 1. Context

The daemon supports two executors (`claude_code` and `claude-w`), but model selection is not configurable per task. The Claude CLI executor uses the default model (no `--model` flag), and the Claude W executor invokes the `claude-w` binary and must pass an explicit `--model`.

Current state:

- `packages/shared/src/types.ts` defines `TaskExecutorType` as `'claude_code' | 'claude-w'` but has no model field.
- `packages/daemon/src/adapters/claude-cli-executor.ts` spawns `claude --dangerously-skip-permissions -p <payload>` with no model flag.
- `packages/daemon/src/adapters/claude-w-executor.ts` spawns `claude-w --dangerously-skip-permissions --model <executor_model> -p -` with stdin prompt transport.
- No validation or configuration exists for model selection.

The requested feature adds a required `executor_model` field so each task explicitly declares which model to use, with executor-specific validation.

## 2. Goal

Add per-task model selection so submitters explicitly choose a model for their chosen executor, validated at submission time and passed through to the executor's CLI invocation.

## 3. Non-goals

- No default model fallback when `executor_model` is omitted.
- No runtime model discovery or dynamic model lists.
- No changes to polling, ACK, or queue semantics.
- No changes to executor routing logic.
- No model aliasing or translation (values are passed as-is to CLI flags).

## 4. User Decisions Captured

- `executor_model` is a **required** field on `TaskSubmission` and `Task`.
- Each executor has its own set of valid models (executor-specific).
- **Claude CLI executor models:** `opus`, `sonnet`, `haiku`.
- **Claude W executor models:** `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.2`, `glm-5`, `glm-4.7`, `kimi-k2.5`, `minimax-2.5`, `minimax-2.7`.
- Validation happens at **both** submission time (API/CLI cross-validates executor+model) and execution time (executor/underlying tool).
- Model values are passed **as-is** to each executor's model flag (`--model` for Claude CLI and `claude-w`).
- The executor-to-model mapping lives in `shared/types.ts` as a static map.
- CLI exposes model as `-m, --model <value>` (required option).
- Invalid model+executor combinations produce helpful errors listing valid models for that executor.
- Runtime model rejection by the underlying tool follows existing behavior: ACK with error log (no retry).
- Design should be extensible for future executors.

## 5. Approaches Considered

### Approach A — Static map in `shared/types.ts` (recommended)

Define an `EXECUTOR_MODELS` constant mapping each executor to its valid models. A shared `isValidExecutorModel(executor, model)` function validates the pair. API, CLI, and daemon all import from the same source.

**Pros**
- Single source of truth for executor-model relationships.
- Type-safe with `as const` inference.
- Cross-validation at submission time.
- Easy to extend: adding a new executor+models is a one-line addition.
- Zero runtime overhead.

**Cons**
- Adding a model requires a code change and deploy.

### Approach B — Executor-owned validation

Each executor class defines its own `static VALID_MODELS` array. The shared types only define `executor_model: string`. Validation happens at execution time in the daemon.

**Pros**
- Better encapsulation — executors own their model knowledge.

**Cons**
- No submission-time cross-validation (violates requirement).
- Model lists not available to API/CLI without importing daemon code (breaks package boundaries).
- Weaker type safety.

### Approach C — Config-driven (environment/file)

Model lists loaded from environment variables or a config file at runtime.

**Pros**
- No code changes to add/remove models.

**Cons**
- Over-engineered for the current number of models.
- Config drift risk between environments.
- Harder to type-check.
- YAGNI.

## 6. Recommended Design

Adopt **Approach A**.

### 6.1 Shared executor-model mapping

Update `packages/shared/src/types.ts` to define:

```ts
export const EXECUTOR_MODELS = {
  claude_code: ['opus', 'sonnet', 'haiku'],
  'claude-w': ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'glm-5', 'glm-4.7', 'kimi-k2.5', 'minimax-2.5', 'minimax-2.7'],
} as const satisfies Record<TaskExecutorType, readonly string[]>;

export type ExecutorModelType<T extends TaskExecutorType = TaskExecutorType> =
  (typeof EXECUTOR_MODELS)[T][number];

export function isValidExecutorModel(
  executor: TaskExecutorType,
  model: unknown,
): model is ExecutorModelType {
  return (
    typeof model === 'string' &&
    (EXECUTOR_MODELS[executor] as readonly string[]).includes(model)
  );
}

export function getExecutorModelOptions(executor: TaskExecutorType): string {
  return EXECUTOR_MODELS[executor].join(', ');
}
```

Update interfaces:

```ts
export interface TaskSubmission {
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
}
```

Re-export from `packages/shared/src/index.ts`.

### 6.2 API changes

#### POST `/tasks`

Add `executor_model` validation after existing `executor` validation:

```ts
if (!isValidExecutorModel(executor, executor_model)) {
  res.status(400).json({
    error: `executor_model must be one of: ${getExecutorModelOptions(executor)}`,
  });
  return;
}
```

Include `executor_model` in the constructed `Task` object and response.

### 6.3 CLI changes

Update `packages/cli/src/commands/submit.ts`:

- Add required option: `-m, --model <string>` for executor model.
- Add cross-validation before submission using `isValidExecutorModel()`.
- On invalid model, print error listing valid models for the specified executor.
- Include `executor_model` in the `TaskSubmission` body.

Updated command shape:

```bash
submit --payload <string> --type <string> --executor <claude_code|claude-w> --model <string>
```

### 6.4 Daemon executor changes

#### Claude CLI executor

Update command construction to include `--model`:

```ts
await execFileAsync('claude', [
  '--dangerously-skip-permissions',
  '--model', task.executor_model,
  '-p', task.payload,
], {
  maxBuffer: 50 * 1024 * 1024,
});
```

#### Claude W executor

Update command construction to include `--model`:

```ts
await execFileAsync('claude-w', [
  '--dangerously-skip-permissions',
  '--model', task.executor_model,
  '-p', '-',
], {
  maxBuffer: 50 * 1024 * 1024,
});
```

#### Task orchestrator

No changes needed. The orchestrator routes by `task.executor` as before; `executor_model` flows through `task` to the executor's `execute(task)` method.

## 7. File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/types.ts` | Modify | Add `EXECUTOR_MODELS` map, `ExecutorModelType`, `isValidExecutorModel()`, `getExecutorModelOptions()`; add `executor_model` to interfaces |
| `packages/shared/src/index.ts` | Modify | Re-export new model constants/types/functions |
| `packages/api/src/routes/tasks.ts` | Modify | Validate `executor_model` against executor; include in task construction and response |
| `packages/cli/src/commands/submit.ts` | Modify | Add `-m, --model` required option; cross-validate with executor; include in submission body |
| `packages/daemon/src/adapters/claude-cli-executor.ts` | Modify | Add `--model task.executor_model` to `execFile` args |
| `packages/daemon/src/adapters/claude-w-executor.ts` | Modify | Pass `--model task.executor_model` to `claude-w` |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Add tests for executor_model validation (missing, invalid, valid) |
| `packages/cli/src/__tests__/submit.test.ts` | Modify | Add tests for model option, cross-validation, request body |
| `packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts` | Modify | Verify `--model` flag in spawned command args |
| `packages/daemon/src/adapters/__tests__/claude-w-executor.test.ts` | Modify | Verify `--model` is passed to `claude-w` with valid fixture values |
| `packages/daemon/src/core/__tests__/task-orchestrator.test.ts` | Modify | Update task fixtures with `executor_model` |
| `packages/daemon/src/__tests__/poller.test.ts` | Modify | Update task fixtures with `executor_model` |

## 8. Test Strategy

### Shared
- `isValidExecutorModel()` returns true for valid executor+model pairs.
- `isValidExecutorModel()` returns false for cross-executor mismatches (e.g., `('claude_code', 'gpt-5.4')`).
- `isValidExecutorModel()` returns false for unknown model strings.
- `getExecutorModelOptions()` returns comma-separated list for each executor.

### API
- POST `/tasks` succeeds with valid executor+model pair.
- POST `/tasks` returns 400 when `executor_model` is missing.
- POST `/tasks` returns 400 when `executor_model` is invalid for the given executor.
- POST `/tasks` response includes `executor_model`.

### CLI
- `submitTask()` includes `executor_model` in JSON body.
- Invalid model for executor prints helpful error with valid options.
- Command registration includes `-m, --model` as required option.

### Daemon
- `ClaudeCliExecutor` spawns `claude --dangerously-skip-permissions --model <executor_model> -p <payload>`.
- `ClaudeWExecutor` spawns `claude-w --dangerously-skip-permissions --model <executor_model> -p -`.
- Task fixtures across all daemon tests include `executor_model`.

## 9. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Schema change breaks existing task submitters | Intentional contract change; make requirement explicit in CLI help and API error messages |
| Model string passed as-is may not match what the underlying tool expects | Validated at submission time against known list; runtime errors logged and ACK'd per existing behavior |
| Adding new models requires code changes | Acceptable trade-off for type safety; adding a model is a single-line change to `EXECUTOR_MODELS` |
| CLI `-m` flag conflicts with other tools | Using `-m, --model` which is a standard convention; no conflict within `local-agent` CLI |

## 10. Acceptance Criteria

1. `TaskSubmission` and `Task` both require `executor_model` as a string field.
2. `EXECUTOR_MODELS` map in `shared/types.ts` defines valid models per executor.
3. API rejects missing or invalid `executor_model` values with 400 and helpful error message listing valid models.
4. CLI requires `-m, --model` and cross-validates against executor before submission.
5. RabbitMQ preserves `executor_model` end-to-end.
6. `ClaudeCliExecutor` passes `executor_model` as `--model` flag to `claude` CLI.
7. `ClaudeWExecutor` passes `executor_model` as `--model` to `claude-w`.
8. Invalid model+executor errors list valid models for that executor.
9. Updated tests cover shared/API/CLI/daemon changes.
