# Task Source Thread Reply Implementation Plan

**Goal:** Thread originating source context (Lark `message_id`) through the entire pipeline so the lark-result daemon replies in-thread to the original message, falling back to DM when no source is present.

**Architecture:** Add an optional `task_source?: TaskSource` field (discriminated union) to every pipeline type: `TaskSubmission → Task → JobSubmission → Job → TaskResultSubmission → TaskResult`. Each layer passes it through. The lark-result daemon checks `task_source.source === 'lark'` and uses the Lark reply-in-thread API; otherwise falls back to the existing DM send.

**Tech Stack:** TypeScript, Vitest, Express, Lark Open API (REST)

**Design Doc:** `docs/development/design/2026-03-31-task-source-thread-reply-design.md`

---

### Task 1: Add TaskSource types and validator to shared package

**Files:**
- Modify: `packages/shared/src/types.ts:101-118` (add types before RESULT_STATUSES)

- [ ] **Step 1: Write the failing test**

Create test file `packages/shared/src/__tests__/task-source.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isValidTaskSource } from '../types';

describe('isValidTaskSource', () => {
  it('returns true for valid lark source', () => {
    expect(isValidTaskSource({ source: 'lark', message_id: 'om_abc123' })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isValidTaskSource(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isValidTaskSource(undefined)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isValidTaskSource('lark')).toBe(false);
  });

  it('returns false for unknown source', () => {
    expect(isValidTaskSource({ source: 'unknown', id: '123' })).toBe(false);
  });

  it('returns false for lark source with missing message_id', () => {
    expect(isValidTaskSource({ source: 'lark' })).toBe(false);
  });

  it('returns false for lark source with empty message_id', () => {
    expect(isValidTaskSource({ source: 'lark', message_id: '' })).toBe(false);
  });

  it('returns false for lark source with non-string message_id', () => {
    expect(isValidTaskSource({ source: 'lark', message_id: 123 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/__tests__/task-source.test.ts`
Expected: FAIL — `isValidTaskSource` is not exported from `../types`

- [ ] **Step 3: Write minimal implementation**

Add to `packages/shared/src/types.ts` (before the `RESULT_STATUSES` line):

```typescript
// --- Task Source ---

export interface LarkTaskSource {
  source: 'lark';
  message_id: string;
}

export type TaskSource = LarkTaskSource;

export function isValidTaskSource(value: unknown): value is TaskSource {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.source === 'lark') {
    return typeof obj.message_id === 'string' && obj.message_id.length > 0;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/__tests__/task-source.test.ts`
Expected: PASS — all 8 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/__tests__/task-source.test.ts
git commit -m "feat(shared): add TaskSource discriminated union and isValidTaskSource validator"
```

---

### Task 2: Add task_source field to all pipeline interfaces

**Files:**
- Modify: `packages/shared/src/types.ts:52-118`

- [ ] **Step 1: Add task_source to each interface**

Add `task_source?: TaskSource;` to each of these interfaces in `packages/shared/src/types.ts`:

In `TaskSubmission` (after `payload: string;`):
```typescript
  task_source?: TaskSource;
```

In `Task` (after `submitted_at: string;`):
```typescript
  task_source?: TaskSource;
```

In `JobSubmission` (after `marketplaces?: MarketplaceConfig[];`):
```typescript
  task_source?: TaskSource;
```

In `Job` (after `marketplaces?: MarketplaceConfig[];`):
```typescript
  task_source?: TaskSource;
```

In `TaskResultSubmission` (after `stderr: string;`):
```typescript
  task_source?: TaskSource;
```

`TaskResult` inherits from `TaskResultSubmission`, so it gets the field automatically.

Do **NOT** add to `JobAttempt` — it's only used internally by orchestrator/executors which don't need source context.

- [ ] **Step 2: Verify shared package builds**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): add optional task_source field to all pipeline interfaces"
```

---

### Task 3: Update lark-listener MessageHandler to pass task_source

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts:29-56`
- Modify: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`

- [ ] **Step 1: Update existing test to expect task_source**

In `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`, update the test `'submits text message as plain string payload'`:

```typescript
  it('submits text message as plain string payload with task_source', async () => {
    await handler.handle(makeEvent());

    expect(submitter.submit).toHaveBeenCalledWith(
      'fix the CI pipeline',
      { source: 'lark', message_id: 'om_msg1' },
    );
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    expect(dedup.add).toHaveBeenCalledWith('om_msg1');
  });
```

Also update the `'submits image message as JSON payload'` test to verify task_source is the second argument:

```typescript
  it('submits image message with task_source', async () => {
    await handler.handle(
      makeEvent({
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_abc' }),
      }),
    );

    const payload = submitter.submit.mock.calls[0][0];
    const taskSource = submitter.submit.mock.calls[0][1];
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe('image');
    expect(parsed.key).toBe('img_v3_abc');
    expect(taskSource).toEqual({ source: 'lark', message_id: 'om_msg1' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: FAIL — `submit` is called with 1 argument, not 2

- [ ] **Step 3: Update MessageHandler to pass task_source**

In `packages/daemon/lark-listener/src/message-handler.ts`, update the `handle` method. Replace:

```typescript
    const taskId = await this.submitter.submit(payload);
```

With:

```typescript
    const taskSource = { source: 'lark' as const, message_id: message.message_id };
    const taskId = await this.submitter.submit(payload, taskSource);
```

Add import at top:

```typescript
import type { TaskSource } from '@local-agent/shared';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts
git commit -m "feat(lark-listener): pass task_source with message_id from MessageHandler"
```

---

### Task 4: Update TaskSubmitter to accept and forward task_source

**Files:**
- Modify: `packages/daemon/lark-listener/src/adapters/task-submitter.ts:16-17`
- Modify: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`

- [ ] **Step 1: Update test to verify task_source in POST body**

In `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`, update the first test and add a new one:

Update `'posts TaskSubmission and returns task_id on success'`:

```typescript
  it('posts TaskSubmission with task_source and returns task_id on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({ task_id: 'task-abc', task_type: 'generic', payload: 'hello' }),
    });

    const taskSource = { source: 'lark' as const, message_id: 'om_msg1' };
    const result = await submitter.submit('hello', taskSource);
    expect(result).toBe('task-abc');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/tasks',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'generic', payload: 'hello', task_source: taskSource }),
      }),
    );
  });
```

Add a test for submitting without task_source (backwards compat):

```typescript
  it('posts TaskSubmission without task_source when not provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ task_id: 'task-xyz' }),
    });

    const result = await submitter.submit('hello');
    expect(result).toBe('task-xyz');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/tasks',
      expect.objectContaining({
        body: JSON.stringify({ task_type: 'generic', payload: 'hello' }),
      }),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/task-submitter.test.ts`
Expected: FAIL — `submit` doesn't accept second argument / body doesn't include task_source

- [ ] **Step 3: Update TaskSubmitter.submit signature**

In `packages/daemon/lark-listener/src/adapters/task-submitter.ts`, update:

```typescript
import { createLogger, type TaskSubmission, type TaskSource } from '@local-agent/shared';
```

Replace the `submit` method signature and body construction:

```typescript
  async submit(payload: string, taskSource?: TaskSource): Promise<string | null> {
    const body: TaskSubmission = {
      task_type: 'generic',
      payload,
      ...(taskSource ? { task_source: taskSource } : {}),
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/task-submitter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/adapters/task-submitter.ts packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts
git commit -m "feat(lark-listener): forward task_source in TaskSubmitter POST body"
```

---

### Task 5: Update API POST /tasks to validate and include task_source

**Files:**
- Modify: `packages/api/src/routes/tasks.ts:9-39`
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`

- [ ] **Step 1: Add tests for task_source validation**

Add to `packages/api/src/__tests__/routes/tasks.test.ts` in the `'POST /tasks'` describe block:

```typescript
  it('returns 201 with task_source when provided', async () => {
    const app = buildApp();
    const taskSource = { source: 'lark', message_id: 'om_abc123' };
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello', task_source: taskSource });
    expect(res.status).toBe(201);
    expect(res.body.task_source).toEqual(taskSource);
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith(
      expect.objectContaining({ task_source: taskSource }),
    );
  });

  it('returns 201 without task_source when not provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello' });
    expect(res.status).toBe(201);
    expect(res.body.task_source).toBeUndefined();
  });

  it('returns 400 when task_source has invalid shape', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello', task_source: { source: 'unknown' } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when task_source.source is lark but message_id is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello', task_source: { source: 'lark' } });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/api && npx vitest run src/__tests__/routes/tasks.test.ts`
Expected: FAIL — route doesn't validate or include task_source

- [ ] **Step 3: Update the tasks route**

In `packages/api/src/routes/tasks.ts`, update the import:

```typescript
import { Task, isValidTaskSource } from '@local-agent/shared';
```

In the POST handler, after existing validation, add task_source handling. Replace the body extraction line and add validation:

```typescript
      const { task_type, payload, task_source } = req.body;

      // ... existing task_type and payload validation ...

      if (task_source !== undefined && !isValidTaskSource(task_source)) {
        res.status(400).json({ error: 'task_source must be a valid source object' });
        return;
      }

      const task: Task = {
        task_id: uuidv4(),
        task_type,
        payload,
        submitted_at: new Date().toISOString(),
        ...(task_source ? { task_source } : {}),
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run src/__tests__/routes/tasks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/tasks.ts packages/api/src/__tests__/routes/tasks.test.ts
git commit -m "feat(api): validate and pass through task_source on POST /tasks"
```

---

### Task 6: Update EnrichmentService to pass through task_source

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts:55-62`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Add tests for task_source pass-through**

Add a new describe block in `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`:

```typescript
  describe('task_source passthrough', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          default: {
            executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          },
        },
      });
    });

    it('includes task_source in enriched job when present on task', () => {
      const task = createTask({ task_source: { source: 'lark', message_id: 'om_abc' } });
      const result = service.enrich(task);

      expect(result).not.toBeNull();
      expect(result!.task_source).toEqual({ source: 'lark', message_id: 'om_abc' });
    });

    it('omits task_source when not present on task', () => {
      const task = createTask();
      const result = service.enrich(task);

      expect(result).not.toBeNull();
      expect(result!.task_source).toBeUndefined();
    });
  });
```

Also update the `createTask` helper to accept `task_source` — since `Task` interface now includes it, the existing `Partial<Task>` overrides already support it. No changes needed to the helper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: FAIL — `result.task_source` is undefined even when task has it

- [ ] **Step 3: Update EnrichmentService.enrich**

In `packages/daemon/task-enrichment/src/enrichment-service.ts`, update the return statement (around line 55-62):

```typescript
    return {
      task_id: task.task_id,
      task_type: task.task_type,
      payload: task.payload,
      executors,
      submitted_at: task.submitted_at,
      marketplaces: rule.marketplaces,
      ...(task.task_source ? { task_source: task.task_source } : {}),
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "feat(enrichment): pass through task_source from task to job submission"
```

---

### Task 7: Update API POST /jobs to validate and include task_source

**Files:**
- Modify: `packages/api/src/routes/jobs.ts:9-57`
- Create: `packages/api/src/__tests__/routes/jobs.test.ts`

Note: There is no existing jobs test file. We create one with the task_source tests and basic sanity tests.

- [ ] **Step 1: Write the test file**

Create `packages/api/src/__tests__/routes/jobs.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createJobRoutes } from '../../routes/jobs';

const mockRabbitMQ = {
  publishJob: vi.fn().mockReturnValue(true),
  getNextJob: vi.fn(),
  ackJob: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', createJobRoutes(mockRabbitMQ as any));
  return app;
}

function validJobSubmission() {
  return {
    task_id: 'task-123',
    task_type: 'generic',
    payload: 'hello',
    executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
    submitted_at: '2026-03-31T00:00:00.000Z',
  };
}

describe('POST /jobs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 201 with task_source when provided', async () => {
    const app = buildApp();
    const taskSource = { source: 'lark', message_id: 'om_abc123' };
    const res = await request(app)
      .post('/jobs')
      .send({ ...validJobSubmission(), task_source: taskSource });
    expect(res.status).toBe(201);
    expect(res.body.task_source).toEqual(taskSource);
    expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(
      expect.objectContaining({ task_source: taskSource }),
    );
  });

  it('returns 201 without task_source when not provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send(validJobSubmission());
    expect(res.status).toBe(201);
    expect(res.body.task_source).toBeUndefined();
  });

  it('returns 400 when task_source has invalid shape', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send({ ...validJobSubmission(), task_source: { source: 'unknown' } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when task_source.source is lark but message_id missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send({ ...validJobSubmission(), task_source: { source: 'lark' } });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/api && npx vitest run src/__tests__/routes/jobs.test.ts`
Expected: FAIL — route doesn't validate or include task_source

- [ ] **Step 3: Update the jobs route**

In `packages/api/src/routes/jobs.ts`, update the import:

```typescript
import { Job, isValidExecutorPreferences, ExecutorPreference, isValidTaskSource } from '@local-agent/shared';
```

In the POST handler, update body extraction and add validation:

```typescript
      const { task_id, task_type, payload, executors, submitted_at, marketplaces, task_source } = req.body;

      // ... existing validation ...

      if (task_source !== undefined && !isValidTaskSource(task_source)) {
        res.status(400).json({ error: 'task_source must be a valid source object' });
        return;
      }

      const job: Job = {
        job_id: uuidv4(),
        task_id,
        task_type,
        payload,
        executors,
        submitted_at,
        enriched_at: new Date().toISOString(),
        ...(marketplaces ? { marketplaces } : {}),
        ...(task_source ? { task_source } : {}),
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run src/__tests__/routes/jobs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/jobs.ts packages/api/src/__tests__/routes/jobs.test.ts
git commit -m "feat(api): validate and pass through task_source on POST /jobs"
```

---

### Task 8: Update TaskPoller to forward task_source from job to result

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts:40-46`
- Modify: `packages/daemon/task/src/__tests__/task-poller.test.ts`

- [ ] **Step 1: Add test for task_source forwarding**

In `packages/daemon/task/src/__tests__/task-poller.test.ts`, add a new test in the `'pollOnce'` describe block:

```typescript
    it('forwards task_source from job to result submission', async () => {
      const taskSource = { source: 'lark' as const, message_id: 'om_abc123' };
      const job = createJob({ task_source: taskSource });

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job),
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

      const resultPostBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(resultPostBody.task_source).toEqual(taskSource);
    });

    it('omits task_source from result when job has none', async () => {
      const job = createJob(); // no task_source

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job),
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

      const resultPostBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(resultPostBody.task_source).toBeUndefined();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task && npx vitest run src/__tests__/task-poller.test.ts`
Expected: FAIL — result POST body doesn't include task_source

- [ ] **Step 3: Update TaskPoller.pollOnce**

In `packages/daemon/task/src/task-poller.ts`, after the orchestrator returns the result (around line 34), attach task_source before posting. Replace:

```typescript
      // Publish result to API (best-effort)
      try {
        const resultRes = await fetch(`${this.apiUrl}/results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        });
```

With:

```typescript
      // Attach task_source from job to result for downstream routing
      const resultWithSource: TaskResultSubmission = {
        ...result,
        ...(job.task_source ? { task_source: job.task_source } : {}),
      };

      // Publish result to API (best-effort)
      try {
        const resultRes = await fetch(`${this.apiUrl}/results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(resultWithSource),
        });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task && npx vitest run src/__tests__/task-poller.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/task-poller.ts packages/daemon/task/src/__tests__/task-poller.test.ts
git commit -m "feat(task-daemon): forward task_source from job to result submission"
```

---

### Task 9: Update API POST /results to validate and include task_source

**Files:**
- Modify: `packages/api/src/routes/results.ts:9-48`
- Modify: `packages/api/src/__tests__/routes/results.test.ts`

- [ ] **Step 1: Add tests for task_source validation**

Add to `packages/api/src/__tests__/routes/results.test.ts` in the `'POST /results'` describe block:

```typescript
  it('returns 201 with task_source when provided', async () => {
    const app = buildApp();
    const taskSource = { source: 'lark', message_id: 'om_abc123' };
    const res = await request(app)
      .post('/results')
      .send({ ...validSubmission(), task_source: taskSource });
    expect(res.status).toBe(201);
    expect(res.body.task_source).toEqual(taskSource);
    expect(mockRabbitMQ.publishToExchange).toHaveBeenCalledWith(
      'results',
      expect.objectContaining({ task_source: taskSource }),
    );
  });

  it('returns 201 without task_source when not provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/results')
      .send(validSubmission());
    expect(res.status).toBe(201);
    expect(res.body.task_source).toBeUndefined();
  });

  it('returns 400 when task_source has invalid shape', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/results')
      .send({ ...validSubmission(), task_source: { source: 'unknown' } });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/api && npx vitest run src/__tests__/routes/results.test.ts`
Expected: FAIL — route doesn't validate or include task_source

- [ ] **Step 3: Update the results route**

In `packages/api/src/routes/results.ts`, update the import:

```typescript
import { TaskResult, RESULT_STATUSES, DEFAULT_RESULTS_EXCHANGE_NAME, isValidTaskSource } from '@local-agent/shared';
```

In the POST handler, update extraction and add validation:

```typescript
      const { job_id, task_id, status, exit_code, stdout, stderr, task_source } = req.body;

      // ... existing validation ...

      if (task_source !== undefined && !isValidTaskSource(task_source)) {
        res.status(400).json({ error: 'task_source must be a valid source object' });
        return;
      }

      const result: TaskResult = {
        result_id: uuidv4(),
        job_id,
        task_id,
        status: status as TaskResult['status'],
        exit_code: typeof exit_code === 'number' ? exit_code : null,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        completed_at: new Date().toISOString(),
        ...(task_source ? { task_source } : {}),
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run src/__tests__/routes/results.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/results.ts packages/api/src/__tests__/routes/results.test.ts
git commit -m "feat(api): validate and pass through task_source on POST /results"
```

---

### Task 10: Update LarkNotifier to reply in-thread when task_source is present

**Files:**
- Modify: `packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`

- [ ] **Step 1: Add tests for thread reply behavior**

Add to `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`:

```typescript
  it('replies in thread when task_source is lark', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    const result = createResult({
      task_source: { source: 'lark', message_id: 'om_original_msg' },
    });
    await notifier.notify(result);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Should call reply API, not send API
    expect(mockFetch).toHaveBeenNthCalledWith(2,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_original_msg/reply',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer token-abc',
        },
      }),
    );
    // Verify reply_in_thread is set
    const sendCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    expect(body.reply_in_thread).toBe(true);
    expect(body.msg_type).toBe('text');
  });

  it('sends DM when task_source is not present (fallback)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult()); // no task_source

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Should call send API (existing DM behavior)
    expect(mockFetch).toHaveBeenNthCalledWith(2,
      'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id',
      expect.objectContaining({ method: 'POST' }),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts`
Expected: FAIL — notifier always sends DM, never uses reply API

- [ ] **Step 3: Update LarkNotifier**

In `packages/daemon/lark-result/src/adapters/lark-notifier.ts`:

Update the import:
```typescript
import { TaskResult, createLogger, type TaskSource } from '@local-agent/shared';
```

Add a constant for the reply URL template:
```typescript
const LARK_REPLY_URL = (messageId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reply`;
```

Update the `sendNotification` method to branch on task_source. Replace everything from `const snippet = ...` through the end of the method (lines 50–76 in the current file) with:

```typescript
    const snippet = result.stdout.length > MAX_SNIPPET_CHARS
      ? result.stdout.substring(0, MAX_SNIPPET_CHARS)
      : result.stdout;

    const text = [
      `Job ${result.job_id} (Task ${result.task_id}) — ${result.status}`,
      `Exit code: ${result.exit_code ?? 'N/A'}`,
      snippet ? `Output:\n${snippet}` : 'No output',
    ].join('\n');

    let msgRes: Response;

    if (result.task_source?.source === 'lark') {
      // Reply in thread to the original Lark message
      msgRes = await fetch(LARK_REPLY_URL(result.task_source.message_id), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.tenant_access_token}`,
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: JSON.stringify({ text }),
          reply_in_thread: true,
        }),
      });
    } else {
      // Fallback: send DM to fixed recipient
      msgRes = await fetch(LARK_MESSAGE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.tenant_access_token}`,
        },
        body: JSON.stringify({
          receive_id: this.recipientId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      });
    }

    const msgData = await msgRes.json() as { code: number };

    if (msgData.code !== 0) {
      throw new Error(`Lark message send failed with code ${msgData.code}`);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts`
Expected: PASS

- [ ] **Step 5: Run ALL tests across the project**

Run from project root: `npx vitest run --reporter=verbose` (or run each package individually)

Verify no regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/lark-result/src/adapters/lark-notifier.ts packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts
git commit -m "feat(lark-result): reply in-thread when task_source is lark, fallback to DM"
```
