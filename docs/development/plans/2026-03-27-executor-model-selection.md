# Executor Model Selection Implementation Plan

**Goal:** Add a required `executor_model` field so each task explicitly declares which model to use, validated per-executor at submission and passed through to the CLI invocation.

**Architecture:** A static `EXECUTOR_MODELS` map in `shared/types.ts` defines valid models per executor. API and CLI cross-validate executor+model pairs at submission time. Each daemon executor reads `task.executor_model` and passes it as-is to its CLI flag (`--model` for Claude and `claude-w`).

**Tech Stack:** TypeScript, Vitest, Commander.js, Express, RabbitMQ

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Add `EXECUTOR_MODELS` map, validation functions, `executor_model` on interfaces |
| `packages/shared/src/index.ts` | Modify | Re-export new symbols |
| `packages/shared/src/__tests__/types.test.ts` | Create | Unit tests for model validation functions |
| `packages/api/src/routes/tasks.ts` | Modify | Add `executor_model` validation and include in task |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Add executor_model validation tests |
| `packages/cli/src/commands/submit.ts` | Modify | Add `-m, --model` option, cross-validation, include in body |
| `packages/cli/src/__tests__/submit.test.ts` | Modify | Add model validation and request body tests |
| `packages/daemon/src/adapters/claude-cli-executor.ts` | Modify | Add `--model` flag to execFile args, remove stale comment |
| `packages/daemon/src/adapters/claude-w-executor.ts` | Modify | Replace hardcoded `gpt-5.4` with `task.executor_model`, remove stale comment |
| `packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts` | Modify | Verify `--model` in spawned args, add `executor_model` to fixture |
| `packages/daemon/src/adapters/__tests__/claude-w-executor.test.ts` | Modify | Verify `-m` uses `task.executor_model`, add to fixture |
| `packages/daemon/src/core/__tests__/task-orchestrator.test.ts` | Modify | Add `executor_model` to task fixtures |
| `packages/daemon/src/__tests__/poller.test.ts` | Modify | Add `executor_model` to task fixtures |

---

### Task 1: Shared types — model map and validation functions

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write failing tests for `isValidExecutorModel` and `getExecutorModelOptions`**

```ts
// packages/shared/src/__tests__/types.test.ts
import { describe, it, expect } from 'vitest';
import {
  EXECUTOR_MODELS,
  isValidExecutorModel,
  getExecutorModelOptions,
} from '../types';

describe('EXECUTOR_MODELS', () => {
  it('defines claude_code models', () => {
    expect(EXECUTOR_MODELS.claude_code).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('defines claude-w models', () => {
    expect(EXECUTOR_MODELS.claude-w).toEqual([
      'glm-5', 'kimi-k2.5', 'glm-4.7', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.2-codex',
    ]);
  });
});

describe('isValidExecutorModel', () => {
  it('returns true for valid claude_code model', () => {
    expect(isValidExecutorModel('claude_code', 'opus')).toBe(true);
    expect(isValidExecutorModel('claude_code', 'sonnet')).toBe(true);
    expect(isValidExecutorModel('claude_code', 'haiku')).toBe(true);
  });

  it('returns true for valid claude-w model', () => {
    expect(isValidExecutorModel('claude-w', 'gpt-5.4')).toBe(true);
    expect(isValidExecutorModel('claude-w', 'kimi-k2.5')).toBe(true);
  });

  it('returns false for cross-executor mismatch', () => {
    expect(isValidExecutorModel('claude_code', 'gpt-5.4')).toBe(false);
    expect(isValidExecutorModel('claude-w', 'opus')).toBe(false);
  });

  it('returns false for unknown model strings', () => {
    expect(isValidExecutorModel('claude_code', 'gpt-4o')).toBe(false);
    expect(isValidExecutorModel('claude-w', 'unknown')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isValidExecutorModel('claude_code', 123)).toBe(false);
    expect(isValidExecutorModel('claude_code', undefined)).toBe(false);
    expect(isValidExecutorModel('claude_code', null)).toBe(false);
  });
});

describe('getExecutorModelOptions', () => {
  it('returns comma-separated list for claude_code', () => {
    expect(getExecutorModelOptions('claude_code')).toBe('opus, sonnet, haiku');
  });

  it('returns comma-separated list for claude-w', () => {
    expect(getExecutorModelOptions('claude-w')).toBe(
      'glm-5, kimi-k2.5, glm-4.7, gpt-5.3-codex, gpt-5.4, gpt-5.2-codex',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`
Expected: FAIL — `isValidExecutorModel` and related exports do not exist yet.

- [ ] **Step 3: Implement `EXECUTOR_MODELS`, `isValidExecutorModel`, `getExecutorModelOptions` and add `executor_model` to interfaces**

```ts
// packages/shared/src/types.ts — full replacement
export const TASK_EXECUTORS = ['claude_code', 'claude-w'] as const;
export const TASK_EXECUTOR_OPTIONS = TASK_EXECUTORS.join(', ');
export type TaskExecutorType = (typeof TASK_EXECUTORS)[number];

export function isTaskExecutorType(value: unknown): value is TaskExecutorType {
  return typeof value === 'string' && TASK_EXECUTORS.includes(value as TaskExecutorType);
}

export const EXECUTOR_MODELS = {
  claude_code: ['opus', 'sonnet', 'haiku'],
  claude-w: ['glm-5', 'kimi-k2.5', 'glm-4.7', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.2-codex'],
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

- [ ] **Step 4: Update `packages/shared/src/index.ts` to re-export new symbols**

Add to the existing re-exports from `'./types'`:

```ts
export {
  TaskSubmission,
  Task,
  TASK_EXECUTORS,
  TASK_EXECUTOR_OPTIONS,
  isTaskExecutorType,
  type TaskExecutorType,
  EXECUTOR_MODELS,
  type ExecutorModelType,
  isValidExecutorModel,
  getExecutorModelOptions,
} from './types';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/shared && npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): add EXECUTOR_MODELS map and executor_model field to task interfaces"
```

---

### Task 2: API — validate `executor_model` on POST /tasks

**Files:**
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`

- [ ] **Step 1: Write failing tests for executor_model validation**

Add the following tests to the `describe('POST /tasks', ...)` block in `packages/api/src/__tests__/routes/tasks.test.ts`:

```ts
  it('returns 201 with executor_model in response', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello', executor: 'claude-w', executor_model: 'gpt-5.4' });
    expect(res.status).toBe(201);
    expect(res.body.executor_model).toBe('gpt-5.4');
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith(
      expect.objectContaining({ executor_model: 'gpt-5.4' }),
    );
  });

  it('returns 400 when executor_model is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello', executor: 'claude_code' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/executor_model/);
  });

  it('returns 400 when executor_model is invalid for executor', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello', executor: 'claude_code', executor_model: 'gpt-5.4' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/executor_model/);
    expect(res.body.error).toMatch(/opus/);
  });
```

Also update the **existing** `'returns 201 with submitted task'` test to include `executor_model`:

Change `.send({ task_type: 'generic', payload: 'hello', executor: 'claude-w' })` to `.send({ task_type: 'generic', payload: 'hello', executor: 'claude-w', executor_model: 'gpt-5.4' })` and add `expect(res.body.executor_model).toBe('gpt-5.4');`. Also update the `mockRabbitMQ.publish` assertion to include `executor_model: 'gpt-5.4'` in the expected object.

Update the existing `'returns 503'` test to include `executor_model: 'gpt-5.4'` in the send body.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/api && npx vitest run src/__tests__/routes/tasks.test.ts`
Expected: FAIL — new tests fail because executor_model not validated yet; existing 201 test fails because executor_model missing from request.

- [ ] **Step 3: Implement executor_model validation in the route**

In `packages/api/src/routes/tasks.ts`:

1. Update the import to include `isValidExecutorModel` and `getExecutorModelOptions`:

```ts
import { Task, TASK_EXECUTOR_OPTIONS, isTaskExecutorType, isValidExecutorModel, getExecutorModelOptions } from '@local-agent/shared';
```

2. Destructure `executor_model` from `req.body`:

```ts
const { task_type, payload, executor, executor_model } = req.body;
```

3. Add validation after the existing executor check (after line 24):

```ts
      if (!isValidExecutorModel(executor, executor_model)) {
        res.status(400).json({
          error: `executor_model must be one of: ${getExecutorModelOptions(executor)}`,
        });
        return;
      }
```

4. Include `executor_model` in the task construction:

```ts
      const task: Task = {
        task_id: uuidv4(),
        task_type,
        payload,
        executor,
        executor_model,
        submitted_at: new Date().toISOString(),
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/tasks.ts packages/api/src/__tests__/routes/tasks.test.ts
git commit -m "feat(api): validate executor_model on task submission"
```

---

### Task 3: CLI — add `-m, --model` option with cross-validation

**Files:**
- Modify: `packages/cli/src/commands/submit.ts`
- Modify: `packages/cli/src/__tests__/submit.test.ts`

- [ ] **Step 1: Write failing tests for model option and cross-validation**

In `packages/cli/src/__tests__/submit.test.ts`:

Update the import to include new shared symbols:

```ts
import { DEFAULT_API_URL, isValidExecutorModel, getExecutorModelOptions } from '@local-agent/shared';
```

Add to the `describe('submitTask', ...)` block:

```ts
  it('sends executor_model in request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_id: 'task-123',
        task_type: 'code-review',
        payload: 'review this',
        executor: 'claude-w',
        executor_model: 'gpt-5.4',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    await submitModule.submitTask({
      payload: 'review this',
      type: 'code-review',
      executor: 'claude-w',
      model: 'gpt-5.4',
      apiUrl: 'http://example.com:3000',
    });

    expect(mockFetch).toHaveBeenCalledWith('http://example.com:3000/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_type: 'code-review',
        payload: 'review this',
        executor: 'claude-w',
        executor_model: 'gpt-5.4',
      }),
    });
  });

  it('rejects invalid model for executor before submit', async () => {
    await expect(
      submitModule.submitTask({
        payload: 'test',
        type: 'generic',
        executor: 'claude_code',
        model: 'gpt-5.4',
        apiUrl: 'http://localhost:3000',
      }),
    ).rejects.toThrow(/executor_model/i);

    expect(mockFetch).not.toHaveBeenCalled();
  });
```

Add to the `describe('registerSubmitCommand', ...)` block:

```ts
  it('wires model from CLI --model option into submitTask', async () => {
    const submitTaskSpy = vi.fn().mockResolvedValue({
      success: true,
      taskType: 'generic',
      submittedAt: '2026-03-26T10:00:00.000Z',
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const program = new Command();
    submitModule.registerSubmitCommand(program, submitTaskSpy);

    await program.parseAsync(
      ['submit', '--payload', 'test', '--executor', 'claude-w', '--model', 'gpt-5.4'],
      { from: 'user' },
    );

    expect(submitTaskSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.4' }),
    );
  });
```

Also update existing tests to include `model` in their `SubmitOptions`:
- `'returns success with taskType and submittedAt on 201'`: add `model: 'opus'` to the options.
- `'sends correct request body and headers'`: add `model: 'gpt-5.4'` to the options, and update the expected body to include `executor_model: 'gpt-5.4'`.
- All other `submitTask` tests that pass `executor: 'claude_code'`: add `model: 'opus'` to their options (this includes `'returns error on HTTP 503'`, `'returns error on HTTP 400'`, `'returns connection error when fetch throws ECONNREFUSED'`, `'returns generic network error...'`, and `'returns invalid response error...'`).
- `'rejects unsupported executor values before submit'`: add `model: 'anything'` to the options (the model value doesn't matter since validation fails on executor first).
- `'wires explicit executor and apiUrl from CLI options'`: add `'--model', 'gpt-5.4'` to the CLI args and `model: 'gpt-5.4'` to expected call.
- `'uses DEFAULT_API_URL'`: add `'--model', 'opus'` to CLI args and `model: 'opus'` to expected call.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && npx vitest run src/__tests__/submit.test.ts`
Expected: FAIL — `model` not a property of `SubmitOptions`, `executor_model` not in body.

- [ ] **Step 3: Implement model option and cross-validation**

In `packages/cli/src/commands/submit.ts`:

1. Update imports:

```ts
import {
  DEFAULT_API_URL,
  TASK_EXECUTOR_OPTIONS,
  type TaskExecutorType,
  type TaskSubmission,
  isTaskExecutorType,
  isValidExecutorModel,
  getExecutorModelOptions,
} from '@local-agent/shared';
```

2. Add `model` to `SubmitOptions`:

```ts
export interface SubmitOptions {
  payload: string;
  type: string;
  executor: TaskExecutorType;
  model: string;
  apiUrl: string;
}
```

3. Add a validation function:

```ts
function assertValidExecutorModel(executor: TaskExecutorType, model: string): void {
  if (!isValidExecutorModel(executor, model)) {
    throw new Error(
      `executor_model must be one of: ${getExecutorModelOptions(executor)}`,
    );
  }
}
```

4. Call it in `submitTask` after `assertValidExecutor`:

```ts
export async function submitTask(options: SubmitOptions): Promise<SubmitResult> {
  assertValidExecutor(options.executor);
  assertValidExecutorModel(options.executor, options.model);
```

5. Include `executor_model` in the body:

```ts
  const body: TaskSubmission = {
    task_type: options.type,
    payload: options.payload,
    executor: options.executor,
    executor_model: options.model,
  };
```

6. Add required option in `registerSubmitCommand`:

```ts
    .requiredOption('-m, --model <string>', 'Executor model')
```

7. Update the action handler to include `model` in the opts type and pass it:

```ts
    .action(async (opts: { payload: string; type: string; executor: TaskExecutorType; model: string; apiUrl?: string }) => {
      const apiUrl = opts.apiUrl ?? process.env.API_URL ?? DEFAULT_API_URL;

      const result = await submit({
        payload: opts.payload,
        type: opts.type,
        executor: opts.executor,
        model: opts.model,
        apiUrl,
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && npx vitest run`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/submit.ts packages/cli/src/__tests__/submit.test.ts
git commit -m "feat(cli): add -m/--model option with executor cross-validation"
```

---

### Task 4: Daemon — Claude CLI executor passes `--model` flag

**Files:**
- Modify: `packages/daemon/src/adapters/claude-cli-executor.ts`
- Modify: `packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts`

- [ ] **Step 1: Update test fixture and expected args**

In `packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts`:

1. Add `executor_model` to the `createTask` fixture:

```ts
function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'claude_code',
    executor_model: 'opus',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}
```

2. Update the `'spawns claude with the task payload and resolves on success'` test to expect `--model`:

```ts
    expect(mockExecFile).toHaveBeenCalledWith(
      'claude',
      ['--dangerously-skip-permissions', '--model', 'opus', '-p', 'What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024 },
      expect.any(Function),
    );
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: FAIL — args assertion expects `--model opus` but executor doesn't include it yet.

- [ ] **Step 3: Add `--model` flag to Claude CLI executor**

In `packages/daemon/src/adapters/claude-cli-executor.ts`, replace the `execFileAsync` call inside the `try` block (and remove the stale `// Available models: ...` comment above it):

```ts
    try {
      const { stdout, stderr } = await execFileAsync(
        'claude',
        ['--dangerously-skip-permissions', '--model', task.executor_model, '-p', task.payload],
        {
          maxBuffer: 50 * 1024 * 1024,
        },
      );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/adapters/claude-cli-executor.ts packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts
git commit -m "feat(daemon): pass --model flag in Claude CLI executor"
```

---

### Task 5: Daemon — Claude W executor uses `task.executor_model`

**Files:**
- Modify: `packages/daemon/src/adapters/claude-w-executor.ts`
- Modify: `packages/daemon/src/adapters/__tests__/claude-w-executor.test.ts`

> **Note:** The existing `claude-w-executor.test.ts` has a pre-existing arg format mismatch with the source code. The test expects `['code', '-t', 'claude', '-a', '--dangerously-skip-permissions -p', 'What is 2+2?']` (no `-m` flag, `-a` value split across two args), but the source produces `['code', '-t', 'claude', '-m', 'gpt-5.4', '-a', '--dangerously-skip-permissions -p What is 2+2?']` (includes `-m`, `-a` value is one template-literal string). This task fixes both: (1) the pre-existing arg format bug and (2) dynamic model passthrough.

- [ ] **Step 1: Update test fixture and expected args**

In `packages/daemon/src/adapters/__tests__/claude-w-executor.test.ts`:

1. Add `executor_model` to the `createTask` fixture:

```ts
function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'claude-w',
    executor_model: 'gpt-5.4',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}
```

2. Update the `'spawns claude-w with the exact task payload arguments'` test to expect the `-m` flag and correct `-a` arg format (single template-literal string matching the source):

```ts
    expect(mockExecFile).toHaveBeenCalledWith(
      'claude-w',
      ['code', '-t', 'claude', '-m', 'gpt-5.4', '-a', '--dangerously-skip-permissions -p What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024 },
      expect.any(Function),
    );
```

Note: This step fixes the pre-existing test/source mismatch _and_ adds `executor_model`. The `-m` value `'gpt-5.4'` happens to match the current hardcoded value in the source.

- [ ] **Step 2: Run tests to verify they pass with the corrected args format**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/claude-w-executor.test.ts`
Expected: PASS (the corrected arg format now matches the source, and `executor_model: 'gpt-5.4'` matches the hardcoded value)

- [ ] **Step 3: Add a test that verifies the model comes from the task, not hardcoded**

Add this test to verify a _different_ model is passed through:

```ts
  it('passes executor_model to -m flag instead of hardcoded value', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'ok', '');
      return {} as ChildProcess;
    });

    await executor.execute(createTask({ executor_model: 'kimi-k2.5' }));

    expect(mockExecFile).toHaveBeenCalledWith(
      'claude-w',
      ['code', '-t', 'claude', '-m', 'kimi-k2.5', '-a', '--dangerously-skip-permissions -p What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024 },
      expect.any(Function),
    );
  });
```

- [ ] **Step 4: Run tests to verify the new test fails**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/claude-w-executor.test.ts`
Expected: FAIL — new test expects `kimi-k2.5` but executor hardcodes `gpt-5.4`.

- [ ] **Step 5: Replace hardcoded model with `task.executor_model`**

In `packages/daemon/src/adapters/claude-w-executor.ts`, replace the `execFileAsync` call inside the `try` block (and remove the stale `// Available models: ...` comment above it). The only change is replacing the hardcoded `'gpt-5.4'` with `task.executor_model`:

```ts
    try {
      const { stdout, stderr } = await execFileAsync(
        'claude-w',
        ['code', '-t', 'claude', '-m', task.executor_model, '-a', `--dangerously-skip-permissions -p ${task.payload}`],
        {
          maxBuffer: 50 * 1024 * 1024,
        },
      );
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/claude-w-executor.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/adapters/claude-w-executor.ts packages/daemon/src/adapters/__tests__/claude-w-executor.test.ts
git commit -m "feat(daemon): use task.executor_model in Claude W executor instead of hardcoded value"
```

---

### Task 6: Daemon — update task fixtures in orchestrator and poller tests

**Files:**
- Modify: `packages/daemon/src/core/__tests__/task-orchestrator.test.ts`
- Modify: `packages/daemon/src/__tests__/poller.test.ts`

- [ ] **Step 1: Add `executor_model` to the orchestrator test fixture**

In `packages/daemon/src/core/__tests__/task-orchestrator.test.ts`, update `createTask`:

```ts
function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'claude_code',
    executor_model: 'opus',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}
```

- [ ] **Step 2: Add `executor_model` to the poller test fixture**

In `packages/daemon/src/__tests__/poller.test.ts`, update `createTask`:

```ts
function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'abc-123',
    task_type: 'generic',
    payload: 'hello',
    executor: 'claude_code',
    executor_model: 'opus',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}
```

- [ ] **Step 3: Run all daemon tests**

Run: `cd packages/daemon && npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/core/__tests__/task-orchestrator.test.ts packages/daemon/src/__tests__/poller.test.ts
git commit -m "fix(daemon): add executor_model to test fixtures in orchestrator and poller tests"
```

---

### Task 7: Full build and test verification

- [ ] **Step 1: Build all packages**

Run: `node_modules/.bin/rush build`
Expected: ALL PASS — no TypeScript compilation errors.

- [ ] **Step 2: Run all tests across all packages**

Run: `node_modules/.bin/rush test`
Expected: ALL PASS across shared, api, cli, daemon.

- [ ] **Step 3: Commit any remaining fixes if needed**

If any tests fail due to missed fixture updates, fix and commit.

- [ ] **Step 4: Final commit (if no fixes needed, skip)**

No action needed if Step 2 passes cleanly.
