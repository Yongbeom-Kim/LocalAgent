# Daemon Hexagonal Architecture Refactor

**Date:** 2026-03-26
**Type:** Refactor design later extended by executor-routing changes
**Package:** `@local-agent/daemon`

## 1. Context

The daemon package currently has a refactored hexagonal structure centered around a poller, a core orchestrator, and executor adapters.

Current concrete executor support includes:

- `index.ts` — composition root (loads config, wires Poller + TaskOrchestrator, registers shutdown)
- `poller.ts` — HTTP polling infrastructure (fetches tasks from API, calls orchestrator, ACKs)
- `core/task-orchestrator.ts` — routes each task to the executor selected on the task payload
- `adapters/claude-cli-executor.ts` — executes Claude Code tasks
- `adapters/ttadk-executor.ts` — executes TTADK tasks

Queued tasks now include a required `executor` field, and `TaskOrchestrator` uses that field to select the matching adapter. The earlier refactor still provides the architectural boundaries for this behavior.

## 2. Goal

Refactor the daemon to follow hexagonal (ports & adapters) architecture:

- Define an explicit **outbound port** (`TaskExecutor` interface) for task execution
- Implement concrete executor adapters for the supported task executors, including **Claude Code CLI** (`ClaudeCliExecutor`) and TTADK (`TTADKExecutor`)
- Route tasks inside `TaskOrchestrator` based on each task's required `executor` field
- Keep `index.ts` limited to constructing `TaskOrchestrator` and `Poller`

**Non-goals:**
- This document does not redesign polling/ACK behavior
- It does not specify the later executor field contract beyond staying compatible with required per-task executor routing
- No DI framework introduction
- No modeling of the poller as a formal driving port (it remains infrastructure)

## 3. Current Architecture

```
index.ts (composition root)
  └── new Poller(apiUrl, handleTask)
        ├── fetch /tasks/next
        ├── await handler(task)    ← handleTask function
        └── fetch /tasks/:id/ack

handler.ts (free function)
  └── execFile('claude', ['-p', payload])
```

**Dependencies flow:** `index.ts` → `poller.ts` → `handler.ts` (all concrete, no interfaces)

## 4. Target Architecture

```
index.ts (composition root)
  ├── new TaskOrchestrator()
  └── new Poller(apiUrl, orchestrator)
        ├── fetch /tasks/next
        ├── await orchestrator.handle(task)       ← routes by task.executor
        └── fetch /tasks/:id/ack

core/task-orchestrator.ts
  └── selects and instantiates executor using task.executor

ports/task-executor.ts
  └── interface TaskExecutor { execute(task): Promise<void> }

adapters/claude-cli-executor.ts
  └── implements TaskExecutor using execFile('claude', ...)

adapters/ttadk-executor.ts
  └── implements TaskExecutor using execFile('ttadk', ...)
```

**Dependencies flow:**
- `index.ts` → wires polling to orchestration without per-executor DI
- `core/` → depends on `ports/` and concrete executor adapters for task-directed branching
- `adapters/` → depends on `ports/` (implements interfaces)
- `poller.ts` → depends on `core/` (calls orchestrator)

## 5. Directory Structure

```
packages/daemon/src/
├── index.ts                              # Composition root (DI wiring)
├── poller.ts                             # Infrastructure (updated to accept TaskOrchestrator)
├── core/
│   ├── task-orchestrator.ts              # Thin orchestration/routing service
│   └── __tests__/
│       └── task-orchestrator.test.ts     # Tests with mock TaskExecutor registry
├── ports/
│   └── task-executor.ts                  # TaskExecutor interface
└── adapters/
    ├── claude-cli-executor.ts            # Claude implementation of TaskExecutor
    ├── ttadk-executor.ts                 # TTADK implementation of TaskExecutor
    └── __tests__/
        ├── claude-cli-executor.test.ts   # Claude adapter tests
        └── ttadk-executor.test.ts        # TTADK adapter tests
```

**No barrel exports** — import directly from specific files.

## 6. Interface Definitions

### 6.1 Port: TaskExecutor

```typescript
// ports/task-executor.ts
import { Task } from '@local-agent/shared';

export interface TaskExecutor {
  execute(task: Task): Promise<void>;
}
```

- Single method, void return (fire-and-forget, matching current behavior)
- Takes the existing `Task` type from shared package

### 6.2 Core: TaskOrchestrator

```typescript
// core/task-orchestrator.ts
import { Task, createLogger } from '@local-agent/shared';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';
import { TTADKExecutor } from '../adapters/ttadk-executor';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('daemon:orchestrator');

export class TaskOrchestrator {
  async handle(task: Task): Promise<void> {
    logger.info(
      { task_id: task.task_id, task_type: task.task_type, executor: task.executor },
      'Processing task',
    );

    let executor: TaskExecutor;

    if (task.executor === 'claude_code') {
      executor = new ClaudeCliExecutor();
    } else if (task.executor === 'ttadk') {
      executor = new TTADKExecutor();
    } else {
      logger.error({ task_id: task.task_id, executor: task.executor }, 'Unknown task executor — refusing to ack');
      throw new Error(`Unknown task executor: ${task.executor}`);
    }

    await executor.execute(task);
  }
}
```

- Branches on required `task.executor`
- Instantiates the matching executor on demand rather than receiving a registry
- The `handle` method signature still matches what the poller needs

### 6.3 Adapters: ClaudeCliExecutor and TTADKExecutor

```typescript
// adapters/claude-cli-executor.ts
export class ClaudeCliExecutor implements TaskExecutor {
  async execute(task: Task): Promise<void> {
    // Executes claude_code tasks
  }
}

// adapters/ttadk-executor.ts
export class TTADKExecutor implements TaskExecutor {
  async execute(task: Task): Promise<void> {
    // Executes ttadk tasks
  }
}
```

- Each class implements `TaskExecutor`
- Claude and TTADK are both supported adapters
- Concrete command details stay with the adapter for each executor

### 6.4 Updated Poller

```typescript
// poller.ts (updated constructor signature)
import { Task, createLogger } from '@local-agent/shared';
import { TaskOrchestrator } from './core/task-orchestrator';

export class Poller {
  constructor(
    private readonly apiUrl: string,
    private readonly orchestrator: TaskOrchestrator,
  ) {}

  async pollOnce(): Promise<void> {
    // ... unchanged polling/ACK logic ...
    // Only change: await this.orchestrator.handle(task)
    // instead of: await this.handler(task)
  }
}
```

- Constructor changes from `handler: TaskHandler` to `orchestrator: TaskOrchestrator`
- Internal `pollOnce()` calls `this.orchestrator.handle(task)` instead of `this.handler(task)`
- All other logic (fetch, ACK, error handling, start/stop) unchanged

### 6.5 Updated Composition Root

```typescript
// index.ts
import { loadDaemonConfig, createLogger } from '@local-agent/shared';
import { Poller } from './poller';
import { TaskOrchestrator } from './core/task-orchestrator';

function main() {
  const config = loadDaemonConfig();
  const logger = createLogger('daemon', config.logLevel);

  logger.info({ apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs }, 'Starting daemon');

  const orchestrator = new TaskOrchestrator();
  const poller = new Poller(config.apiUrl, orchestrator);
  poller.start(config.pollIntervalMs);

  // ... shutdown handlers unchanged ...
}
```

## 7. Test Strategy

**Approach:** Preserve the previously intended coverage while adapting it to the routing design. No additional broad feature areas are required, but routing-specific cases must be covered so the final structure is not misleading.

### 7.1 Adapter Tests

The original handler tests become executor adapter tests under `adapters/__tests__/`:

- Claude adapter tests cover the Claude execution path
- TTADK adapter tests cover the TTADK execution path
- Both keep the same non-throwing subprocess-failure behavior expected by the poller/ACK flow

### 7.2 Poller Tests

The existing `__tests__/poller.test.ts` stays at the same level (poller is top-level):

- Update task fixtures so queued tasks include the required `executor`
- Continue to verify fetch, orchestration call, and ACK behavior
- Poller behavior remains unchanged aside from depending on orchestrator routing

### 7.3 Orchestrator Tests

`core/__tests__/task-orchestrator.test.ts` should verify routing behavior:

- `claude_code` tasks route to the Claude executor
- `ttadk` tasks route to the TTADK executor
- Unknown executor values are surfaced as failures so the poller does not ACK malformed work

## 8. Files Changed

| File | Action | Description |
|------|--------|-------------|
| `src/handler.ts` | **Delete** | Logic moves to `adapters/claude-cli-executor.ts` |
| `src/__tests__/handler.test.ts` | **Delete** | Moves to `adapters/__tests__/claude-cli-executor.test.ts` |
| `src/ports/task-executor.ts` | **Create** | `TaskExecutor` interface |
| `src/core/task-orchestrator.ts` | **Create** | `TaskOrchestrator` class |
| `src/core/__tests__/task-orchestrator.test.ts` | **Create** | Orchestrator routing tests |
| `src/adapters/claude-cli-executor.ts` | **Create** | Claude executor adapter |
| `src/adapters/ttadk-executor.ts` | **Create** | TTADK executor adapter |
| `src/adapters/__tests__/claude-cli-executor.test.ts` | **Create** | Claude adapter tests |
| `src/adapters/__tests__/ttadk-executor.test.ts` | **Create** | TTADK adapter tests |
| `src/index.ts` | **Modify** | Updated composition root to construct `TaskOrchestrator` directly |
| `src/poller.ts` | **Modify** | Constructor takes `TaskOrchestrator` instead of callback |
| `src/__tests__/poller.test.ts` | **Modify** | Updated task fixtures for required executor field |

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing tests | Existing adapter and poller coverage is preserved, and orchestrator routing coverage is made explicit for `claude_code`, `ttadk`, and unknown executors |
| Import path changes breaking builds | TypeScript compiler will catch any broken imports |
| Subtle behavior change in refactor | Keep polling/ACK behavior unchanged; only routing and file boundaries move |
| Over-engineering for 1 adapter | No longer applicable after dual-executor approval; keep the orchestrator and port surface minimal |

## 10. Acceptance Criteria

1. Existing adapter and poller tests pass after being updated for the new structure and required `executor` field
2. Routing coverage exists for `TaskOrchestrator` across Claude, TTADK, and unknown executor inputs
3. `rush build` succeeds with no TypeScript errors
4. No behavioral changes to polling/ACK flow or adapter subprocess error handling beyond executor selection
5. Clean architecture with focused responsibilities: poller calls the orchestrator, adapters implement `TaskExecutor`, and executor selection stays in `TaskOrchestrator`
