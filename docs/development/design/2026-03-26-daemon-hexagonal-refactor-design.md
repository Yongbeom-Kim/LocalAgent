# Daemon Hexagonal Architecture Refactor

**Date:** 2026-03-26
**Type:** Pure refactor (no functional change)
**Package:** `@local-agent/daemon`

## 1. Context

The daemon package currently has 3 source files with a flat structure:

- `index.ts` — composition root (loads config, wires Poller + handler, registers shutdown)
- `poller.ts` — HTTP polling infrastructure (fetches tasks from API, calls handler, ACKs)
- `handler.ts` — spawns `claude -p '<payload>'` via `execFile`, logs results

The handler is passed to the Poller as a callback function (`TaskHandler` type). There is no formal separation between domain logic, port interfaces, and adapter implementations.

## 2. Goal

Refactor the daemon to follow hexagonal (ports & adapters) architecture:

- Define an explicit **outbound port** (`TaskExecutor` interface) for task execution
- Implement a **Claude Code CLI adapter** (`ClaudeCliExecutor` class) that fulfills this port
- Introduce a thin **core orchestration service** (`TaskOrchestrator`) that the poller calls, which delegates to the port
- Wire everything via explicit constructor injection in the composition root (`index.ts`)

**Non-goals:**
- No functional changes to behavior
- No new features or error handling changes
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
  ├── new ClaudeCliExecutor()                     ← adapter
  ├── new TaskOrchestrator(executor)              ← core
  └── new Poller(apiUrl, orchestrator)            ← infrastructure
        ├── fetch /tasks/next
        ├── await orchestrator.handle(task)       ← calls core
        └── fetch /tasks/:id/ack

core/task-orchestrator.ts
  └── this.executor.execute(task)                 ← calls port

ports/task-executor.ts
  └── interface TaskExecutor { execute(task): Promise<void> }

adapters/claude-cli-executor.ts
  └── implements TaskExecutor using execFile('claude', ...)
```

**Dependencies flow:**
- `index.ts` → knows all concrete types (composition root)
- `core/` → depends only on `ports/` (dependency inversion)
- `adapters/` → depends on `ports/` (implements interfaces)
- `poller.ts` → depends on `core/` (calls orchestrator)

## 5. Directory Structure

```
packages/daemon/src/
├── index.ts                              # Composition root (DI wiring)
├── poller.ts                             # Infrastructure (updated to accept TaskOrchestrator)
├── core/
│   ├── task-orchestrator.ts              # Thin orchestration service
│   └── __tests__/
│       └── task-orchestrator.test.ts     # Tests with mock TaskExecutor
├── ports/
│   └── task-executor.ts                  # TaskExecutor interface
└── adapters/
    ├── claude-cli-executor.ts            # Implements TaskExecutor via execFile
    └── __tests__/
        └── claude-cli-executor.test.ts   # Existing handler tests, relocated
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
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('daemon:orchestrator');

export class TaskOrchestrator {
  constructor(private readonly executor: TaskExecutor) {}

  async handle(task: Task): Promise<void> {
    logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Processing task');
    await this.executor.execute(task);
  }
}
```

- Accepts `TaskExecutor` via constructor injection
- Thin delegation for now; natural extension point for future domain logic
- The `handle` method signature matches what the poller needs

### 6.3 Adapter: ClaudeCliExecutor

```typescript
// adapters/claude-cli-executor.ts
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Task, createLogger } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('daemon:claude-cli');
const execFileAsync = promisify(execFile);

export class ClaudeCliExecutor implements TaskExecutor {
  async execute(task: Task): Promise<void> {
    // Exact same logic as current handleTask()
    // - Validates payload
    // - Spawns claude -p '<payload>'
    // - Logs stdout/stderr
    // - Catches and logs errors without rethrowing
  }
}
```

- Class implementing `TaskExecutor` interface
- Contains the exact same logic as current `handler.ts` `handleTask()` function
- No behavioral changes

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
import { ClaudeCliExecutor } from './adapters/claude-cli-executor';

function main() {
  const config = loadDaemonConfig();
  const logger = createLogger('daemon', config.logLevel);

  logger.info({ apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs }, 'Starting daemon');

  // Dependency injection: adapter → core → infrastructure
  const executor = new ClaudeCliExecutor();
  const orchestrator = new TaskOrchestrator(executor);
  const poller = new Poller(config.apiUrl, orchestrator);
  poller.start(config.pollIntervalMs);

  // ... shutdown handlers unchanged ...
}
```

## 7. Test Strategy

**Approach:** Update existing tests to work with the new structure. All current test cases must pass. No new test cases required.

### 7.1 Handler Tests → Adapter Tests

The existing `__tests__/handler.test.ts` moves to `adapters/__tests__/claude-cli-executor.test.ts`:

- Same 4 test cases (success, non-zero exit, ENOENT, empty payload)
- Change import from `handleTask` to `ClaudeCliExecutor` class
- Instantiate `new ClaudeCliExecutor()` and call `executor.execute(task)` instead of `handleTask(task)`
- Same mocking of `node:child_process`

### 7.2 Poller Tests

The existing `__tests__/poller.test.ts` stays at the same level (poller is top-level):

- Update to provide a `TaskOrchestrator` instance (with a mock `TaskExecutor`) instead of a mock handler function
- Same 3 test cases (task available + ACK, empty queue, fetch error)
- The mock handler becomes: `new TaskOrchestrator({ execute: mockExecute })`

### 7.3 Orchestrator Tests (new, minimal)

`core/__tests__/task-orchestrator.test.ts`:

- Verify orchestrator delegates to executor
- Mock `TaskExecutor` interface, verify `execute()` is called with the task

## 8. Files Changed

| File | Action | Description |
|------|--------|-------------|
| `src/handler.ts` | **Delete** | Logic moves to `adapters/claude-cli-executor.ts` |
| `src/__tests__/handler.test.ts` | **Delete** | Moves to `adapters/__tests__/claude-cli-executor.test.ts` |
| `src/ports/task-executor.ts` | **Create** | `TaskExecutor` interface |
| `src/core/task-orchestrator.ts` | **Create** | `TaskOrchestrator` class |
| `src/core/__tests__/task-orchestrator.test.ts` | **Create** | Orchestrator unit tests |
| `src/adapters/claude-cli-executor.ts` | **Create** | `ClaudeCliExecutor` class (logic from handler.ts) |
| `src/adapters/__tests__/claude-cli-executor.test.ts` | **Create** | Tests from handler.test.ts, adapted |
| `src/index.ts` | **Modify** | Updated composition root with DI wiring |
| `src/poller.ts` | **Modify** | Constructor takes `TaskOrchestrator` instead of callback |
| `src/__tests__/poller.test.ts` | **Modify** | Updated to use `TaskOrchestrator` with mock executor |

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing tests | All 7 existing test cases are preserved and adapted |
| Import path changes breaking builds | TypeScript compiler will catch any broken imports |
| Subtle behavior change in refactor | No logic changes; only moving code and wrapping in class |
| Over-engineering for 1 adapter | Kept minimal: thin orchestrator, single port, no DI framework |

## 10. Acceptance Criteria

1. All existing tests pass (adapted to new structure)
2. `rush build` succeeds with no TypeScript errors
3. No behavioral changes — same logging, same error handling, same subprocess invocation
4. Clean hex architecture: core depends only on ports, adapters implement ports
