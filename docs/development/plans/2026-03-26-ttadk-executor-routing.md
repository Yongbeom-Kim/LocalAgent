# TTADK Executor Routing Implementation Plan

**Goal:** Add required per-task executor selection across shared, API, CLI, and daemon layers so the daemon can route tasks to either Claude Code or TTADK using the exact requested TTADK command shape.

**Architecture:** Introduce a shared executor contract in `@local-agent/shared`, thread the required `executor` field through API submission, queue storage, and CLI submission, then update the daemon’s `TaskOrchestrator` to branch on `task.executor` and instantiate the matching executor on demand. Add a dedicated `TTADKExecutor` adapter while keeping `ClaudeCliExecutor` intact for `claude_code` tasks.

**Tech Stack:** TypeScript 5.7, Vitest 1.6, Express, Commander, RabbitMQ, Rush monorepo, pnpm 9

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | **Modify** | Define shared executor constants/type and require `executor` in `TaskSubmission` and `Task` |
| `packages/shared/src/index.ts` | **Modify** | Re-export shared executor contract |
| `packages/api/src/routes/tasks.ts` | **Modify** | Validate `executor`, generate `task_id`, publish full task payload, return full task response |
| `packages/api/src/services/rabbitmq.ts` | **Modify** | Publish and retrieve full task payload including `task_id` and `executor` |
| `packages/api/src/__tests__/routes/tasks.test.ts` | **Modify** | Cover required executor field, invalid executor rejection, and response shape |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | **Modify** | Verify executor and task ID round-trip through queue service |
| `packages/cli/src/commands/submit.ts` | **Modify** | Require `--executor`, validate allowed executor values before sending requests, send executor in request body, parse richer success response |
| `packages/cli/src/__tests__/submit.test.ts` | **Modify** | Verify executor is required, invalid executors are rejected client-side, request payload includes executor, and success parsing still works |
| `packages/daemon/src/adapters/ttadk-executor.ts` | **Create** | Execute TTADK tasks with the exact required command semantics |
| `packages/daemon/src/adapters/__tests__/ttadk-executor.test.ts` | **Create** | Unit-test TTADK executor success, failures, missing binary, and empty payload handling |
| `packages/daemon/src/core/task-orchestrator.ts` | **Modify** | Branch on `task.executor` and instantiate the matching executor |
| `packages/daemon/src/core/__tests__/task-orchestrator.test.ts` | **Modify** | Verify claude branching, ttadk branching, invalid executor rejection, and unexpected executor failures propagate |
| `packages/daemon/src/index.ts` | **Modify** | Construct `TaskOrchestrator` directly without executor registry wiring |
| `packages/daemon/src/__tests__/poller.test.ts` | **Modify** | Add required executor field to task fixtures and verify poller behavior is unchanged when executor execution fails |
| `packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts` | **Modify** | Add required executor field to task fixtures so tests still reflect the shared type |
| `packages/daemon/src/**/*.test.ts` | **Review/Modify as needed** | Sweep remaining daemon task fixtures/object literals to add required executor field before package test run |
| `docs/development/design/2026-03-26-daemon-hexagonal-refactor-design.md` | **Modify** | Remove stale single-executor guidance if it conflicts with current feature |
| `docs/development/plans/2026-03-26-daemon-hexagonal-refactor.md` | **Modify** | Remove stale single-executor guidance if it conflicts with current feature |

---

## Task 1: Add shared executor contract

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing type expectations in consumers**

Use the existing compile-time pressure from current package tests by planning to add `executor` to all `Task`/`TaskSubmission` object literals in later tasks. The immediate failure signal for this task will be TypeScript errors in downstream packages once `executor` becomes required.

- [ ] **Step 2: Update the shared types**

```ts
// packages/shared/src/types.ts
export const TASK_EXECUTORS = ['claude_code', 'ttadk'] as const;
export type TaskExecutorType = (typeof TASK_EXECUTORS)[number];

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

- [ ] **Step 3: Re-export the new shared contract**

```ts
// packages/shared/src/index.ts
export { TaskSubmission, Task, TASK_EXECUTORS, type TaskExecutorType } from './types';
```

- [ ] **Step 4: Run a targeted typecheck to surface downstream failures**

Run: `pnpm --filter @local-agent/shared exec tsc --noEmit`

Expected: PASS in shared package, with downstream packages still pending updates.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts
git commit -m "feat(shared): add task executor contract"
```

---

## Task 2: Update API task submission and queue storage

**Files:**
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/api/src/services/rabbitmq.ts`
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`
- Modify: `packages/api/src/__tests__/services/rabbitmq.test.ts`

- [ ] **Step 1: Write/extend failing API route tests for required executor**

Add route tests that assert:
- `POST /tasks` succeeds when `executor: 'ttadk'`
- `POST /tasks` returns `400` when `executor` is missing
- `POST /tasks` returns `400` when `executor` is invalid
- success response includes `task_id` and `executor`
- `GET /tasks/next` response includes `executor`

Example additions:

```ts
it('returns 400 when executor missing', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({ task_type: 'generic', payload: 'hello' });

  expect(res.status).toBe(400);
});

it('returns 400 when executor invalid', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({ task_type: 'generic', payload: 'hello', executor: 'bad' });

  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Write/extend failing RabbitMQ service tests for full task round-trip**

Update queue tests so published/retrieved payloads include:

```ts
{
  task_id: 'task-123',
  task_type: 'generic',
  payload: 'hello',
  executor: 'claude_code',
  submitted_at: '2026-03-26T00:00:00.000Z',
}
```

Assert `getNext()` returns the same `task_id` and `executor` rather than generating a fresh ID.

- [ ] **Step 3: Run the API tests to verify they fail first**

Run: `pnpm --filter @local-agent/api vitest run src/__tests__/routes/tasks.test.ts src/__tests__/services/rabbitmq.test.ts`

Expected: FAIL because `executor` and `task_id` are not yet validated/preserved.

- [ ] **Step 4: Update route validation and response shape**

Implement minimal route changes in `packages/api/src/routes/tasks.ts`:

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { RabbitMQService } from '../services/rabbitmq';
import { TASK_EXECUTORS, type TaskExecutorType } from '@local-agent/shared';

const VALID_EXECUTORS = new Set<TaskExecutorType>(TASK_EXECUTORS);
```

Inside `POST /tasks`:

```ts
const { task_type, payload, executor } = req.body;

if (typeof executor !== 'string' || !VALID_EXECUTORS.has(executor as TaskExecutorType)) {
  res.status(400).json({ error: 'executor is required and must be one of: claude_code, ttadk' });
  return;
}

const task_id = uuidv4();
const submitted_at = new Date().toISOString();
const task = { task_id, task_type, payload, executor: executor as TaskExecutorType, submitted_at };
const buffered = rabbitmq.publish(task);

res.status(201).json(task);
```

- [ ] **Step 5: Update RabbitMQ storage to use full task payloads**

Replace the current publish signature with the shared task submission shape actually persisted by the API:

```ts
publish(message: Task): boolean {
  if (!this.channel) throw new Error('Not connected');
  const buffer = Buffer.from(JSON.stringify(message));
  return this.channel.sendToQueue(this.queueName, buffer, { persistent: true });
}
```

Update `getNext()` to stop generating `task_id` and instead return the parsed queued shape:

```ts
const parsed = JSON.parse(msg.content.toString()) as Task;
this.deliveryMap.set(parsed.task_id, msg as unknown as GetMessage);
return parsed;
```

Remove the now-unused `uuidv4` import from this service.

- [ ] **Step 6: Run the API tests again**

Run: `pnpm --filter @local-agent/api vitest run src/__tests__/routes/tasks.test.ts src/__tests__/services/rabbitmq.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/tasks.ts packages/api/src/services/rabbitmq.ts packages/api/src/__tests__/routes/tasks.test.ts packages/api/src/__tests__/services/rabbitmq.test.ts
git commit -m "feat(api): require executor in task payloads"
```

---

## Task 3: Update CLI submission contract

**Files:**
- Modify: `packages/cli/src/commands/submit.ts`
- Modify: `packages/cli/src/__tests__/submit.test.ts`

- [ ] **Step 1: Write/extend failing CLI tests for executor-aware submission**

Add a second negative test asserting the CLI rejects an unsupported executor value before making a request.

Example addition:

```ts
it('rejects unsupported executor values before submit', async () => {
  await expect(
    submitTask({
      payload: 'review this',
      type: 'code-review',
      executor: 'bad' as never,
      apiUrl: 'http://localhost:3000',
    }),
  ).rejects.toThrow(/executor/i);

  expect(fetch).not.toHaveBeenCalled();
});
```

Update submit tests so `submitTask()` is called with an `executor`, and assert request bodies contain it.

Add a success payload with executor and task_id:

```ts
json: async () => ({
  task_id: 'task-123',
  task_type: 'generic',
  payload: 'test prompt',
  executor: 'ttadk',
  submitted_at: '2026-03-26T10:00:00.000Z',
})
```

Update body expectation:

```ts
body: JSON.stringify({
  task_type: 'code-review',
  payload: 'review this',
  executor: 'claude_code',
})
```

- [ ] **Step 2: Run the CLI submit tests to verify they fail**

Run: `pnpm --filter @local-agent/cli vitest run src/__tests__/submit.test.ts`

Expected: FAIL because `SubmitOptions` and request body do not include executor yet.

- [ ] **Step 3: Update the CLI implementation minimally**

Change the command module to import the shared executor constants/type and require them in options.

```ts
import {
  DEFAULT_API_URL,
  TASK_EXECUTORS,
  type TaskSubmission,
  type TaskExecutorType,
} from '@local-agent/shared';

export interface SubmitOptions {
  payload: string;
  type: string;
  executor: TaskExecutorType;
  apiUrl: string;
}
```

Add a small shared validator in the CLI module so unsupported executors fail before the HTTP request:

```ts
const VALID_EXECUTORS = new Set<TaskExecutorType>(TASK_EXECUTORS);

function assertValidExecutor(executor: string): asserts executor is TaskExecutorType {
  if (!VALID_EXECUTORS.has(executor as TaskExecutorType)) {
    throw new Error('executor must be one of: claude_code, ttadk');
  }
}
```

Call that validator inside `submitTask()` before building the request body, and use the same allowed values in the Commander option description/help text.

```ts
const body: TaskSubmission = {
  task_type: options.type,
  payload: options.payload,
  executor: options.executor,
};
```

Require executor on the command:

```ts
.requiredOption('-e, --executor <executor>', 'Task executor (claude_code or ttadk)')
```

Update the action signature and submission call:

```ts
.action(async (opts: { payload: string; type: string; executor: TaskExecutorType; apiUrl?: string }) => {
  const apiUrl = opts.apiUrl ?? process.env.API_URL ?? DEFAULT_API_URL;
  const result = await submitTask({ payload: opts.payload, type: opts.type, executor: opts.executor, apiUrl });
```

- [ ] **Step 4: Run the CLI tests again**

Run: `pnpm --filter @local-agent/cli vitest run src/__tests__/submit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/submit.ts packages/cli/src/__tests__/submit.test.ts
git commit -m "feat(cli): require executor when submitting tasks"
```

---

## Task 4: Add TTADK executor adapter

**Files:**
- Create: `packages/daemon/src/adapters/ttadk-executor.ts`
- Create: `packages/daemon/src/adapters/__tests__/ttadk-executor.test.ts`

- [ ] **Step 1: Write the failing TTADK adapter tests**

Use the Claude adapter tests as a template, but assert the exact TTADK argument vector.

```ts
expect(mockExecFile).toHaveBeenCalledWith(
  'ttadk',
  ['code', '-t', 'claude', '-a', '--dangerously-skip-permissions -p', 'What is 2+2?'],
  { maxBuffer: 50 * 1024 * 1024 },
  expect.any(Function),
);
```

Include the same four behavioral cases plus one integration-oriented safeguard:
- success
- non-zero exit resolves after logging
- ENOENT resolves after logging
- empty payload skip
- orchestrator/poller-facing callers still observe a resolved promise so existing ACK flow is preserved

- [ ] **Step 2: Run the TTADK adapter tests to verify they fail**

Run: `pnpm --filter @local-agent/daemon vitest run src/adapters/__tests__/ttadk-executor.test.ts`

Expected: FAIL because `TTADKExecutor` does not exist yet.

- [ ] **Step 3: Implement the TTADK adapter**

Create `packages/daemon/src/adapters/ttadk-executor.ts`:

```ts
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Task, createLogger } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('daemon:ttadk');
const execFileAsync = promisify(execFile);

export class TTADKExecutor implements TaskExecutor {
  async execute(task: Task): Promise<void> {
    logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Spawning TTADK');

    if (!task.payload) {
      logger.error({ task_id: task.task_id }, 'Task payload is missing or empty — skipping');
      return;
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        'ttadk',
        ['code', '-t', 'claude', '-a', '--dangerously-skip-permissions -p', task.payload],
        { maxBuffer: 50 * 1024 * 1024 },
      );

      logger.info({ task_id: task.task_id, stdout, stderr }, 'TTADK completed');
    } catch (err) {
      const execErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      logger.error(
        {
          task_id: task.task_id,
          exit_code: execErr.code,
          stdout: execErr.stdout,
          stderr: execErr.stderr,
        },
        'TTADK failed',
      );
    }
  }
}
```

Implementation note: keep the adapter failure path non-throwing so `TaskOrchestrator`/`Poller` retain the current resolve-and-ack behavior described in the design non-goals.

- [ ] **Step 4a: Extend daemon routing tests for non-throwing failure behavior**

In `packages/daemon/src/core/__tests__/task-orchestrator.test.ts` and/or `packages/daemon/src/__tests__/poller.test.ts`, add a case where the selected executor encounters a logged failure path but `handle()`/poll processing still resolves. Assert no alternate executor is invoked and the caller can continue with the existing ACK flow.

- [ ] **Step 4b: Run the focused daemon tests again**

Run: `pnpm --filter @local-agent/daemon vitest run src/adapters/__tests__/ttadk-executor.test.ts src/core/__tests__/task-orchestrator.test.ts src/__tests__/poller.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/adapters/ttadk-executor.ts packages/daemon/src/adapters/__tests__/ttadk-executor.test.ts
git commit -m "feat(daemon): add TTADK executor adapter"
```

---

## Task 5: Route executors in the daemon orchestrator

**Files:**
- Modify: `packages/daemon/src/core/task-orchestrator.ts`
- Modify: `packages/daemon/src/core/__tests__/task-orchestrator.test.ts`
- Modify: `packages/daemon/src/index.ts`
- Modify: `packages/daemon/src/__tests__/poller.test.ts` (if needed for non-throwing failure/ACK verification)

- [ ] **Step 1: Rewrite orchestrator tests to drive branching behavior**

Replace the single-executor tests with constructor-mocking tests.

Example test shape:

```ts
const mockClaudeExecute = vi.fn();
const mockTTADKExecute = vi.fn();

vi.mock('../../adapters/claude-cli-executor', () => ({
  ClaudeCliExecutor: vi.fn().mockImplementation(() => ({ execute: mockClaudeExecute })),
}));

vi.mock('../../adapters/ttadk-executor', () => ({
  TTADKExecutor: vi.fn().mockImplementation(() => ({ execute: mockTTADKExecute })),
}));

const orchestrator = new TaskOrchestrator();
```

Add four tests:
- routes `claude_code` task to Claude executor only
- routes `ttadk` task to TTADK executor only
- logs/fails when `task.executor` is invalid via casted malformed task fixture so the poller does not ACK malformed work
- propagates unexpected executor rejections so polling does not ACK failed work

- [ ] **Step 2: Run orchestrator tests to verify they fail**

Run: `pnpm --filter @local-agent/daemon vitest run src/core/__tests__/task-orchestrator.test.ts`

Expected: FAIL because the orchestrator still lacks executor-aware branching.

- [ ] **Step 3: Update the orchestrator implementation**

Use task-directed branching and instantiate the matching adapter on demand.

```ts
import { Task, createLogger } from '@local-agent/shared';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';
import { TTADKExecutor } from '../adapters/ttadk-executor';
import { TaskExecutor } from '../ports/task-executor';

export class TaskOrchestrator {
  async handle(task: Task): Promise<void> {
    logger.info({ task_id: task.task_id, task_type: task.task_type, executor: task.executor }, 'Processing task');

    let executor: TaskExecutor;

    if (task.executor === 'claude_code') {
      executor = new ClaudeCliExecutor();
    } else if (task.executor === 'ttadk') {
      executor = new TTADKExecutor();
    } else {
      logger.error({ task_id: task.task_id, executor: task.executor }, 'Unknown task executor — skipping');
      return;
    }

    await executor.execute(task);
  }
}
```

- [ ] **Step 4: Update the composition root**

In `packages/daemon/src/index.ts`, construct the orchestrator directly:

```ts
const orchestrator = new TaskOrchestrator();
```

- [ ] **Step 5: Run the orchestrator tests again**

Run: `pnpm --filter @local-agent/daemon vitest run src/core/__tests__/task-orchestrator.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/core/task-orchestrator.ts packages/daemon/src/core/__tests__/task-orchestrator.test.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): route tasks by executor"
```

---

## Task 6: Update remaining daemon tests and fixtures for required executor

**Files:**
- Modify: `packages/daemon/src/__tests__/poller.test.ts`
- Modify: `packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts`

- [ ] **Step 1: Add `executor` to all task fixtures in daemon tests**

Update the explicitly listed daemon tests plus sweep any other daemon `*.test.ts` files that construct `Task` literals or helper factories, so Task 1's required shared contract does not leave hidden compile failures for later verification.

Examples:

```ts
executor: 'claude_code',
```

and for TTADK-specific fixtures where relevant:

```ts
executor: 'ttadk',
```

- [ ] **Step 2: Run the affected daemon tests to verify current failures are resolved**

Run:

```bash
pnpm --filter @local-agent/daemon vitest run src/__tests__/poller.test.ts src/adapters/__tests__/claude-cli-executor.test.ts
```

Then run a daemon package typecheck to catch any remaining task fixtures missed by the targeted test set:

```bash
pnpm --filter @local-agent/daemon exec tsc --noEmit
```

Expected: PASS once fixtures reflect the new shared type.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/__tests__/poller.test.ts packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts
git commit -m "test(daemon): add executor to task fixtures"
```

---

## Task 7: Align stale design docs with multi-executor behavior

**Files:**
- Modify: `docs/development/design/2026-03-26-daemon-hexagonal-refactor-design.md`
- Modify: `docs/development/plans/2026-03-26-daemon-hexagonal-refactor.md`

- [ ] **Step 1: Update stale single-executor references only where they now conflict**

Make the smallest doc changes needed so these earlier documents do not contradict the new approved design. Focus on sections that still imply:
- only one executor exists
- `TaskOrchestrator` always delegates to one executor
- queued tasks do not carry executor choice

- [ ] **Step 2: Read the updated doc sections for consistency**

Verify the earlier docs no longer contradict:
- required `executor`
- `TaskOrchestrator` routing
- TTADK support alongside Claude

- [ ] **Step 3: Commit**

```bash
git add docs/development/design/2026-03-26-daemon-hexagonal-refactor-design.md docs/development/plans/2026-03-26-daemon-hexagonal-refactor.md
git commit -m "docs: align daemon refactor specs with executor routing"
```

---

## Task 8: Run package-level verification

**Files:**
- No new files

- [ ] **Step 1: Run focused package test suites**

Run:

```bash
pnpm --filter @local-agent/api vitest run src/__tests__/routes/tasks.test.ts src/__tests__/services/rabbitmq.test.ts
pnpm --filter @local-agent/cli vitest run src/__tests__/submit.test.ts
pnpm --filter @local-agent/daemon vitest run src/core/__tests__/task-orchestrator.test.ts src/__tests__/poller.test.ts src/adapters/__tests__/claude-cli-executor.test.ts src/adapters/__tests__/ttadk-executor.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run broader package checks**

Run:

```bash
pnpm --filter @local-agent/shared exec tsc --noEmit
pnpm --filter @local-agent/api exec tsc --noEmit
pnpm --filter @local-agent/cli exec tsc --noEmit
pnpm --filter @local-agent/daemon exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run the repo-standard validation if used for this project**

Run: `rush build`

Expected: PASS.

- [ ] **Step 4: Commit verification-only follow-ups if needed**

If verification required code or test fixes, create a final commit describing the fix. If not, do not create an extra commit.

---

## Notes for the implementer

- Keep the TTADK adapter command arguments exactly as specified; do not split the `-a` payload further.
- Do not introduce default executor fallbacks anywhere.
- Keep daemon behavior on malformed executor values as **log and skip**, not throw.
- Prefer the smallest possible code changes that satisfy the new contract.
- When updating tests, make fixtures explicit rather than adding helpers that only save one or two lines.
- Use `@development:subagent-driven-execution` for implementation and `@development:review-and-fix` after implementation, per the broader workflow.
