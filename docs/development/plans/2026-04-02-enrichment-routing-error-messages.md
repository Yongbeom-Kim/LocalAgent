# Enrichment Routing Error Messages Implementation Plan

**Goal:** Make invalid executor/model errors for Lark `/task` and explicit `/new` commands reach enrichment, then reply back to the user with exact option lists and command-appropriate wording.

**Architecture:** Keep parsing in `lark-listener` unchanged, preserve the existing rejection-to-Lark transport in `enrichment-poller`, and shift only the Lark semantic routing-validation boundary from `/tasks` into `EnrichmentService`. Centralize the new copy in a tiny shared helper module so enrichment can distinguish invalid executor vs invalid model without duplicating long option-list formatting.

**Tech Stack:** TypeScript, Express, Vitest, shared validation helpers in `@local-agent/shared`, Lark task source plumbing

**Design doc:** `docs/development/design/2026-04-02-enrichment-routing-error-messages-design.md`

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/routing-errors.ts` | Create | Build exact invalid-executor and invalid-model messages for `/task` and `/new` using shared option data |
| `packages/shared/src/index.ts` | Modify | Re-export routing-error helpers |
| `packages/shared/src/__tests__/routing-errors.test.ts` | Create | Lock the exact user-facing strings and option-list formatting |
| `packages/api/src/routes/tasks.ts` | Modify | Defer executor/model semantic validation only for Lark-sourced tasks |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Prove Lark tasks are deferred while non-Lark tasks still fail fast |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Replace generic routing errors with exact `/task` and `/new` messages while guarding executor before model lookup |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Assert exact rejection reasons, precedence, and no-crash behavior for invalid executor strings |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Modify | Confirm enrichment rejection text still gets published verbatim to `/results` for Lark tasks |

### Important non-changes

- `packages/daemon/lark-listener/src/message-handler.ts` should remain unchanged.
- `packages/daemon/lark-listener/src/adapters/task-submitter.ts` should remain unchanged.
- `packages/shared/src/types.ts` should remain unchanged unless the implementer discovers a helper-export need that cannot be satisfied cleanly from `routing-errors.ts`.
- Do **not** widen `Task.executor` or `TaskSubmission.executor` types just to support this flow; use runtime guards in enrichment and `as any` only in tests that intentionally simulate invalid queued values.

---

### Task 1: Add shared routing-error formatters

**Files:**
- Create: `packages/shared/src/routing-errors.ts`
- Create: `packages/shared/src/__tests__/routing-errors.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing shared tests**

Create `packages/shared/src/__tests__/routing-errors.test.ts` with exact string assertions:

```ts
import { describe, expect, it } from 'vitest';
import {
  formatInvalidExecutorMessage,
  formatInvalidModelMessage,
} from '../routing-errors';
import { TASK_EXECUTOR_OPTIONS, getExecutorModelOptions } from '../types';

describe('formatInvalidExecutorMessage', () => {
  it('formats /task invalid executor message', () => {
    expect(formatInvalidExecutorMessage('/task', 'foo')).toBe(
      `Invalid executor "foo". Available executors: ${TASK_EXECUTOR_OPTIONS}`,
    );
  });

  it('formats /new invalid executor message', () => {
    expect(formatInvalidExecutorMessage('/new', 'foo')).toBe(
      `Invalid executor "foo" for /new. Available executors: ${TASK_EXECUTOR_OPTIONS}`,
    );
  });
});

describe('formatInvalidModelMessage', () => {
  it('formats /task invalid model message', () => {
    expect(formatInvalidModelMessage('/task', 'cursor', 'xyz')).toBe(
      `Invalid model "xyz" for executor "cursor". Available models: ${getExecutorModelOptions('cursor')}`,
    );
  });

  it('formats /new invalid model message', () => {
    expect(formatInvalidModelMessage('/new', 'cursor', 'xyz')).toBe(
      `Invalid model "xyz" for /new executor "cursor". Available models: ${getExecutorModelOptions('cursor')}`,
    );
  });
});
```

- [ ] **Step 2: Run the new shared test to confirm it fails**

Run from the repo root:

```bash
cd packages/shared && npx vitest run src/__tests__/routing-errors.test.ts
```

Expected: FAIL because `routing-errors.ts` and its exports do not exist yet.

- [ ] **Step 3: Implement the shared helper module**

Create `packages/shared/src/routing-errors.ts`:

```ts
import { TASK_EXECUTOR_OPTIONS, getExecutorModelOptions, type TaskExecutorType } from './types';

export type RoutingCommandLabel = '/task' | '/new';

export function formatInvalidExecutorMessage(
  command: RoutingCommandLabel,
  executor: string,
): string {
  if (command === '/new') {
    return `Invalid executor "${executor}" for /new. Available executors: ${TASK_EXECUTOR_OPTIONS}`;
  }
  return `Invalid executor "${executor}". Available executors: ${TASK_EXECUTOR_OPTIONS}`;
}

export function formatInvalidModelMessage(
  command: RoutingCommandLabel,
  executor: TaskExecutorType,
  model: string,
): string {
  const availableModels = getExecutorModelOptions(executor);
  if (command === '/new') {
    return `Invalid model "${model}" for /new executor "${executor}". Available models: ${availableModels}`;
  }
  return `Invalid model "${model}" for executor "${executor}". Available models: ${availableModels}`;
}
```

Update `packages/shared/src/index.ts` to export:

```ts
export {
  type RoutingCommandLabel,
  formatInvalidExecutorMessage,
  formatInvalidModelMessage,
} from './routing-errors';
```

- [ ] **Step 4: Re-run the targeted shared tests**

Run:

```bash
cd packages/shared && npx vitest run src/__tests__/routing-errors.test.ts src/__tests__/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/routing-errors.ts packages/shared/src/index.ts packages/shared/src/__tests__/routing-errors.test.ts
git commit -m "feat(shared): add routing error message helpers"
```

---

### Task 2: Defer semantic routing validation only for Lark tasks at `/tasks`

**Files:**
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`

- [ ] **Step 1: Add the failing API tests**

In `packages/api/src/__tests__/routes/tasks.test.ts`, add focused cases:

```ts
  it('returns 201 for lark task with invalid model so enrichment can reject it later', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({
        task_type: 'localagent',
        payload: 'test',
        executor: 'cursor',
        executor_model: 'xyz',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });

    expect(res.status).toBe(201);
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith(expect.objectContaining({
      executor: 'cursor',
      executor_model: 'xyz',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    }));
  });

  it('returns 201 for explicit /new-style lark task with invalid executor so enrichment can reject it later', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({
        task_type: 'new_instance',
        payload: '',
        executor: 'foo',
        executor_model: 'bar',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });

    expect(res.status).toBe(201);
  });

  it('returns 400 for non-lark task with invalid executor', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'foo',
        executor_model: 'bar',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid pair/);
  });

  it('returns 400 for non-lark task with invalid model', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'cursor',
        executor_model: 'xyz',
      });

    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run the API task-route test and verify it fails**

Run:

```bash
cd packages/api && npx vitest run src/__tests__/routes/tasks.test.ts
```

Expected: FAIL because `tasks.ts` still rejects both invalid Lark cases with `400`.

- [ ] **Step 3: Implement Lark-only validation deferral**

Modify `packages/api/src/routes/tasks.ts` by introducing an explicit branch after `task_source` validation:

```ts
const shouldDeferRoutingValidation = task_source?.source === 'lark';

if (
  executor !== undefined &&
  !shouldDeferRoutingValidation &&
  (!isTaskExecutorType(executor) || !isValidExecutorModel(executor, executor_model))
) {
  res.status(400).json({ error: 'executor and executor_model must be a valid pair' });
  return;
}
```

Keep all of these checks intact:

- pair presence (`executor` with `executor_model`)
- non-control tasks still require the pair
- non-control tasks still require non-empty payload
- invalid `task_source` still returns `400`

Do **not** add new API copy for Lark invalid routing. The feature depends on enrichment producing the message later.

- [ ] **Step 4: Re-run the API task-route test**

Run:

```bash
cd packages/api && npx vitest run src/__tests__/routes/tasks.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/tasks.ts packages/api/src/__tests__/routes/tasks.test.ts
git commit -m "feat(api): defer lark routing validation to enrichment"
```

---

### Task 3: Make enrichment return exact `/task` and `/new` routing errors

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Add the failing enrichment-service tests**

In `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`, add exact rejection assertions. Use `as any` only in the invalid-executor tests because the runtime queue can now hold Lark-deferred invalid strings even though the TypeScript type is narrower.

Import the shared helpers into the test file once Task 1 is complete so the enrichment assertions verify that service output matches the centralized formatter, rather than duplicating option-list literals:

```ts
import {
  formatInvalidExecutorMessage,
  formatInvalidModelMessage,
} from '@local-agent/shared';
```

Add cases like:

```ts
    it('returns exact /task invalid executor message', () => {
      const service = EnrichmentService.fromObject({ rules: { localagent: {} } });
      const result = service.enrich(
        createTask({
          task_type: 'localagent',
          executor: 'foo' as any,
          executor_model: 'bar',
        }),
        TEST_SESSION_ID,
      );

      expect(result).toEqual({
        type: 'rejected',
        reason: formatInvalidExecutorMessage('/task', 'foo'),
      });
    });

    it('returns exact /task invalid model message', () => {
      const service = EnrichmentService.fromObject({ rules: { localagent: {} } });
      const result = service.enrich(
        createTask({
          task_type: 'localagent',
          executor: 'cursor',
          executor_model: 'xyz',
        }),
        TEST_SESSION_ID,
      );

      expect(result).toEqual({
        type: 'rejected',
        reason: formatInvalidModelMessage('/task', 'cursor', 'xyz'),
      });
    });

    it('returns exact /new invalid executor message', () => {
      const service = EnrichmentService.fromObject({ rules: { new_instance: {} } });
      const result = service.enrich(
        createTask({
          task_type: 'new_instance',
          payload: '',
          executor: 'foo' as any,
          executor_model: 'bar',
        }),
        TEST_SESSION_ID,
      );

      expect(result).toEqual({
        type: 'rejected',
        reason: formatInvalidExecutorMessage('/new', 'foo'),
      });
    });

    it('returns exact /new invalid model message', () => {
      const service = EnrichmentService.fromObject({ rules: { new_instance: {} } });
      const result = service.enrich(
        createTask({
          task_type: 'new_instance',
          payload: '',
          executor: 'cursor',
          executor_model: 'xyz',
        }),
        TEST_SESSION_ID,
      );

      expect(result).toEqual({
        type: 'rejected',
        reason: formatInvalidModelMessage('/new', 'cursor', 'xyz'),
      });
    });

    it('keeps unknown task type precedence over routing-help messages', () => {
      const service = EnrichmentService.fromObject({ rules: { code_review: {} } });
      const result = service.enrich(
        createTask({
          task_type: 'missing',
          executor: 'cursor',
          executor_model: 'xyz',
        }),
        TEST_SESSION_ID,
      );

      expect(result).toEqual({
        type: 'rejected',
        reason: expect.stringContaining('Unknown task type "missing"'),
      });
    });
```

Also add a safety regression test proving invalid executor does not throw:

```ts
    it('does not throw when non-control task carries unknown executor string', () => {
      const service = EnrichmentService.fromObject({ rules: { localagent: {} } });

      expect(() =>
        service.enrich(
          createTask({
            task_type: 'localagent',
            executor: 'not-real' as any,
            executor_model: 'xyz',
          }),
          TEST_SESSION_ID,
        ),
      ).not.toThrow();
    });
```

Important: before implementation, the invalid-executor cases may fail with a thrown `TypeError`, not merely with the wrong `reason`, because the current non-control path calls `isValidExecutorModel(...)` before narrowing the executor. That is the expected red state for this task.

- [ ] **Step 2: Add one poller propagation test**

In `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`, add or update one test so mocked enrichment returns the new invalid-model string and the poller publishes that exact string to `/results`:

```ts
  it('publishes invalid-model rejection text verbatim for lark tasks', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      task_type: 'localagent',
      executor: 'cursor',
      executor_model: 'xyz',
    });

    mockEnrich.mockReturnValue({
      type: 'rejected',
      reason: 'Invalid model "xyz" for executor "cursor". Available models: auto, composer-2-fast',
    });

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      })
      .mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve({ result_id: 'res-1' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ acknowledged: true }),
      });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'localagent',
        status: 'failure',
        exit_code: null,
        stdout: 'Invalid model "xyz" for executor "cursor". Available models: auto, composer-2-fast',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });
```

Base this on the existing “publishes failed result and acks task when enrichment rejects” test shape so failures are clearly about propagation, not mock wiring.

- [ ] **Step 3: Run the enrichment tests and verify they fail**

Run:

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts src/__tests__/enrichment-poller.test.ts
```

Expected: FAIL because `enrichment-service.ts` still returns generic routing copy and still relies on the old `isValidExecutorModel(task.executor, task.executor_model)` shortcut.

- [ ] **Step 4: Implement safe enrichment-side routing validation**

Modify `packages/daemon/task-enrichment/src/enrichment-service.ts` to import:

```ts
import {
  formatInvalidExecutorMessage,
  formatInvalidModelMessage,
} from '@local-agent/shared';
```

Then update the routing validation flow so non-control tasks and explicit `/new` both use:

1. `isTaskExecutorType(task.executor)` first
2. `isValidExecutorModel(task.executor, task.executor_model)` second

One minimal implementation shape:

```ts
function getRoutingRejection(
  command: '/task' | '/new',
  executor: unknown,
  executorModel: unknown,
): string | null {
  if (!isTaskExecutorType(executor)) {
    return formatInvalidExecutorMessage(command, String(executor));
  }
  if (!isValidExecutorModel(executor, executorModel)) {
    return formatInvalidModelMessage(command, executor, String(executorModel));
  }
  return null;
}
```

Use that helper:

- for non-control tasks with `command = '/task'`
- for `new_instance` when both routing fields are present with `command = '/new'`

Keep these existing behaviors unchanged:

- missing routing for non-control tasks still returns the explicit-routing rejection
- bare `/new` without routing still falls back to `claude/sonnet`
- unknown task type still returns before any routing help
- cleanup and gc behavior remain unchanged

- [ ] **Step 5: Re-run the enrichment tests**

Run:

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts src/__tests__/enrichment-poller.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): return exact routing error messages"
```

---

### Task 4: Verification sweep

**Files:** None unless a direct fallout fix is required

- [ ] **Step 1: Run package tests for changed areas**

Run from repo root:

Build in dependency order so downstream packages pick up the shared export change cleanly: `shared` first, then `api`, then `task-enrichment`.

```bash
cd packages/shared && npm test
```

```bash
cd packages/api && npm test
```

```bash
cd packages/daemon/task-enrichment && npm test
```

Expected: PASS in all three packages.

- [ ] **Step 2: Build the changed packages**

Run:

```bash
cd packages/shared && npm run build
```

```bash
cd packages/api && npm run build
```

```bash
cd packages/daemon/task-enrichment && npm run build
```

Expected: PASS.

- [ ] **Step 3: Fix only direct fallout**

If a failure appears outside the planned files, fix it only when it is a direct result of:

- the new shared helper exports
- the Lark-only API validation deferral
- the enrichment routing-message branch

Do not perform opportunistic cleanup.

- [ ] **Step 4: Commit any direct fallout fix**

Only if Step 3 required edits:

```bash
git add <direct-fallout-files>
git commit -m "fix: resolve routing error message fallout"
```

Skip this commit if there is no fallout.

---

## Notes for the implementer

- The critical correctness guard is: **never call `isValidExecutorModel()` before confirming `isTaskExecutorType()`** on the deferred Lark path.
- Keep the API deferral condition narrow: only `task_source?.source === 'lark'`.
- Do not move the user-facing copy into the API or listener; the point of the feature is enrichment-owned rejection.
- Prefer exact-string assertions for the new shared helper tests so the user-visible copy cannot drift accidentally.
- In `enrichment-poller.test.ts`, one focused propagation test is enough; avoid duplicating every exact string there.
- If you test manually after Task 2 but before Task 3, remember that invalid Lark routing can now reach the current enrichment logic and fail noisily; finish Task 3 before judging end-to-end behavior.
