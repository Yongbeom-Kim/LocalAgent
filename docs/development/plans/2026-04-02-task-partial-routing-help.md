# Partial `/task` Routing Help Implementation Plan

**Goal:** Let partial `/task` commands flow through the existing task -> enrichment -> result pipeline so Lark users get valid task type, executor, model, and payload guidance instead of an early generic usage reply.

**Architecture:** Keep `/task` progressive-help behavior centered in enrichment rather than duplicating it in `lark-listener`. The listener should submit best-effort partial normal-task shapes, the `/tasks` API should accept partial non-control submissions while keeping control tasks strict, and enrichment should infer the current routing stage from existing fields and return the next relevant help message.

**Tech Stack:** TypeScript, Vitest, Express, js-yaml

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Broaden queue-layer task routing fields so partial submissions can carry raw executor tokens |
| `packages/shared/src/index.ts` | Modify | Re-export new `/task` progressive-help helpers |
| `packages/shared/src/routing-errors.ts` | Modify | Centralize canonical `/task` syntax plus missing-stage and invalid-stage user-facing messages |
| `packages/shared/src/__tests__/routing-errors.test.ts` | Modify | Lock exact copy and raw partial-task typing expectations |
| `packages/api/src/routes/tasks.ts` | Modify | Accept partial non-control tasks, reject only structurally impossible shapes, keep control commands strict |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Prove partial normal tasks are accepted while control-task strictness remains intact |
| `packages/daemon/lark-listener/src/message-handler.ts` | Modify | Submit progressive `/task` shapes instead of replying locally for partial `/task` forms |
| `packages/daemon/lark-listener/src/adapters/task-submitter.ts` | Modify | Post raw optional executor strings and partial routing fields exactly as parsed |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Modify | Cover `/task`, `/task <type>`, `/task <type> <executor>`, `/task <type> <executor> <model>`, and reaction behavior |
| `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts` | Modify | Verify partial `/task` request bodies serialize correctly |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Add ordered stage inference for missing/invalid task type, executor, model, and payload |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Assert exact help-message precedence and successful enrichment for full tasks |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Modify | Confirm staged rejection messages still publish verbatim through `/results` |

## Task 1: Shared Progressive-Help Contract

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/routing-errors.ts`
- Modify: `packages/shared/src/__tests__/routing-errors.test.ts`

- [ ] **Step 1: Write failing shared tests for raw executor tokens and staged `/task` messages**

Add focused cases to `packages/shared/src/__tests__/routing-errors.test.ts`:

```ts
import {
  TASK_COMMAND_USAGE,
  formatMissingTaskTypeMessage,
  formatUnknownTaskTypeMessage,
  formatMissingExecutorMessage,
  formatMissingModelMessage,
  formatMissingPayloadMessage,
  formatInvalidExecutorMessage,
  formatInvalidModelMessage,
  type TaskSubmission,
} from '../index';
import { TASK_EXECUTOR_OPTIONS, getExecutorModelOptions } from '../types';

it('formats missing task type help', () => {
  expect(formatMissingTaskTypeMessage(['generic', 'localagent'])).toBe(
    `Usage: ${TASK_COMMAND_USAGE}\nAvailable task types: generic, localagent`,
  );
});

it('formats unknown task type help', () => {
  expect(formatUnknownTaskTypeMessage('foo', ['generic', 'localagent'])).toBe(
    'Invalid task type "foo". Available task types: generic, localagent',
  );
});

it('formats missing executor help', () => {
  expect(formatMissingExecutorMessage('localagent')).toBe(
    `Missing executor for task type "localagent". Available executors: ${TASK_EXECUTOR_OPTIONS}`,
  );
});

it('formats missing model help', () => {
  expect(formatMissingModelMessage('cursor')).toBe(
    `Missing model for executor "cursor". Available models: ${getExecutorModelOptions('cursor')}`,
  );
});

it('formats missing payload help', () => {
  expect(formatMissingPayloadMessage()).toBe(
    `Usage: ${TASK_COMMAND_USAGE}\nPayload is required.`,
  );
});

it('allows partial normal-task submissions to carry raw executor strings', () => {
  const task: TaskSubmission = {
    task_type: 'localagent',
    payload: '',
    executor: 'foo',
  };
  expect(task.executor).toBe('foo');
});
```

- [ ] **Step 2: Run the shared tests and confirm the new cases fail**

Run: `cd packages/shared && npx vitest run src/__tests__/routing-errors.test.ts`

Expected: FAIL because the new helpers and raw-string task typing do not exist yet.

- [ ] **Step 3: Implement the shared formatting helpers and raw queue-layer routing types**

Update `packages/shared/src/types.ts` so queue-layer task records can hold raw routing tokens:

```ts
export interface TaskSubmission {
  task_type: string;
  payload: string;
  executor?: string;
  executor_model?: string;
  task_source?: TaskSource;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  executor?: string;
  executor_model?: string;
  submitted_at: string;
  task_source?: TaskSource;
}
```

Add shared `/task` helpers in `packages/shared/src/routing-errors.ts`:

```ts
export const TASK_COMMAND_USAGE = '/task <type> <executor> <model> <payload>';

export function formatMissingTaskTypeMessage(validTypes: string[]): string {
  return `Usage: ${TASK_COMMAND_USAGE}\nAvailable task types: ${validTypes.join(', ')}`;
}

export function formatUnknownTaskTypeMessage(taskType: string, validTypes: string[]): string {
  return `Invalid task type "${taskType}". Available task types: ${validTypes.join(', ')}`;
}

export function formatMissingExecutorMessage(taskType: string): string {
  return `Missing executor for task type "${taskType}". Available executors: ${TASK_EXECUTOR_OPTIONS}`;
}

export function formatMissingModelMessage(executor: TaskExecutorType): string {
  return `Missing model for executor "${executor}". Available models: ${getExecutorModelOptions(executor)}`;
}

export function formatMissingPayloadMessage(): string {
  return `Usage: ${TASK_COMMAND_USAGE}\nPayload is required.`;
}
```

Keep the existing invalid executor/model helpers exactly as they are so `/new` copy does not regress.

- [ ] **Step 4: Re-export the new helpers from `packages/shared/src/index.ts`**

Extend the existing `export { ... } from './routing-errors'` block (do not add a second routing-errors export) to include `TASK_COMMAND_USAGE` and the five `formatMissing*` helpers alongside `formatInvalidExecutorMessage` and `formatInvalidModelMessage`.

- [ ] **Step 5: Re-run the shared tests**

Run: `cd packages/shared && npx vitest run src/__tests__/routing-errors.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the shared contract change**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/src/routing-errors.ts packages/shared/src/__tests__/routing-errors.test.ts
git commit -m "feat(shared): add progressive task routing help messages"
```

## Task 2: Relax `/tasks` for Partial Normal Tasks

**Files:**
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`

- [ ] **Step 1: Add failing route tests for partial normal-task acceptance**

Add cases to `packages/api/src/__tests__/routes/tasks.test.ts`:

```ts
it('accepts non-control task with empty task_type for pipeline help', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({ task_type: '', payload: '' });
  expect(res.status).toBe(201);
});

it('accepts non-control task with task_type only', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({ task_type: 'localagent', payload: '' });
  expect(res.status).toBe(201);
});

it('accepts non-control task with executor but no model', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({ task_type: 'localagent', payload: '', executor: 'cursor' });
  expect(res.status).toBe(201);
});

it('accepts non-control task with invalid executor/model pair so enrichment can explain it', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({
      task_type: 'localagent',
      payload: '',
      executor: 'foo',
      executor_model: 'bar',
    });
  expect(res.status).toBe(201);
});

it('rejects executor_model without executor', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({
      task_type: 'localagent',
      payload: '',
      executor_model: 'auto',
    });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/executor_model/);
});

it('keeps explicit /new validation strict', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({
      task_type: 'new_instance',
      payload: '',
      executor: 'foo',
      executor_model: 'bar',
    });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run the route test file and confirm the new cases fail**

Run: `cd packages/api && npx vitest run src/__tests__/routes/tasks.test.ts`

Expected: FAIL because the route still requires non-control tasks to be fully runnable.

- [ ] **Step 3: Implement structural-only validation for non-control tasks**

Refactor `packages/api/src/routes/tasks.ts` so the route:

- still requires `task_type` and `payload` to be strings
- still validates `task_source`
- rejects `executor_model` without `executor`
- keeps control tasks strict
- accepts partial non-control routing shapes without semantic routing checks

Use logic in this shape:

```ts
if (typeof task_type !== 'string') {
  res.status(400).json({ error: 'task_type is required and must be a string' });
  return;
}

if (typeof payload !== 'string') {
  res.status(400).json({ error: 'payload is required and must be a string' });
  return;
}

if (executor_model !== undefined && executor === undefined) {
  res.status(400).json({ error: 'executor_model requires executor' });
  return;
}

const isControl = isControlTaskType(task_type);

if (
  isControl &&
  executor !== undefined &&
  (!isTaskExecutorType(executor) ||
    executor_model === undefined ||
    !isValidExecutorModel(executor, executor_model))
) {
  res.status(400).json({ error: 'executor and executor_model must be a valid pair' });
  return;
}
```

For non-control tasks, do **not** reject:

- empty `task_type`
- missing `executor`
- missing `executor_model`
- invalid executor/model pair
- blank payload

Those now belong to enrichment.

- [ ] **Step 4: Preserve partial routing fields on the stored task**

Build the task row like:

```ts
const task: Task = {
  task_id: uuidv4(),
  task_type,
  payload,
  submitted_at: new Date().toISOString(),
  ...(typeof executor === 'string' ? { executor } : {}),
  ...(typeof executor_model === 'string' ? { executor_model } : {}),
  ...(task_source ? { task_source } : {}),
};
```

- [ ] **Step 5: Re-run the route tests**

Run: `cd packages/api && npx vitest run src/__tests__/routes/tasks.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the API change**

```bash
git add packages/api/src/routes/tasks.ts packages/api/src/__tests__/routes/tasks.test.ts
git commit -m "feat(api): accept partial normal task submissions"
```

## Task 3: Submit Progressive `/task` Shapes from Lark

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts`
- Modify: `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`

- [ ] **Step 1: Add failing listener tests for progressive `/task` submission**

Update `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` with cases like:

**Replace existing tests that contradict the design spec (§9.2):** the file currently expects a local usage reply and **no** submit for bare `/task`, partial first-line `/task` forms, and `/task <type> <executor> <model>` when the payload would start on the next line. Per the spec, those inputs must **submit** a best-effort shape, **react**, and rely on the pipeline for help. Rewrite those tests accordingly (including the multiline case: first line ends after `<model>` → treat as missing payload on the queue object even if later lines exist).

**Keep unchanged** (still required by §12.3): plain-text usage reply, non-text usage reply, `/taskforce` not treated as `/task`, and the existing full-form multiline payload test when the first line already contains type, executor, model, and payload start.

```ts
it('submits bare /task as a partial routing request and still reacts', async () => {
  await handler.handle(makeEvent({ content: JSON.stringify({ text: '/task' }) }));

  expect(submitter.submit).toHaveBeenCalledWith(
    '',
    '',
    { source: 'lark', message_id: 'om_msg1' },
    undefined,
    undefined,
  );
  expect(reactor.react).toHaveBeenCalledWith('om_msg1');
});

it('submits /task localagent with missing executor', async () => {
  await handler.handle(makeEvent({ content: JSON.stringify({ text: '/task localagent' }) }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'localagent',
    '',
    { source: 'lark', message_id: 'om_msg1' },
    undefined,
    undefined,
  );
});

it('submits /task localagent cursor with missing model', async () => {
  await handler.handle(makeEvent({ content: JSON.stringify({ text: '/task localagent cursor' }) }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'localagent',
    '',
    { source: 'lark', message_id: 'om_msg1' },
    'cursor',
    undefined,
  );
});

it('submits /task localagent cursor auto with missing payload', async () => {
  await handler.handle(makeEvent({ content: JSON.stringify({ text: '/task localagent cursor auto' }) }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'localagent',
    '',
    { source: 'lark', message_id: 'om_msg1' },
    'cursor',
    'auto',
  );
});

it('submits /task localagent cursor auto investigate the bug as a full runnable shape', async () => {
  await handler.handle(
    makeEvent({
      content: JSON.stringify({ text: '/task localagent cursor auto investigate the bug' }),
    }),
  );

  expect(submitter.submit).toHaveBeenCalledWith(
    'localagent',
    'investigate the bug',
    { source: 'lark', message_id: 'om_msg1' },
    'cursor',
    'auto',
  );
});
```

Add a `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts` assertion proving raw executor tokens are posted unchanged:

```ts
await submitter.submit('localagent', '', undefined, 'foo', 'bar');

expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
  task_type: 'localagent',
  payload: '',
  executor: 'foo',
  executor_model: 'bar',
});
```

- [ ] **Step 2: Run the listener tests and confirm they fail**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts src/__tests__/task-submitter.test.ts`

Expected: FAIL because partial `/task` forms currently trigger the local usage hint instead of submission.

- [ ] **Step 3: Broaden `TaskSubmitter.submit()` to accept raw optional executor strings**

Update the adapter signature in `packages/daemon/lark-listener/src/adapters/task-submitter.ts` (drop `TaskExecutorType` on `executor` so invalid tokens serialize to the API). Keep the existing retry loop, logging, and return behavior; only widen types and the `TaskSubmission` spread as shown:

```ts
async submit(
  taskType: string,
  payload: string,
  taskSource?: TaskSource,
  executor?: string,
  executorModel?: string,
): Promise<string | null> {
  const body: TaskSubmission = {
    task_type: taskType,
    payload,
    ...(executor !== undefined ? { executor } : {}),
    ...(executorModel !== undefined ? { executor_model: executorModel } : {}),
    ...(taskSource ? { task_source: taskSource } : {}),
  };
  // ... unchanged fetch / retry / return ...
}
```

- [ ] **Step 4: Replace exact-form `/task` parsing with progressive first-line token parsing**

In `packages/daemon/lark-listener/src/message-handler.ts`, widen `ParsedSubmit` so `executor` is `string | undefined` (not `TaskExecutorType`). Keep the existing command routing for `/new`, `/gc`, `/end`, plain text, and non-text, but change `/task` parsing to:

```ts
private parseTaskCommand(text: string): {
  taskType: string;
  taskPayload: string;
  executor?: string;
  executorModel?: string;
} {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.substring(0, firstNl);
  const restAfterFirstLine = firstNl === -1 ? '' : text.substring(firstNl + 1);
  const afterCmd = firstLine === '/task' ? '' : firstLine.slice('/task'.length).trimStart();
  const tokens = afterCmd === '' ? [] : afterCmd.split(/\s+/);

  const taskType = tokens[0] ?? '';
  const executor = tokens[1];
  const executorModel = tokens[2];
  const payloadStart = tokens.length >= 4 ? tokens.slice(3).join(' ') : '';
  const taskPayload =
    payloadStart !== ''
      ? (restAfterFirstLine ? `${payloadStart}\n${restAfterFirstLine}` : payloadStart)
      : '';

  return { taskType, taskPayload, executor, executorModel };
}
```

Keep `/taskforce` and other non-exact prefixes invalid. Do **not** locally reject shorter `/task` forms anymore.

**Multiline rule (design §9.2):** append `restAfterFirstLine` to the payload **only** when there is fourth-or-later token content on the first line (`payloadStart` non-empty). If the first line ends after the model token (`tokens.length <= 3`), `taskPayload` stays empty even when additional lines exist.

- [ ] **Step 5: Re-run the listener tests**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts src/__tests__/task-submitter.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the listener change**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/adapters/task-submitter.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts
git commit -m "feat(lark): submit partial task routing requests"
```

## Task 4: Make Enrichment Return the Next Relevant Help

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Add failing enrichment tests for stage inference and precedence**

In `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`, extend the `@local-agent/shared` import to include `formatMissingTaskTypeMessage`, `formatUnknownTaskTypeMessage`, `formatMissingExecutorMessage`, `formatMissingModelMessage`, and `formatMissingPayloadMessage` (that file already imports `formatInvalidExecutorMessage` and `formatInvalidModelMessage`). Then add cases such as:

```ts
it('returns syntax plus valid task types when task_type is missing', () => {
  const service = EnrichmentService.fromObject({ rules: { generic: {}, localagent: {} } });
  const result = service.enrich(
    createTask({ task_type: '', executor: undefined, executor_model: undefined, payload: '' }),
    TEST_SESSION_ID,
  );

  expect(result).toEqual({
    type: 'rejected',
    reason: formatMissingTaskTypeMessage(['generic', 'localagent']),
  });
});

it('keeps invalid task type precedence over later routing tokens', () => {
  const service = EnrichmentService.fromObject({ rules: { localagent: {} } });
  const result = service.enrich(
    createTask({
      task_type: 'foo',
      executor: 'cursor',
      executor_model: 'auto',
      payload: 'hello',
    }),
    TEST_SESSION_ID,
  );

  expect(result).toEqual({
    type: 'rejected',
    reason: formatUnknownTaskTypeMessage('foo', ['localagent']),
  });
});

it('returns missing executor help for known task type', () => {
  const service = EnrichmentService.fromObject({ rules: { localagent: {} } });
  const result = service.enrich(
    createTask({
      task_type: 'localagent',
      executor: undefined,
      executor_model: undefined,
      payload: '',
    }),
    TEST_SESSION_ID,
  );

  expect(result).toEqual({
    type: 'rejected',
    reason: formatMissingExecutorMessage('localagent'),
  });
});

it('returns missing model help when executor is valid but model missing', () => {
  const service = EnrichmentService.fromObject({ rules: { localagent: {} } });
  const result = service.enrich(
    createTask({
      task_type: 'localagent',
      executor: 'cursor',
      executor_model: undefined,
      payload: '',
    }),
    TEST_SESSION_ID,
  );

  expect(result).toEqual({
    type: 'rejected',
    reason: formatMissingModelMessage('cursor'),
  });
});

it('returns invalid executor help before considering an invalid model token', () => {
  const service = EnrichmentService.fromObject({ rules: { localagent: {} } });
  const result = service.enrich(
    createTask({
      task_type: 'localagent',
      executor: 'foo',
      executor_model: 'bar',
      payload: 'hello',
    }),
    TEST_SESSION_ID,
  );

  expect(result).toEqual({
    type: 'rejected',
    reason: formatInvalidExecutorMessage('/task', 'foo'),
  });
});

it('returns invalid model help when executor is valid but model is not', () => {
  const service = EnrichmentService.fromObject({ rules: { localagent: {} } });
  const result = service.enrich(
    createTask({
      task_type: 'localagent',
      executor: 'cursor',
      executor_model: 'not-a-model',
      payload: 'hello',
    }),
    TEST_SESSION_ID,
  );

  expect(result).toEqual({
    type: 'rejected',
    reason: formatInvalidModelMessage('/task', 'cursor', 'not-a-model'),
  });
});

it('returns payload-required help after valid type/executor/model', () => {
  const service = EnrichmentService.fromObject({ rules: { localagent: {} } });
  const result = service.enrich(
    createTask({
      task_type: 'localagent',
      executor: 'cursor',
      executor_model: 'auto',
      payload: '   ',
    }),
    TEST_SESSION_ID,
  );

  expect(result).toEqual({
    type: 'rejected',
    reason: formatMissingPayloadMessage(),
  });
});
```

- [ ] **Step 2: Run the enrichment-service tests and confirm they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`

Expected: FAIL because enrichment currently assumes incomplete normal tasks were rejected earlier.

- [ ] **Step 3: Implement ordered stage inference for non-control tasks**

Refactor `packages/daemon/task-enrichment/src/enrichment-service.ts` with a clear control vs normal split:

1. **Normalize once:** `const normalizedTaskType = task.task_type.trim()` (use `normalizedTaskType` for rule lookup and downstream messages so spacing-only `task_type` matches “missing type” after trim).

2. **Missing task type:** if `!normalizedTaskType`, return `{ type: 'rejected', reason: formatMissingTaskTypeMessage(this.getValidTypes()) }`.

3. **Control tasks:** if `isControlTaskType(normalizedTaskType)`, do **not** run the progressive missing-stage sequence. Preserve the existing behavior for `cleanup`, `new_instance`, and `gc` (including rule lookup, `/new` routing checks, and the current `gc` rejection if it still reaches this service). Use `normalizedTaskType` when indexing `this.rules` where you previously used `task.task_type`.

4. **Normal (non-control) tasks:** resolve `const rule = this.rules[normalizedTaskType]`. If `!rule`, return `formatUnknownTaskTypeMessage(normalizedTaskType, this.getValidTypes())` (replacing the old ad-hoc unknown-type string). Then run the staged checks in **this** order:

```ts
if (!task.executor || task.executor.trim() === '') {
  return { type: 'rejected', reason: formatMissingExecutorMessage(normalizedTaskType) };
}

if (!isTaskExecutorType(task.executor)) {
  return { type: 'rejected', reason: formatInvalidExecutorMessage('/task', task.executor) };
}

if (!task.executor_model || task.executor_model.trim() === '') {
  return { type: 'rejected', reason: formatMissingModelMessage(task.executor) };
}

if (!isValidExecutorModel(task.executor, task.executor_model)) {
  return {
    type: 'rejected',
    reason: formatInvalidModelMessage('/task', task.executor, task.executor_model),
  };
}

if (task.payload.trim() === '') {
  return { type: 'rejected', reason: formatMissingPayloadMessage() };
}
```

Import `formatMissingTaskTypeMessage`, `formatUnknownTaskTypeMessage`, `formatMissingExecutorMessage`, `formatMissingModelMessage`, and `formatMissingPayloadMessage` from `@local-agent/shared` next to the existing invalid executor/model imports.

Then create the runnable job from the normalized task type:

```ts
job: {
  task_id: task.task_id,
  task_type: normalizedTaskType,
  payload: task.payload,
  executors: [{ executor: task.executor, executor_model: task.executor_model }],
  // ...existing fields...
}
```

Use `normalizedTaskType` for `job.task_type` on the enriched job object.

- [ ] **Step 4: Re-run the enrichment-service tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`

Expected: PASS. Confirm existing tests that expect a successful `type: 'enriched'` outcome for complete normal tasks still pass (design §12.4); adjust fixtures only if the refactor changes normalization or job shape.

- [ ] **Step 5: Commit the enrichment-service change**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "feat(enrichment): return staged help for partial task routing"
```

## Task 5: Lock the Result-Pipeline Regression Coverage

**Files:**
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Add poller coverage for the new staged rejection text**

Add or update focused tests in `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`:

```ts
it('publishes missing-task-type help verbatim for lark tasks', async () => {
  const task = createTask({
    task_source: { source: 'lark', message_id: 'om_msg1' },
    task_type: '',
    payload: '',
  });

  mockEnrich.mockReturnValue({
    type: 'rejected',
    reason: 'Usage: /task <type> <executor> <model> <payload>\nAvailable task types: generic, localagent',
  });

  await poller.pollOnce();

  expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: 'task-123',
      task_id: 'task-123',
      task_type: '',
      status: 'failure',
      exit_code: null,
      stdout: 'Usage: /task <type> <executor> <model> <payload>\nAvailable task types: generic, localagent',
      stderr: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    }),
  });
});

it('publishes payload-required help verbatim for lark tasks', async () => {
  const task = createTask({
    task_source: { source: 'lark', message_id: 'om_msg1' },
    task_type: 'localagent',
    executor: 'cursor',
    executor_model: 'auto',
    payload: '',
  });

  mockEnrich.mockReturnValue({
    type: 'rejected',
    reason: 'Usage: /task <type> <executor> <model> <payload>\nPayload is required.',
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
      stdout: 'Usage: /task <type> <executor> <model> <payload>\nPayload is required.',
      stderr: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    }),
  });
});
```

- [ ] **Step 2: Run the poller test file**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`

Expected: PASS after Task 4. If it fails, fix only the rejection publishing path or stale fixture assumptions; the intended runtime behavior is still "publish the enrichment reason verbatim."

- [ ] **Step 3: Commit the regression coverage**

```bash
git add packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "test(enrichment): cover staged partial task rejection results"
```

## Task 6: Targeted Verification and Final Sweep

**Files:**
- Verify: `packages/shared/src/__tests__/routing-errors.test.ts`
- Verify: `packages/api/src/__tests__/routes/tasks.test.ts`
- Verify: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Verify: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`
- Verify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`
- Verify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Run the targeted suites in dependency order**

Run:

```bash
cd packages/shared && npx vitest run src/__tests__/routing-errors.test.ts
cd packages/api && npx vitest run src/__tests__/routes/tasks.test.ts
cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts src/__tests__/task-submitter.test.ts
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts src/__tests__/enrichment-poller.test.ts
```

Expected: PASS across all targeted suites.

- [ ] **Step 2: Fix only newly exposed contract mismatches**

If any targeted suite exposes a mismatch, make the smallest correction consistent with the design spec:

- queue-layer tasks may carry raw executor strings
- API accepts partial non-control tasks
- listener submits shorter `/task` forms
- enrichment, not the listener or API, chooses the next help message

If failures cascade beyond the target packages, run `@review-and-fix` only after the core changes land and only if targeted fixes are not enough.

- [ ] **Step 3: Re-run the affected suites**

Run only the suites touched by Step 2 until they pass, then re-run the full targeted list from Step 1.

- [ ] **Step 4: Commit the final verification fixes**

```bash
git add packages/shared packages/api packages/daemon/lark-listener packages/daemon/task-enrichment
git commit -m "test: verify partial task routing help end-to-end"
```
