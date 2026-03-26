# Daemon Hexagonal Architecture Refactor — Implementation Plan

**Goal:** Refactor the daemon package from a flat structure into hexagonal architecture with ports, adapters, and a core orchestration layer — no functional changes.

**Architecture:** Introduce a `TaskExecutor` port interface in `ports/`, a `ClaudeCliExecutor` adapter in `adapters/`, and a thin `TaskOrchestrator` core service in `core/`. The composition root (`index.ts`) wires everything via explicit constructor injection. The poller remains top-level infrastructure and accepts the orchestrator directly.

**Tech Stack:** TypeScript 5.7, Vitest 1.6, Rush 5 monorepo, pnpm 9

**Design Spec:** `docs/development/design/2026-03-26-daemon-hexagonal-refactor-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/daemon/src/ports/task-executor.ts` | **Create** | `TaskExecutor` interface — outbound port contract |
| `packages/daemon/src/core/task-orchestrator.ts` | **Create** | `TaskOrchestrator` class — thin core service delegating to port |
| `packages/daemon/src/adapters/claude-cli-executor.ts` | **Create** | `ClaudeCliExecutor` class — implements `TaskExecutor` via `execFile` |
| `packages/daemon/src/core/__tests__/task-orchestrator.test.ts` | **Create** | Unit tests for orchestrator delegation |
| `packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts` | **Create** | Adapted tests from `handler.test.ts` |
| `packages/daemon/src/poller.ts` | **Modify** | Accept `TaskOrchestrator` instead of callback |
| `packages/daemon/src/__tests__/poller.test.ts` | **Modify** | Use `TaskOrchestrator` with mock executor |
| `packages/daemon/src/index.ts` | **Modify** | Updated composition root with DI wiring |
| `packages/daemon/src/handler.ts` | **Delete** | Logic moved to `ClaudeCliExecutor` |
| `packages/daemon/src/__tests__/handler.test.ts` | **Delete** | Tests moved to `adapters/__tests__/` |

---

## Task 1: Create TaskExecutor Port Interface

**Files:**
- Create: `packages/daemon/src/ports/task-executor.ts`

- [ ] **Step 1: Create the port interface file**

```typescript
// packages/daemon/src/ports/task-executor.ts
import { Task } from '@local-agent/shared';

export interface TaskExecutor {
  execute(task: Task): Promise<void>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/daemon && npx tsc --noEmit`
Expected: No errors (interface has no implementation to break)

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/ports/task-executor.ts
git commit -m "refactor(daemon): add TaskExecutor port interface"
```

---

## Task 2: Create TaskOrchestrator Core Service + Tests

**Files:**
- Create: `packages/daemon/src/core/task-orchestrator.ts`
- Create: `packages/daemon/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/daemon/src/core/__tests__/task-orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Task } from '@local-agent/shared';
import { TaskOrchestrator } from '../task-orchestrator';
import { TaskExecutor } from '../../ports/task-executor';

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('TaskOrchestrator', () => {
  let mockExecutor: TaskExecutor;
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    mockExecutor = { execute: vi.fn().mockResolvedValue(undefined) };
    orchestrator = new TaskOrchestrator(mockExecutor);
  });

  it('delegates task execution to the injected executor', async () => {
    const task = createTask();
    await orchestrator.handle(task);
    expect(mockExecutor.execute).toHaveBeenCalledWith(task);
  });

  it('propagates executor errors', async () => {
    const error = new Error('executor failed');
    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockRejectedValue(error);
    await expect(orchestrator.handle(createTask())).rejects.toThrow('executor failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon && npx vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: FAIL — `TaskOrchestrator` does not exist yet

- [ ] **Step 3: Write the TaskOrchestrator implementation**

```typescript
// packages/daemon/src/core/task-orchestrator.ts
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon && npx vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: PASS — both tests green

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/core/task-orchestrator.ts packages/daemon/src/core/__tests__/task-orchestrator.test.ts
git commit -m "refactor(daemon): add TaskOrchestrator core service with tests"
```

---

## Task 3: Create ClaudeCliExecutor Adapter + Tests

**Files:**
- Create: `packages/daemon/src/adapters/claude-cli-executor.ts`
- Create: `packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts`

- [ ] **Step 1: Write the adapter test file**

Adapt the existing `handler.test.ts` — same 4 test cases, but using class instantiation instead of free function import.

```typescript
// packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { Task } from '@local-agent/shared';

// Mock child_process before importing adapter (Vitest hoists vi.mock calls)
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { ClaudeCliExecutor } from '../claude-cli-executor';
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

describe('ClaudeCliExecutor', () => {
  let executor: ClaudeCliExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new ClaudeCliExecutor();
  });

  it('spawns claude with the task payload and resolves on success', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'The answer is 4', '');
      return {} as ChildProcess;
    });

    await expect(executor.execute(createTask())).resolves.toBeUndefined();

    expect(mockExecFile).toHaveBeenCalledWith(
      'claude',
      ['-p', 'What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024 },
      expect.any(Function),
    );
  });

  it('resolves without throwing when claude exits with non-zero code', async () => {
    const error = Object.assign(new Error('Process exited with code 1'), {
      code: 1,
      stdout: 'partial output',
      stderr: 'something went wrong',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    await expect(executor.execute(createTask())).resolves.toBeUndefined();
  });

  it('resolves without throwing when claude binary is not found', async () => {
    const error = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
      stdout: '',
      stderr: '',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    await expect(executor.execute(createTask())).resolves.toBeUndefined();
  });

  it('skips spawning when payload is empty', async () => {
    await expect(executor.execute(createTask({ payload: '' }))).resolves.toBeUndefined();

    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: FAIL — `ClaudeCliExecutor` does not exist yet

- [ ] **Step 3: Write the ClaudeCliExecutor implementation**

Move the logic from `handler.ts` into a class implementing `TaskExecutor`:

```typescript
// packages/daemon/src/adapters/claude-cli-executor.ts
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Task, createLogger } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('daemon:claude-cli');
const execFileAsync = promisify(execFile);

export class ClaudeCliExecutor implements TaskExecutor {
  async execute(task: Task): Promise<void> {
    logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Spawning Claude Code');

    if (!task.payload) {
      logger.error({ task_id: task.task_id }, 'Task payload is missing or empty — skipping');
      return;
    }

    try {
      const { stdout, stderr } = await execFileAsync('claude', ['-p', task.payload], {
        maxBuffer: 50 * 1024 * 1024, // 50 MB — Claude Code responses can be large
      });

      logger.info(
        { task_id: task.task_id, stdout, stderr },
        'Claude Code completed',
      );
    } catch (err) {
      const execErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      logger.error(
        {
          task_id: task.task_id,
          exit_code: execErr.code,
          stdout: execErr.stdout,
          stderr: execErr.stderr,
        },
        'Claude Code failed',
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: PASS — all 4 tests green

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/adapters/claude-cli-executor.ts packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts
git commit -m "refactor(daemon): add ClaudeCliExecutor adapter with tests"
```

---

## Task 4: Update Poller to Accept TaskOrchestrator + Update Tests

**Files:**
- Modify: `packages/daemon/src/poller.ts`
- Modify: `packages/daemon/src/__tests__/poller.test.ts`

- [ ] **Step 1: Update the poller test to use TaskOrchestrator**

Replace the mock handler function with a `TaskOrchestrator` instance backed by a mock `TaskExecutor`:

```typescript
// packages/daemon/src/__tests__/poller.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Poller } from '../poller';
import { Task } from '@local-agent/shared';
import { TaskOrchestrator } from '../core/task-orchestrator';
import { TaskExecutor } from '../ports/task-executor';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Poller', () => {
  let poller: Poller;
  let mockExecutor: TaskExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutor = { execute: vi.fn().mockResolvedValue(undefined) };
    const orchestrator = new TaskOrchestrator(mockExecutor);
    poller = new Poller('http://localhost:3000', orchestrator);
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches next task and calls orchestrator + ack when task available', async () => {
      const task: Task = {
        task_id: 'abc-123',
        task_type: 'generic',
        payload: 'hello',
        submitted_at: '2026-03-26T00:00:00.000Z',
      };

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(task),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks/next');
      expect(mockExecutor.execute).toHaveBeenCalledWith(task);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks/abc-123/ack', {
        method: 'POST',
      });
    });

    it('does nothing when queue is empty (204)', async () => {
      mockFetch.mockResolvedValueOnce({ status: 204 });
      await poller.pollOnce();
      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      // Should not throw
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon && npx vitest run src/__tests__/poller.test.ts`
Expected: FAIL — `Poller` constructor still expects `TaskHandler` callback, not `TaskOrchestrator`

- [ ] **Step 3: Update poller.ts to accept TaskOrchestrator**

Replace the full file content:

```typescript
// packages/daemon/src/poller.ts
import { Task, createLogger } from '@local-agent/shared';
import { TaskOrchestrator } from './core/task-orchestrator';

const logger = createLogger('daemon:poller');

export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly apiUrl: string,
    private readonly orchestrator: TaskOrchestrator,
  ) {}

  async pollOnce(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/tasks/next`);

      if (res.status === 204) {
        logger.debug('No tasks available');
        return;
      }

      if (res.status !== 200) {
        logger.warn({ status: res.status }, 'Unexpected response from API');
        return;
      }

      const task = (await res.json()) as Task;
      logger.info({ task_id: task.task_id }, 'Received task');

      await this.orchestrator.handle(task);

      try {
        const ackRes = await fetch(`${this.apiUrl}/tasks/${task.task_id}/ack`, { method: 'POST' });
        if (ackRes.status !== 200) {
          logger.warn({ task_id: task.task_id, status: ackRes.status }, 'ACK failed');
        } else {
          logger.info({ task_id: task.task_id }, 'Task acknowledged');
        }
      } catch (ackErr) {
        logger.error({ task_id: task.task_id, err: ackErr }, 'ACK request failed');
      }
    } catch (err) {
      logger.error({ err }, 'Poll error');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs }, 'Starting poller');
    this.running = true;
    const loop = async () => {
      await this.pollOnce();
      if (this.running) {
        this.timer = setTimeout(loop, intervalMs);
      }
    };
    loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      logger.info('Poller stopped');
    }
  }
}
```

Changes from original:
- Line 2: Import `TaskOrchestrator` instead of defining `TaskHandler` type
- Line 5: Removed `type TaskHandler` line
- Line 11: Constructor parameter `handler: TaskHandler` → `orchestrator: TaskOrchestrator`
- Line 33: `await this.handler(task)` → `await this.orchestrator.handle(task)`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon && npx vitest run src/__tests__/poller.test.ts`
Expected: PASS — all 3 tests green

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/poller.ts packages/daemon/src/__tests__/poller.test.ts
git commit -m "refactor(daemon): update Poller to accept TaskOrchestrator"
```

---

## Task 5: Update Composition Root + Delete Old Files

**Files:**
- Modify: `packages/daemon/src/index.ts`
- Delete: `packages/daemon/src/handler.ts`
- Delete: `packages/daemon/src/__tests__/handler.test.ts`

- [ ] **Step 1: Update index.ts composition root**

```typescript
// packages/daemon/src/index.ts
import { loadDaemonConfig, createLogger } from '@local-agent/shared';
import { Poller } from './poller';
import { TaskOrchestrator } from './core/task-orchestrator';
import { ClaudeCliExecutor } from './adapters/claude-cli-executor';

function main() {
  const config = loadDaemonConfig();
  const logger = createLogger('daemon', config.logLevel);

  logger.info({ apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs }, 'Starting daemon');

  const executor = new ClaudeCliExecutor();
  const orchestrator = new TaskOrchestrator(executor);
  const poller = new Poller(config.apiUrl, orchestrator);
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down daemon...');
    poller.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
```

Changes from original:
- Line 3-4: Import `TaskOrchestrator` and `ClaudeCliExecutor` instead of `handleTask`
- Lines 13-15: Three-line DI wiring instead of single `new Poller(config.apiUrl, handleTask)`

- [ ] **Step 2: Delete old handler.ts and its test**

```bash
rm packages/daemon/src/handler.ts
rm packages/daemon/src/__tests__/handler.test.ts
```

- [ ] **Step 3: Run all daemon tests**

Run: `cd packages/daemon && npx vitest run`
Expected: PASS — all tests green (2 orchestrator + 4 adapter + 3 poller = 9 total)

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd packages/daemon && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/index.ts
git rm packages/daemon/src/handler.ts packages/daemon/src/__tests__/handler.test.ts
git commit -m "refactor(daemon): wire hexagonal DI in composition root, remove old handler"
```

---

## Task 6: Full Build Verification

- [ ] **Step 1: Run full monorepo build**

Run: `node common/scripts/install-run-rush.js build --to @local-agent/daemon`
Expected: Build succeeds for `shared` + `daemon`

- [ ] **Step 2: Run all daemon tests one final time**

Run: `cd packages/daemon && npx vitest run`
Expected: All 9 tests pass (2 orchestrator + 4 adapter + 3 poller)

- [ ] **Step 3: Verify directory structure matches spec**

Run: `find packages/daemon/src -type f -name '*.ts' | sort`

Expected output:
```
packages/daemon/src/__tests__/poller.test.ts
packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts
packages/daemon/src/adapters/claude-cli-executor.ts
packages/daemon/src/core/__tests__/task-orchestrator.test.ts
packages/daemon/src/core/task-orchestrator.ts
packages/daemon/src/index.ts
packages/daemon/src/poller.ts
packages/daemon/src/ports/task-executor.ts
```

- [ ] **Step 4: Final commit (if any uncommitted changes remain)**

```bash
git status
# If clean, no action needed
```
