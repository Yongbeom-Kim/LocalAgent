# Explicit `/task` Routing Contract Implementation Plan

**Goal:** Replace implicit task routing with an explicit normal-task contract so `/task <type> <executor> <model> <payload>` becomes the standard path, while only control commands may omit executor/model and rely on enrichment to resolve them.

**Architecture:** Normal tasks will carry explicit routing at submission time from Lark and CLI through the `/tasks` API, and enrichment will stop selecting executors from YAML. Instead, enrichment will validate task-type existence, apply prompt/setup-hook metadata, and only resolve executor/model for control commands such as `/new`, `/gc`, and `/end`.

**Tech Stack:** TypeScript, Vitest, Express, Commander.js, RabbitMQ, js-yaml

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Add explicit task routing fields and a shared control-task helper |
| `packages/shared/src/index.ts` | Modify | Re-export new shared routing helpers |
| `packages/shared/src/__tests__/types.test.ts` | Modify | Validate control-task helper behavior and task routing shapes |
| `packages/api/src/routes/tasks.ts` | Modify | Enforce explicit routing for non-control tasks at `POST /tasks` |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Cover required routing, control-task exceptions, and payload rules |
| `packages/cli/src/commands/submit.ts` | Modify | Require explicit `--type`, `--executor`, and `--model` for normal submission |
| `packages/cli/src/__tests__/submit.test.ts` | Modify | Verify new CLI option requirements and request body |
| `packages/daemon/lark-listener/src/message-handler.ts` | Modify | Make Lark submission command-only and parse the new `/task` contract |
| `packages/daemon/lark-listener/src/adapters/task-submitter.ts` | Modify | Submit optional executor/model only when provided |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Modify | Cover explicit `/task`, invalid plain text, invalid non-text, and structured `/new` submission |
| `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts` | Modify | Verify serialized request body for explicit routing and control-command omissions |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Build job executors from submitted task routing and keep YAML prompt/hook-only |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Modify | Resolve control-command routing and reject threaded non-control Lark tasks |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Cover prompt/hook-only rule handling and explicit task routing |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Modify | Cover threaded `/task` rejection and control-command routing resolution |
| `packages/daemon/task-enrichment/config/enrichment.yaml` | Modify | Remove executor arrays and keep only task-type metadata |
| `packages/daemon/task-enrichment/config/local-agent.yaml` | Modify | Remove executor arrays while preserving hooks/prompts for custom task types |
| `packages/daemon/task-enrichment/config/builtin.yaml` | Modify | Remove executor arrays; keep an empty `cleanup` rule key for task-type existence (executor pair set in enrichment-service per design §9.9) |
| `docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md` | Modify | Add a short note pointing to the new explicit `/task` contract |
| `docs/development/plans/2026-04-02-new-instance-executor-model-inheritance.md` | Modify | Add a short note pointing to the new explicit `/task` contract |
| `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Verify | No structural change expected; remains source of thread metadata (per design §9.11) |
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Verify | Visible executor/model markers unchanged (per design §9.12); run tests if marker output is touched indirectly |

## Task 1: Shared Routing Contract

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write failing shared tests for the control-task helper and task routing shapes**

```ts
import {
  isControlTaskType,
  type TaskSubmission,
} from '../types';

describe('isControlTaskType', () => {
  it('returns true for control task types', () => {
    expect(isControlTaskType('new_instance')).toBe(true);
    expect(isControlTaskType('gc')).toBe(true);
    expect(isControlTaskType('cleanup')).toBe(true);
  });

  it('returns false for normal task types', () => {
    expect(isControlTaskType('code_review')).toBe(false);
    expect(isControlTaskType('generic')).toBe(false);
  });
});

describe('TaskSubmission routing fields', () => {
  it('allows explicit routing fields on TaskSubmission', () => {
    const task: TaskSubmission = {
      task_type: 'code_review',
      payload: 'review this diff',
      executor: 'claude',
      executor_model: 'sonnet',
    };
    expect(task.executor_model).toBe('sonnet');
  });

  it('allows control-task submissions without executor fields', () => {
    const task: TaskSubmission = {
      task_type: 'cleanup',
      payload: '',
    };
    expect(task.executor).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the shared tests and confirm the new cases fail**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`

Expected: FAIL because `isControlTaskType` and the new task routing fields are not defined/exported yet.

- [ ] **Step 3: Implement the shared task routing contract**

Add a small shared helper instead of repeating control-task literals in multiple packages:

```ts
export const CONTROL_TASK_TYPES = ['new_instance', 'gc', 'cleanup'] as const;
export type ControlTaskType = (typeof CONTROL_TASK_TYPES)[number];

export function isControlTaskType(value: unknown): value is ControlTaskType {
  return typeof value === 'string' && CONTROL_TASK_TYPES.includes(value as ControlTaskType);
}

export interface TaskSubmission {
  task_type: string;
  payload: string;
  executor?: TaskExecutorType;
  executor_model?: string;
  task_source?: TaskSource;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  executor?: TaskExecutorType;
  executor_model?: string;
  submitted_at: string;
  task_source?: TaskSource;
}
```

- [ ] **Step 4: Re-export the new helper from `packages/shared/src/index.ts`**

```ts
export {
  CONTROL_TASK_TYPES,
  type ControlTaskType,
  isControlTaskType,
} from './types';
```

- [ ] **Step 5: Run the shared tests again**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the shared contract change**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): add explicit task routing fields and control-task helper"
```

## Task 2: `/tasks` API Validation

**Files:**
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`

- [ ] **Step 1: Add failing route tests for explicit routing and control-task exceptions**

Add cases to `packages/api/src/__tests__/routes/tasks.test.ts` for:

```ts
it('returns 201 for non-control task with explicit executor/model', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({
      task_type: 'code_review',
      payload: 'review this diff',
      executor: 'claude',
      executor_model: 'sonnet',
    });
  expect(res.status).toBe(201);
});

it('returns 400 when non-control task omits executor/model', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({ task_type: 'code_review', payload: 'review this diff' });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/executor/);
});

it('returns 400 when non-control task payload is empty', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({
      task_type: 'code_review',
      payload: '   ',
      executor: 'claude',
      executor_model: 'sonnet',
    });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/payload/);
});

it('returns 201 when control task omits executor/model', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({ task_type: 'new_instance', payload: '' });
  expect(res.status).toBe(201);
});

it('returns 201 when control task includes a valid explicit executor/model pair', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({
      task_type: 'new_instance',
      payload: '',
      executor: 'claude',
      executor_model: 'sonnet',
    });
  expect(res.status).toBe(201);
});

it('returns 400 when only one routing field is present', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({
      task_type: 'code_review',
      payload: 'review this diff',
      executor: 'claude',
    });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run the route test file and confirm it fails**

Run: `cd packages/api && npx vitest run src/__tests__/routes/tasks.test.ts`

Expected: FAIL because the route still accepts tasks without explicit routing and does not distinguish control tasks.

- [ ] **Step 3: Implement `/tasks` route validation with the shared helper**

Use `isControlTaskType()` plus existing executor validation helpers:

```ts
const isControl = isControlTaskType(task_type);

if ((executor === undefined) !== (executor_model === undefined)) {
  res.status(400).json({ error: 'executor and executor_model must be provided together' });
  return;
}

if (executor !== undefined && (!isTaskExecutorType(executor) || !isValidExecutorModel(executor, executor_model))) {
  res.status(400).json({ error: 'executor and executor_model must be a valid pair' });
  return;
}

if (!isControl && executor === undefined) {
  res.status(400).json({ error: 'executor and executor_model are required for non-control tasks' });
  return;
}

if (!isControl && payload.trim() === '') {
  res.status(400).json({ error: 'payload must be non-empty for non-control tasks' });
  return;
}
```

- [ ] **Step 4: Include the routing fields in the stored `Task` when present**

```ts
const task: Task = {
  task_id: uuidv4(),
  task_type,
  payload,
  submitted_at: new Date().toISOString(),
  ...(executor !== undefined ? { executor } : {}),
  ...(executor_model !== undefined ? { executor_model } : {}),
  ...(task_source ? { task_source } : {}),
};
```

- [ ] **Step 5: Re-run the route tests**

Run: `cd packages/api && npx vitest run src/__tests__/routes/tasks.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the API validation change**

```bash
git add packages/api/src/routes/tasks.ts packages/api/src/__tests__/routes/tasks.test.ts
git commit -m "feat(api): require explicit routing for normal task submissions"
```

## Task 3: CLI Explicit Submission

**Files:**
- Modify: `packages/cli/src/commands/submit.ts`
- Modify: `packages/cli/src/__tests__/submit.test.ts`

- [ ] **Step 1: Add failing CLI tests for required routing flags**

Update `packages/cli/src/__tests__/submit.test.ts` to cover:

```ts
it('sends executor and model in the request body', async () => {
  await submitModule.submitTask({
    payload: 'review this diff',
    type: 'code_review',
    executor: 'claude',
    model: 'sonnet',
    apiUrl: 'http://localhost:3000',
  });

  expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task_type: 'code_review',
      payload: 'review this diff',
      executor: 'claude',
      executor_model: 'sonnet',
    }),
  });
});

it('requires --type, --executor, and --model in the command wiring', async () => {
  const program = new Command();
  submitModule.registerSubmitCommand(program, vi.fn());

  await expect(
    program.parseAsync(['submit', '--payload', 'test'], { from: 'user' }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run the CLI tests and confirm the new cases fail**

Run: `cd packages/cli && npx vitest run src/__tests__/submit.test.ts`

Expected: FAIL because `SubmitOptions` and command registration do not yet require executor/model.

- [ ] **Step 3: Update the CLI contract to match the new normal-task API**

Change the option shape to:

```ts
export interface SubmitOptions {
  payload: string;
  type: string;
  executor: TaskExecutorType;
  model: string;
  apiUrl: string;
}
```

Update command registration:

```ts
.requiredOption('-t, --type <string>', 'Task type')
.requiredOption('-e, --executor <string>', 'Executor')
.requiredOption('-m, --model <string>', 'Executor model')
```

Update the request body:

```ts
const body: TaskSubmission = {
  task_type: options.type,
  payload: options.payload,
  executor: options.executor,
  executor_model: options.model,
};
```

- [ ] **Step 4: Re-run the CLI tests**

Run: `cd packages/cli && npx vitest run src/__tests__/submit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the CLI change**

```bash
git add packages/cli/src/commands/submit.ts packages/cli/src/__tests__/submit.test.ts
git commit -m "feat(cli): require explicit task routing flags"
```

## Task 4: Lark Listener Command-Only Behavior

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`

- [ ] **Step 1: Rewrite listener tests around the new command contract**

Add or update tests to cover:

```ts
it('submits /task <type> <executor> <model> <payload> with explicit routing', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({
      text: '/task code_review cursor gpt-5.4-medium-fast review this diff',
    }),
  }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'code_review',
    'review this diff',
    { source: 'lark', message_id: 'om_msg1' },
    'cursor',
    'gpt-5.4-medium-fast',
  );
});

it('rejects plain text messages with the usage hint', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: 'fix the tests' }),
  }));

  expect(submitter.submit).not.toHaveBeenCalled();
  expect(replier.reply).toHaveBeenCalledWith(
    'om_msg1',
    'Usage: /task <type> <executor> <model> <payload> or /end (in a thread)',
  );
});

it('rejects non-text messages with the usage hint', async () => {
  await handler.handle(makeEvent({
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_v3_abc' }),
  }));

  expect(submitter.submit).not.toHaveBeenCalled();
});

it('does not treat /taskforce as /task', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: '/taskforce code_review claude sonnet x' }),
  }));

  expect(submitter.submit).not.toHaveBeenCalled();
  expect(replier.reply).toHaveBeenCalledWith(
    'om_msg1',
    'Usage: /task <type> <executor> <model> <payload> or /end (in a thread)',
  );
});

it('submits explicit /new using structured executor fields', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: '/new claude sonnet' }),
  }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'new_instance',
    '',
    { source: 'lark', message_id: 'om_msg1' },
    'claude',
    'sonnet',
  );
});
```

- [ ] **Step 2: Run the listener tests and confirm they fail**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts src/__tests__/task-submitter.test.ts`

Expected: FAIL because the listener still accepts plain messages, still converts non-text messages to generic payloads, and still uses JSON-in-payload for explicit `/new`.

- [ ] **Step 3: Update `TaskSubmitter.submit()` to accept optional routing fields**

Use a signature like:

```ts
async submit(
  taskType: string,
  payload: string,
  taskSource?: TaskSource,
  executor?: TaskExecutorType,
  executorModel?: string,
): Promise<string | null> {
  const body: TaskSubmission = {
    task_type: taskType,
    payload,
    ...(executor !== undefined ? { executor } : {}),
    ...(executorModel !== undefined ? { executor_model: executorModel } : {}),
    ...(taskSource ? { task_source: taskSource } : {}),
  };
}
```

- [ ] **Step 4: Replace generic fallback behavior in `MessageHandler`**

Implement these rules:

```ts
if (message_type !== 'text') {
  await this.replier.reply(message_id, USAGE_HINT);
  return;
}

// parse /task exact form
// parse /new and /new <executor> <model>
// parse /gc and /end
// otherwise reply with USAGE_HINT and return
```

Key parser behavior:

- `/task` needs at least 4 tokens after the command
- payload must start on the same line as `<model>`
- plain text never falls through to `generic`
- explicit `/new` passes executor/model as structured fields, not JSON payload

- [ ] **Step 5: Re-run the listener tests**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts src/__tests__/task-submitter.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the Lark listener rewrite**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/adapters/task-submitter.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts
git commit -m "feat(lark): require explicit task commands and structured routing"
```

## Task 5: Enrichment Service Becomes Prompt/Hook-Only

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`
- Modify: `packages/daemon/task-enrichment/config/enrichment.yaml`
- Modify: `packages/daemon/task-enrichment/config/local-agent.yaml`
- Modify: `packages/daemon/task-enrichment/config/builtin.yaml`

- [ ] **Step 1: Replace enrichment-service tests that still assume YAML-owned executors**

Add failing cases such as:

```ts
it('builds job.executors from explicit task routing', () => {
  const service = EnrichmentService.fromObject({
    rules: {
      code_review: {
        system_prompt: 'Review carefully.',
      },
    },
  });

  const result = service.enrich(
    createTask({
      task_type: 'code_review',
      executor: 'claude',
      executor_model: 'sonnet',
    }),
    TEST_SESSION_ID,
  );

  expect(result.type).toBe('enriched');
  expect((result as { type: 'enriched'; job: JobSubmission }).job.executors).toEqual([
    { executor: 'claude', executor_model: 'sonnet' },
  ]);
});

it('rejects unknown task_type even when executor/model are valid', () => {
  const service = EnrichmentService.fromObject({ rules: {} });
  const result = service.enrich(
    createTask({
      task_type: 'missing',
      executor: 'claude',
      executor_model: 'sonnet',
    }),
    TEST_SESSION_ID,
  );
  expect(result.type).toBe('rejected');
});

it('includes setup_hook metadata without requiring executors in YAML', () => {
  const service = EnrichmentService.fromObject({
    rules: {
      coding: {
        setup_hook: 'npm ci',
        setup_hook_timeout_ms: 120_000,
      },
    },
  });
  // ...assert enriched job carries the hook values...
});

it('sets builtin executor for cleanup when task omits executor/model', () => {
  const service = EnrichmentService.fromObject({
    rules: { cleanup: {} },
  });
  const result = service.enrich(
    createTask({ task_type: 'cleanup', payload: '' }),
    TEST_SESSION_ID,
  );
  expect(result.type).toBe('enriched');
  expect((result as { type: 'enriched'; job: JobSubmission }).job.executors).toEqual([
    { executor: 'builtin', executor_model: 'none' },
  ]);
});
```

- [ ] **Step 2: Run the enrichment-service tests and confirm they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`

Expected: FAIL because `EnrichmentService` still expects `executors` arrays in YAML rules.

- [ ] **Step 3: Change `EnrichmentRule` so YAML only owns task metadata**

Refactor the rule shape:

```ts
interface EnrichmentRule {
  system_prompt?: string;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}
```

Then build executors from the incoming task for **non-control** task types only. Control-task types (`new_instance`, `gc`, `cleanup`) may omit `executor` / `executor_model` on the `Task` at the API boundary (design §9.3, §9.9). **Do not** reject those cases with “requires explicit executor routing” — that would break `cleanup` and `new_instance` paths that still call `enrich()` without task-level routing fields.

Use `isControlTaskType` from shared types:

- **Non-control** tasks: require both `task.executor` and `task.executor_model`, validate with `isValidExecutorModel`, then set `job.executors` to the single pair from the task (design §9.8).
- **`cleanup`:** API submissions may omit executor/model; set `job.executors` to `[{ executor: 'builtin', executor_model: 'none' }]` in the service (replacing YAML-selected executors), still applying any prompt/hook fields from the rule (design §9.9).
- **`new_instance`:** The poller calls `enrich()` with a synthetic prompt and then **overwrites** `job.executors` using structured task fields and thread inheritance (Task 6). Do **not** reject `new_instance` solely for missing `task.executor`/`task.executor_model` at the start of `enrich()`; after YAML drops executor arrays, keep a valid `job.executors` value for the enriched object until the poller assigns the authoritative pair (same pattern as today’s overwrite).
- **`gc`:** Handled entirely in the poller without calling `enrich()` — if it ever appears here, treat as a configuration error.

```ts
if (!isControlTaskType(task.task_type)) {
  if (!task.executor || !task.executor_model) {
    return { type: 'rejected', reason: `Task type "${task.task_type}" requires explicit executor routing.` };
  }
  if (!isValidExecutorModel(task.executor, task.executor_model)) {
    return { type: 'rejected', reason: `Task type "${task.task_type}" has invalid executor routing.` };
  }
  job.executors = [{ executor: task.executor, executor_model: task.executor_model }];
} else if (task.task_type === 'cleanup') {
  job.executors = [{ executor: 'builtin', executor_model: 'none' }];
} else if (task.task_type === 'new_instance') {
  // Provisional row so `JobSubmission` stays valid; poller replaces with `resolveNewInstancePair` (Task 6)
  job.executors =
    task.executor && task.executor_model
      ? [{ executor: task.executor, executor_model: task.executor_model }]
      : [{ executor: 'claude', executor_model: 'sonnet' }];
}
```

Import `isControlTaskType` from `@local-agent/shared` (depends on Task 1).

- [ ] **Step 4: Migrate the YAML config files**

Rewrite the active files so they keep rule keys but drop `executors` arrays:

```yaml
rules:
  generic: {}
```

```yaml
rules:
  localagent-plan:
    setup_hook: |
      git clone git@github.com:Yongbeom-Kim/LocalAgent.git
```

`builtin.yaml` can keep the `cleanup` rule key as an empty rule so the type still exists, while poller logic provides the builtin executor pair:

```yaml
rules:
  cleanup: {}
```

- [ ] **Step 5: Re-run the enrichment-service tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the enrichment-service refactor**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts packages/daemon/task-enrichment/config/enrichment.yaml packages/daemon/task-enrichment/config/local-agent.yaml packages/daemon/task-enrichment/config/builtin.yaml
git commit -m "refactor(enrichment): derive executors from submitted task routing"
```

## Task 6: Enrichment Poller Control Routing and Thread Rejection

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Add failing poller tests for threaded `/task` rejection and control routing**

Add cases for:

```ts
it('rejects any threaded non-control lark task before creating a job', async () => {
  const task = createTask({
    task_type: 'code_review',
    payload: 'review this diff',
    executor: 'claude',
    executor_model: 'sonnet',
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });

  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'assistant: earlier response',
    inheritedTaskType: 'code_review',
    inheritedSessionId: 'thread-session-id',
    inheritedExecutor: 'claude',
    inheritedExecutorModel: 'sonnet',
  });

  // assert POST /results rejection and no POST /jobs
});

it('uses explicit task.executor/task.executor_model for /new override', async () => {
  const task = createTask({
    task_type: 'new_instance',
    payload: '',
    executor: 'cursor',
    executor_model: 'auto',
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });
  // assert posted job.executors === [{ executor: 'cursor', executor_model: 'auto' }]
});

it('uses inherited executor/model for bare /new when available', async () => {
  const task = createTask({
    task_type: 'new_instance',
    payload: '',
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });
  // assert inherited pair is chosen
});

it('falls back to claude/sonnet for bare /new when no pair is inherited', async () => {
  // assert fallback pair is chosen without synthetic placeholder task fields
});
```

- [ ] **Step 2: Run the poller tests and confirm they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`

Expected: FAIL because the poller still:
- allows non-control thread tasks when task_type matches
- parses explicit `/new` executor/model from JSON payload instead of structured task fields
- still relies on YAML-selected executors for normal tasks

- [ ] **Step 3: Implement authoritative threaded `/task` rejection in the poller**

After `fetchThreadContext` returns, **before** any thread `task_type` inheritance or mutation (including the legacy `generic` branch), reject any non-control Lark task that is in a thread:

```ts
if (task.task_source?.source === 'lark' && threadResult && !isControlTaskType(task.task_type)) {
  await this.publishRejection(
    task,
    'Cannot use /task in a thread. Remove the /task prefix or start a new conversation.',
  );
  await this.ackTask(task.task_id);
  return;
}
```

This must run before enrichment creates a job. Remove or narrow obsolete logic that inherited `task_type` for `generic` in threads — plain `generic` submissions are gone (design §6, §9.10), and threaded non-control tasks are rejected above.

- [ ] **Step 4: Refactor control routing resolution away from placeholder payload tricks**

Delete `parseNewInstanceOverride` and the JSON-in-payload path. Read explicit `/new <executor> <model>` from `task.executor` / `task.executor_model` (already validated at `POST /tasks`). Update rejection copy: drop `NEW_INSTANCE_INVALID_OVERRIDE_REASON` text that refers to JSON.

Use structured task fields and explicit resolution helpers:

```ts
function resolveNewInstancePair(task: Task, threadResult: ThreadContextResult) {
  if (task.executor && task.executor_model) {
    return { executor: task.executor, executor_model: task.executor_model };
  }
  if (threadResult.inheritedExecutor && threadResult.inheritedExecutorModel) {
    return {
      executor: threadResult.inheritedExecutor,
      executor_model: threadResult.inheritedExecutorModel,
    };
  }
  return { executor: 'claude', executor_model: 'sonnet' };
}
```

Use fixed pairs for the other controls:

```ts
const GC_EXECUTOR = { executor: 'claude', executor_model: 'sonnet' } as const;
const CLEANUP_EXECUTOR = { executor: 'builtin', executor_model: 'none' } as const;
```

- [ ] **Step 5: Re-run the poller tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the poller behavior change**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): reject threaded task commands and resolve control routing"
```

## Task 7: Docs and Targeted Verification

**Files:**
- Modify: `docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md`
- Modify: `docs/development/plans/2026-04-02-new-instance-executor-model-inheritance.md`

- [ ] **Step 1: Add short superseding notes to the `/new` design and plan docs**

Add a short note near the top of each file:

```md
> The current normal-task routing contract is defined in
> `docs/development/design/2026-04-02-task-explicit-routing-contract-design.md`
> and `docs/development/plans/2026-04-02-task-explicit-routing-contract.md`.
```

- [ ] **Step 2: Run the targeted package test suites in dependency order**

Run:

```bash
cd packages/shared && npx vitest run
cd packages/api && npx vitest run
cd packages/cli && npx vitest run
cd packages/daemon/lark-listener && npx vitest run
cd packages/daemon/task-enrichment && npx vitest run
```

Expected: PASS across all targeted suites.

- [ ] **Step 3: Sanity-check unaffected downstream packages only if the targeted suites expose fallout**

If a targeted suite indicates an integration mismatch, also run:

```bash
cd packages/daemon/task && npx vitest run
cd packages/daemon/lark-result && npx vitest run
```

Expected: PASS, or fix any newly exposed contract mismatch before proceeding. If you change reply markers or thread parsing, manually verify `packages/daemon/lark-result/src/adapters/lark-notifier.ts` and `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` against design §9.11–§9.12 (see File Structure table).

- [ ] **Step 4: Commit docs and any final compatibility fixes**

```bash
git add docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md docs/development/plans/2026-04-02-new-instance-executor-model-inheritance.md
git commit -m "docs: link new instance docs to explicit task routing contract"
```
