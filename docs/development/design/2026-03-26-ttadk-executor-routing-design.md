# TTADK Executor Routing Design

**Date:** 2026-03-26
**Type:** Feature enhancement
**Packages:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/cli`, `@local-agent/daemon`

## 1. Context

The daemon currently supports a single concrete executor path via `ClaudeCliExecutor`, and tasks do not declare which executor should run them.

Current state:

- `packages/shared/src/types.ts` defines `TaskSubmission` and `Task` without an `executor` field.
- `packages/api` accepts `task_type` and `payload`, stores them in RabbitMQ, and returns tasks to the daemon.
- `packages/cli` submits tasks without executor selection.
- `packages/daemon/src/index.ts` wires `Poller` to `TaskOrchestrator`.
- `packages/daemon/src/core/task-orchestrator.ts` must be updated to select and instantiate the matching executor based on each task.

The requested feature is to add TTADK as an adapter and make executor choice explicit per task using a required task field:

- `executor: "claude_code" | "ttadk"`

The TTADK command must be invoked exactly as:

```bash
ttadk code -t claude -a "--dangerously-skip-permissions -p" <prompt>
```

## 2. Goal

Add first-class multi-executor support so each submitted task explicitly chooses either `claude_code` or `ttadk`, and the daemon routes execution accordingly.

## 3. Non-goals

- No fallback from invalid executor values to another executor.
- No executor auto-detection in the daemon.
- No configurable TTADK binary path.
- No backward-compatibility default for missing executor values.
- No changes to polling/ACK semantics.

## 4. User Decisions Captured

- Add TTADK **alongside** the existing Claude executor.
- Add a required task field: `executor: "claude_code" | "ttadk"`.
- Keep executor selection logic in `TaskOrchestrator`.
- Model allowed values in `packages/shared` as a shared union/constants.
- Reject invalid executor values in both API and daemon.
- CLI submission must expose executor choice and require explicit selection.
- API responses should include `executor`.
- The TTADK adapter should log TTADK-specific messages.
- The daemon should invoke `ttadk` from `PATH`.
- TTADK process spawning must preserve the exact requested command semantics.

## 5. Approaches Considered

### Approach A — Shared executor type + orchestrator branching (recommended)

Add a shared executor type in `packages/shared`, require it in task schemas, and route by `task.executor` inside `TaskOrchestrator`, which instantiates the matching concrete executor on demand.

**Pros**
- Strong consistency across shared, API, CLI, and daemon.
- Keeps routing logic in the core layer, matching the chosen architecture.
- Makes invalid executor handling explicit.
- Easy to extend to future executors.

**Cons**
- Touches all packages.
- Slightly broadens the orchestrator responsibility from delegation to routing.

### Approach B — Shared type + composite adapter routing

Keep `TaskOrchestrator` thin and inject a composite `TaskExecutor` that internally picks the concrete executor.

**Pros**
- Minimal changes to orchestrator shape.
- Retains a single executor dependency at the orchestrator boundary.

**Cons**
- Routing becomes adapter-layer logic rather than core application logic.
- Makes executor selection less explicit in architecture.
- Less aligned with the user’s stated preference.

### Approach C — Local string values per package

Add `executor` everywhere but duplicate string literals and validation logic package-by-package.

**Pros**
- Slightly smaller upfront change in shared package.

**Cons**
- Easier drift between packages.
- Weaker typing and higher maintenance cost.
- No benefit worth the inconsistency.

## 6. Recommended Design

Adopt **Approach A**.

### 6.1 Shared executor model

Update `packages/shared/src/types.ts` to define:

```ts
export const TASK_EXECUTORS = ['claude_code', 'ttadk'] as const;
export type TaskExecutorType = (typeof TASK_EXECUTORS)[number];
```

Update interfaces:

```ts
export interface TaskSubmission {
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  submitted_at: string;
}
```

Re-export the executor constants/type from `packages/shared/src/index.ts`.

### 6.2 API changes

#### POST `/tasks`

Require `executor` in request body.

Validation rules:
- `task_type` must be a non-empty string.
- `payload` must be a string.
- `executor` must be one of `claude_code` or `ttadk`.

Invalid executor returns `400`.

Successful submission:
- create a `task_id` before enqueueing so the write path and read path use the same task shape
- publish `{ task_id, task_type, payload, executor, submitted_at }` to RabbitMQ
- respond with `{ task_id, task_type, payload, executor, submitted_at }`

#### RabbitMQ service

Store and retrieve `executor` as part of the queued task payload.

`getNext()` should return:

```ts
{
  task_id,
  task_type,
  payload,
  executor,
  submitted_at,
}
```

The API remains the first validation boundary, but daemon-side validation still exists as a defensive check for malformed queued data.

This contract avoids a shape mismatch where the queue read path returns `task_id` but the write path and API response omit it, which would otherwise leave implementation planning ambiguous about where the identifier is created.

### 6.3 CLI changes

Update `packages/cli/src/commands/submit.ts` so submission requires explicit executor selection.

New option shape:

```bash
submit --payload <string> --type <string> --executor <claude_code|ttadk>
```

Behavior:
- No default executor.
- `submitTask()` includes `executor` in the JSON body.
- Success handling remains unchanged except that API responses now contain executor.

### 6.4 Daemon architecture changes

#### New adapter

Add `packages/daemon/src/adapters/ttadk-executor.ts` implementing `TaskExecutor`.

Behavior mirrors the existing executor adapter structure:
- log TTADK-specific start/success/failure messages
- skip when payload is empty
- do not rethrow subprocess execution failures

Exact invocation:

```ts
execFileAsync(
  'ttadk',
  ['code', '-t', 'claude', '-a', '--dangerously-skip-permissions -p', task.payload],
  { maxBuffer: 50 * 1024 * 1024 },
)
```

This preserves the required command semantics:

```bash
ttadk code -t claude -a "--dangerously-skip-permissions -p" <prompt>
```

#### Orchestrator branching

`TaskOrchestrator` branches on `task.executor`, instantiates the matching executor, and runs it.

Proposed shape:

```ts
export class TaskOrchestrator {
  async handle(task: Task): Promise<void> {
    let executor: TaskExecutor;

    if (task.executor === 'claude_code') {
      executor = new ClaudeCliExecutor();
    } else if (task.executor === 'ttadk') {
      executor = new TTADKExecutor();
    } else {
      logger.error(
        { task_id: task.task_id, executor: task.executor },
        'Unknown task executor — refusing to ack',
      );
      throw new Error(`Unknown task executor: ${task.executor}`);
    }

    await executor.execute(task);
  }
}
```

This keeps executor selection in the core without introducing a registry object in `index.ts`.

#### Composition root

`packages/daemon/src/index.ts` will construct `TaskOrchestrator` directly and pass it to `Poller`:

```ts
const orchestrator = new TaskOrchestrator();
```

### 6.5 Claude executor compatibility

`ClaudeCliExecutor` remains supported and is selected only for `task.executor === 'claude_code'`.

No fallback from `ttadk` to Claude is allowed.

## 7. File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/types.ts` | Modify | Add shared executor constants/type; require `executor` on task interfaces |
| `packages/shared/src/index.ts` | Modify | Re-export executor constants/type |
| `packages/api/src/routes/tasks.ts` | Modify | Validate required `executor`; include it in publish and response |
| `packages/api/src/services/rabbitmq.ts` | Modify | Publish/retrieve executor in queue payloads |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Cover required executor, invalid executor, and response payload |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Modify | Verify executor round-trips through queue service |
| `packages/cli/src/commands/submit.ts` | Modify | Require `--executor`; include executor in request body |
| `packages/cli/src/__tests__/submit.test.ts` | Modify | Verify request body and required executor usage |
| `packages/daemon/src/adapters/ttadk-executor.ts` | Create | New TTADK adapter |
| `packages/daemon/src/adapters/__tests__/ttadk-executor.test.ts` | Create | TTADK adapter unit tests |
| `packages/daemon/src/adapters/claude-cli-executor.ts` | Modify | Ensure tests and behavior remain aligned with explicit executor routing |
| `packages/daemon/src/core/task-orchestrator.ts` | Modify | Route by `task.executor` by instantiating the matching executor |
| `packages/daemon/src/core/__tests__/task-orchestrator.test.ts` | Modify | Verify claude routing, ttadk routing, invalid executor skip, and unexpected executor failures propagate |
| `packages/daemon/src/index.ts` | Modify | Construct `TaskOrchestrator` directly without executor registry wiring |
| `packages/daemon/src/__tests__/poller.test.ts` | Modify | Add task executor field to fixtures |
| `docs/development/design/2026-03-26-daemon-hexagonal-refactor-design.md` | Modify | Update prior design references from single executor to multi-executor support if needed |
| `docs/development/plans/2026-03-26-daemon-hexagonal-refactor.md` | Modify | Update prior plan references if needed to avoid stale Claude-only guidance |

## 8. Test Strategy

### Shared
- Type-check imports and usage of `TaskExecutorType` and `TASK_EXECUTORS`.

### API
- POST `/tasks` succeeds when `executor` is valid.
- POST `/tasks` returns `400` when `executor` is missing.
- POST `/tasks` returns `400` when `executor` is invalid.
- GET `/tasks/next` returns tasks including `executor`.
- RabbitMQ publish/getNext preserves `executor`.

### CLI
- `submitTask()` includes `executor` in JSON body.
- Command registration requires explicit `--executor`.
- Existing error handling remains intact.

### Daemon
- `TTADKExecutor` spawns the exact expected `ttadk` command arguments.
- `TTADKExecutor` resolves on success, non-zero exit, missing binary, and empty payload behavior analogous to Claude adapter.
- `TaskOrchestrator` routes `claude_code` tasks to `ClaudeCliExecutor`.
- `TaskOrchestrator` routes `ttadk` tasks to `TTADKExecutor`.
- `TaskOrchestrator` logs and skips unknown executor values without invoking any adapter.
- Poller tests update fixtures to include required `executor`.

## 9. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Schema change breaks existing task submitters | Make the requirement explicit in CLI and API tests; accept that this is an intentional contract change |
| Drift in allowed executor values across packages | Define executor values once in `packages/shared` |
| TTADK command argument mismatch | Test exact `execFile` call arguments in the TTADK adapter unit test |
| Malformed queued data reaches daemon | Keep daemon-side unknown executor guard that logs and fails the task so the poller does not ACK malformed work |
| Stale docs still imply Claude-only execution | Update design/plan docs referenced during current refactor workflow |

## 10. Acceptance Criteria

1. `TaskSubmission` and `Task` both require `executor` with allowed values `claude_code | ttadk`.
2. API rejects missing or invalid executor values with `400`.
3. CLI requires explicit executor selection and sends it in task submission payloads.
4. RabbitMQ preserves executor values end-to-end.
5. Daemon supports both `ClaudeCliExecutor` and `TTADKExecutor`.
6. `TaskOrchestrator` routes by `task.executor`; unknown executors are logged and fail before ACK.
7. `TTADKExecutor` uses the exact required TTADK command semantics.
8. Updated tests cover shared/API/CLI/daemon changes.
