# Claude Code Subprocess Spawning Implementation Plan

**Goal:** When the daemon consumes a task, spawn a Claude Code CLI subprocess with the task payload as the prompt, then log the result.

**Architecture:** Modify the existing `handleTask` function in `packages/daemon/src/handler.ts` to use Node.js `child_process.execFile` (promisified) to run `claude -p '<payload>'`. Capture stdout/stderr after completion and log via Pino. Errors are logged but swallowed so the poller still ACKs.

**Tech Stack:** Node.js `child_process` + `util.promisify` (built-in), Vitest for tests

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/daemon/src/handler.ts` | Modify | Spawn Claude Code subprocess, capture and log output |
| `packages/daemon/src/__tests__/handler.test.ts` | Modify | Test success, failure, and error-swallowing behavior |

No new files. No new dependencies.

---

### Task 1: Update handler tests (TDD — write failing tests first)

**Files:**
- Modify: `packages/daemon/src/__tests__/handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the existing test file with tests that expect subprocess behavior:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Task } from '@local-agent/shared';

// Mock child_process before importing handler
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { handleTask } from '../handler';
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

describe('handleTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns claude with the task payload and resolves on success', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, { stdout: 'The answer is 4', stderr: '' });
      return {} as any;
    });

    await expect(handleTask(createTask())).resolves.toBeUndefined();

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
      (callback as Function)(error);
      return {} as any;
    });

    await expect(handleTask(createTask())).resolves.toBeUndefined();
  });

  it('resolves without throwing when claude binary is not found', async () => {
    const error = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
      stdout: '',
      stderr: '',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(error);
      return {} as any;
    });

    await expect(handleTask(createTask())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon && npx vitest run src/__tests__/handler.test.ts`
Expected: FAIL — current handler doesn't call `execFile`

---

### Task 2: Implement the handler

**Files:**
- Modify: `packages/daemon/src/handler.ts`

- [ ] **Step 3: Replace handler implementation**

Replace the entire contents of `handler.ts` with:

```typescript
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Task, createLogger } from '@local-agent/shared';

const logger = createLogger('daemon:handler');
const execFileAsync = promisify(execFile);

export async function handleTask(task: Task): Promise<void> {
  logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Spawning Claude Code');

  try {
    const { stdout, stderr } = await execFileAsync('claude', ['-p', task.payload], {
      maxBuffer: 50 * 1024 * 1024, // 50 MB — Claude Code responses can be large
    });

    logger.info(
      { task_id: task.task_id, stdout, stderr },
      'Claude Code completed',
    );
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/__tests__/handler.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Run the full daemon test suite**

Run: `cd packages/daemon && npx vitest run`
Expected: All tests PASS (handler + poller tests)

- [ ] **Step 6: Build to verify TypeScript compiles**

Run: `cd packages/daemon && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/handler.ts packages/daemon/src/__tests__/handler.test.ts
git commit -m "feat(daemon): spawn Claude Code subprocess for each consumed task"
```
