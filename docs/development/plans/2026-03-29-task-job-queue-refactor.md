# Task/Job Queue Refactor Implementation Plan

**Goal:** Split the task queue into a slim task submission queue and an enriched job execution queue, connected by a new enrichment daemon.

**Architecture:** Clients submit slim tasks (task_type + payload) to the API, which publishes to a `tasks` queue. A new `task-enrichment-daemon` polls raw tasks, resolves executor/model from a YAML config, and publishes enriched jobs to a `jobs` queue. The existing `task-daemon` is refactored to consume jobs instead of tasks.

**Tech Stack:** TypeScript, Node.js 20, RabbitMQ (amqplib), Express, Vitest, Rush monorepo, Docker

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `packages/task-enrichment-daemon/package.json` | Package manifest |
| `packages/task-enrichment-daemon/tsconfig.json` | TypeScript config |
| `packages/task-enrichment-daemon/vitest.config.ts` | Vitest config |
| `packages/task-enrichment-daemon/src/index.ts` | Entry point — load config, create poller, start |
| `packages/task-enrichment-daemon/src/config.ts` | Config loading (extends DaemonConfig with enrichment config path) |
| `packages/task-enrichment-daemon/src/enrichment-service.ts` | YAML config loading + task→job mapping |
| `packages/task-enrichment-daemon/src/enrichment-poller.ts` | Polls /tasks/next, enriches, publishes to /jobs |
| `packages/task-enrichment-daemon/src/__tests__/enrichment-service.test.ts` | Unit tests for enrichment logic |
| `packages/task-enrichment-daemon/src/__tests__/enrichment-poller.test.ts` | Unit tests for poller flow |
| `packages/task-enrichment-daemon/config/enrichment.yaml` | Default enrichment rules |
| `packages/task-enrichment-daemon/Dockerfile` | Docker build |
| `packages/api/src/routes/jobs.ts` | Job API routes (POST /jobs, GET /jobs/next, POST /jobs/:id/ack) |

### Modified Files

| File | What Changes |
|------|-------------|
| `packages/shared/src/types.ts` | Remove executor/model from TaskSubmission/Task, add Job/JobSubmission, update TaskResultSubmission |
| `packages/shared/src/constants.ts` | Add DEFAULT_JOBS_QUEUE_NAME |
| `packages/shared/src/index.ts` | Export new types and constant |
| `packages/api/src/services/rabbitmq.ts` | Assert jobs queue, add publishJob/getNextJob/ackJob methods |
| `packages/api/src/routes/tasks.ts` | Remove executor/model validation from POST /tasks |
| `packages/api/src/routes/results.ts` | Add job_id validation to POST /results |
| `packages/api/src/app.ts` | Mount /jobs routes |
| `packages/task-daemon/src/ports/task-executor.ts` | Change Task→Job in interface |
| `packages/task-daemon/src/adapters/claude-cli-executor.ts` | Change Task→Job |
| `packages/task-daemon/src/adapters/ttadk-executor.ts` | Change Task→Job |
| `packages/task-daemon/src/core/task-orchestrator.ts` | Change Task→Job |
| `packages/task-daemon/src/task-poller.ts` | Poll /jobs/next, ACK /jobs/:id/ack, send job_id+task_id in results |
| `packages/task-daemon/src/task-daemon.ts` | No changes (uses same config) |
| `packages/task-daemon/src/__tests__/task-poller.test.ts` | Update to use Job type and /jobs endpoints |
| `packages/task-daemon/src/adapters/__tests__/claude-cli-executor.test.ts` | Update to use Job type |
| `packages/task-daemon/src/adapters/__tests__/ttadk-executor.test.ts` | Update to use Job type |
| `packages/task-daemon/src/core/__tests__/task-orchestrator.test.ts` | Update to use Job type |
| `packages/lark-result-daemon/src/lark-poller.ts` | Log job_id alongside task_id |
| `packages/lark-result-daemon/src/adapters/lark-notifier.ts` | Include job_id in notification text |
| `packages/cli/src/commands/submit.ts` | Remove executor/model from SubmitOptions and TaskSubmission usage |
| `packages/cli/src/__tests__/submit.test.ts` | Remove executor/model from test submissions and assertions |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Remove executor/model from POST /tasks test payloads and assertions |
| `packages/api/src/__tests__/routes/results.test.ts` | Add job_id to validSubmission helper and assertions |
| `rush.json` | Add task-enrichment-daemon project |
| `docker-compose.yml` | Add task-enrichment-daemon service |

---

## Task 1: Update shared types and constants

**Files:**
- Modify: `packages/shared/src/types.ts:31-45` (TaskSubmission and Task interfaces)
- Modify: `packages/shared/src/types.ts:52-63` (TaskResultSubmission and TaskResult)
- Modify: `packages/shared/src/constants.ts:8` (add new constant after last line)
- Modify: `packages/shared/src/index.ts:1-29` (add new exports)

- [ ] **Step 1: Update TaskSubmission — remove executor and executor_model**

In `packages/shared/src/types.ts`, replace lines 31-36:

```typescript
// BEFORE:
export interface TaskSubmission {
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
}

// AFTER:
export interface TaskSubmission {
  task_type: string;
  payload: string;
}
```

- [ ] **Step 2: Update Task — remove executor and executor_model**

In `packages/shared/src/types.ts`, replace lines 38-45:

```typescript
// BEFORE:
export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
}

// AFTER:
export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  submitted_at: string;
}
```

- [ ] **Step 3: Add Job and JobSubmission types**

After the Task interface in `packages/shared/src/types.ts`, add:

```typescript
export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
}

export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
  enriched_at: string;
}
```

- [ ] **Step 4: Update TaskResultSubmission — add job_id**

In `packages/shared/src/types.ts`, update the TaskResultSubmission interface:

```typescript
// BEFORE:
export interface TaskResultSubmission {
  task_id: string;
  status: ResultStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

// AFTER:
export interface TaskResultSubmission {
  job_id: string;
  task_id: string;
  status: ResultStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}
```

- [ ] **Step 5: Add DEFAULT_JOBS_QUEUE_NAME constant**

In `packages/shared/src/constants.ts`, add after line 8:

```typescript
export const DEFAULT_JOBS_QUEUE_NAME = 'jobs';
```

- [ ] **Step 6: Update shared index exports**

In `packages/shared/src/index.ts`, add the new exports:

```typescript
// Add to the types export block:
export {
  TaskSubmission,
  Task,
  Job,            // NEW
  JobSubmission,  // NEW
  TASK_EXECUTORS,
  TASK_EXECUTOR_OPTIONS,
  isTaskExecutorType,
  type TaskExecutorType,
  EXECUTOR_MODELS,
  type ExecutorModelType,
  isValidExecutorModel,
  getExecutorModelOptions,
  type TaskResultSubmission,
  type TaskResult,
  type ResultStatus,
  RESULT_STATUSES,
  MAX_RESULT_OUTPUT_BYTES,
} from './types';

// Add to the constants export block:
export {
  DEFAULT_QUEUE_NAME,
  DEFAULT_PORT,
  DEFAULT_RABBITMQ_URL,
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_RESULTS_EXCHANGE_NAME,
  DEFAULT_LARK_QUEUE_NAME,
  DEFAULT_JOBS_QUEUE_NAME,  // NEW
} from './constants';
```

- [ ] **Step 7: Build shared package to verify types compile**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors (downstream packages will have errors — that's expected, we fix them in later tasks)

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/constants.ts packages/shared/src/index.ts
git commit -m "feat(shared): add Job/JobSubmission types, remove executor from Task, add job_id to results"
```

---

## Task 2: Update API — rabbitmq service for jobs queue

**Files:**
- Modify: `packages/api/src/services/rabbitmq.ts:1-130`

- [ ] **Step 1: Add Job import and jobs queue assertion**

In `packages/api/src/services/rabbitmq.ts`, update the import on line 2:

```typescript
// BEFORE:
import { Task, TaskResult, createLogger, DEFAULT_RESULTS_EXCHANGE_NAME, DEFAULT_LARK_QUEUE_NAME } from '@local-agent/shared';

// AFTER:
import { Task, Job, TaskResult, createLogger, DEFAULT_RESULTS_EXCHANGE_NAME, DEFAULT_LARK_QUEUE_NAME, DEFAULT_JOBS_QUEUE_NAME } from '@local-agent/shared';
```

- [ ] **Step 2: Add jobs queue assertion in connect()**

In `packages/api/src/services/rabbitmq.ts`, inside the `connect()` method, after line 34 (`await ch.assertQueue(this.queueName, { durable: true });`), add:

```typescript
    await ch.assertQueue(DEFAULT_JOBS_QUEUE_NAME, { durable: true });
```

- [ ] **Step 3: Add jobs delivery map**

In `packages/api/src/services/rabbitmq.ts`, after line 15 (`private queueDeliveryMaps = ...`), add:

```typescript
  private jobsDeliveryMap = new Map<string, GetMessage>();
```

- [ ] **Step 4: Add publishJob method**

After the `publish()` method (after line 51), add:

```typescript
  publishJob(message: Job): boolean {
    if (!this.channel) throw new Error('Not connected');
    const buffer = Buffer.from(JSON.stringify(message));
    return this.channel.sendToQueue(DEFAULT_JOBS_QUEUE_NAME, buffer, { persistent: true });
  }
```

- [ ] **Step 5: Add getNextJob method**

After the new `publishJob()` method, add:

```typescript
  async getNextJob(): Promise<Job | null> {
    if (!this.channel) throw new Error('Not connected');
    const msg = await this.channel.get(DEFAULT_JOBS_QUEUE_NAME, { noAck: false });
    if (msg === false) return null;

    const parsed = JSON.parse(msg.content.toString()) as Job;

    if (this.jobsDeliveryMap.has(parsed.job_id)) {
      logger.error(
        { job_id: parsed.job_id, deliveryTag: msg.fields.deliveryTag },
        'Duplicate job_id received while an earlier delivery is still outstanding; acknowledging duplicate message',
      );
      this.channel.ack(msg);
      return null;
    }

    this.jobsDeliveryMap.set(parsed.job_id, msg as unknown as GetMessage);

    return parsed;
  }
```

- [ ] **Step 6: Add ackJob method**

After the new `getNextJob()` method, add:

```typescript
  ackJob(jobId: string): boolean {
    if (!this.channel) return false;
    const delivery = this.jobsDeliveryMap.get(jobId);
    if (!delivery) return false;
    this.channel.ack(delivery as any);
    this.jobsDeliveryMap.delete(jobId);
    return true;
  }
```

- [ ] **Step 7: Build API to verify it compiles**

Run: `cd packages/api && npx tsc --noEmit`
Expected: Errors in routes/tasks.ts and routes/results.ts (we fix those in next tasks). The rabbitmq.ts file itself should have no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/services/rabbitmq.ts
git commit -m "feat(api): add jobs queue support to RabbitMQService"
```

---

## Task 3: Update API — task routes (remove executor/model validation)

**Files:**
- Modify: `packages/api/src/routes/tasks.ts:1-81`

- [ ] **Step 1: Update imports — remove executor validation helpers**

In `packages/api/src/routes/tasks.ts`, replace line 3:

```typescript
// BEFORE:
import { Task, TASK_EXECUTOR_OPTIONS, isTaskExecutorType, isValidExecutorModel, getExecutorModelOptions } from '@local-agent/shared';

// AFTER:
import { Task } from '@local-agent/shared';
```

- [ ] **Step 2: Remove executor/model validation from POST handler**

In `packages/api/src/routes/tasks.ts`, replace lines 11-39 (the destructuring through task construction):

```typescript
// BEFORE:
      const { task_type, payload, executor, executor_model } = req.body;

      if (typeof task_type !== 'string' || !task_type) {
        res.status(400).json({ error: 'task_type is required and must be a string' });
        return;
      }
      if (typeof payload !== 'string') {
        res.status(400).json({ error: 'payload is required and must be a string' });
        return;
      }
      if (typeof executor !== 'string' || !isTaskExecutorType(executor)) {
        res.status(400).json({ error: `executor is required and must be one of: ${TASK_EXECUTOR_OPTIONS}` });
        return;
      }
      if (!isValidExecutorModel(executor, executor_model)) {
        res.status(400).json({
          error: `executor_model must be one of: ${getExecutorModelOptions(executor)}`,
        });
        return;
      }

      const task: Task = {
        task_id: uuidv4(),
        task_type,
        payload,
        executor,
        executor_model,
        submitted_at: new Date().toISOString(),
      };

// AFTER:
      const { task_type, payload } = req.body;

      if (typeof task_type !== 'string' || !task_type) {
        res.status(400).json({ error: 'task_type is required and must be a string' });
        return;
      }
      if (typeof payload !== 'string') {
        res.status(400).json({ error: 'payload is required and must be a string' });
        return;
      }

      const task: Task = {
        task_id: uuidv4(),
        task_type,
        payload,
        submitted_at: new Date().toISOString(),
      };
```

- [ ] **Step 3: Build API to verify tasks route compiles**

Run: `cd packages/api && npx tsc --noEmit`
Expected: May still have errors in results.ts (fixed in Task 6). tasks.ts should compile.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/tasks.ts
git commit -m "feat(api): simplify POST /tasks to accept only task_type and payload"
```

---

## Task 4: Add API — jobs routes

**Files:**
- Create: `packages/api/src/routes/jobs.ts`
- Modify: `packages/api/src/app.ts:1-18`

- [ ] **Step 1: Create jobs route file**

Create `packages/api/src/routes/jobs.ts`:

```typescript
import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Job, isTaskExecutorType, isValidExecutorModel, TASK_EXECUTOR_OPTIONS, getExecutorModelOptions } from '@local-agent/shared';
import { RabbitMQService } from '../services/rabbitmq';

export function createJobRoutes(rabbitmq: RabbitMQService): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { task_id, task_type, payload, executor, executor_model, submitted_at } = req.body;

      if (typeof task_id !== 'string' || !task_id) {
        res.status(400).json({ error: 'task_id is required and must be a string' });
        return;
      }
      if (typeof task_type !== 'string' || !task_type) {
        res.status(400).json({ error: 'task_type is required and must be a string' });
        return;
      }
      if (typeof payload !== 'string') {
        res.status(400).json({ error: 'payload is required and must be a string' });
        return;
      }
      if (typeof executor !== 'string' || !isTaskExecutorType(executor)) {
        res.status(400).json({ error: `executor is required and must be one of: ${TASK_EXECUTOR_OPTIONS}` });
        return;
      }
      if (!isValidExecutorModel(executor, executor_model)) {
        res.status(400).json({
          error: `executor_model must be one of: ${getExecutorModelOptions(executor)}`,
        });
        return;
      }
      if (typeof submitted_at !== 'string' || !submitted_at) {
        res.status(400).json({ error: 'submitted_at is required and must be a string' });
        return;
      }

      const job: Job = {
        job_id: uuidv4(),
        task_id,
        task_type,
        payload,
        executor,
        executor_model,
        submitted_at,
        enriched_at: new Date().toISOString(),
      };
      const buffered = rabbitmq.publishJob(job);

      if (!buffered) {
        res.status(503).json({ error: 'Server busy, try again later' });
        return;
      }

      res.status(201).json(job);
    } catch (err) {
      next(err);
    }
  });

  router.get('/next', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await rabbitmq.getNextJob();
      if (!job) {
        res.status(204).send();
        return;
      }
      res.status(200).json(job);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/ack', (req: Request, res: Response, next: NextFunction) => {
    try {
      const acked = rabbitmq.ackJob(req.params.id);
      if (!acked) {
        res.status(404).json({ error: 'Job not found or already acknowledged' });
        return;
      }
      res.status(200).json({ acknowledged: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
```

- [ ] **Step 2: Mount jobs routes in app.ts**

In `packages/api/src/app.ts`, add the import and route mount:

```typescript
// BEFORE:
import express from 'express';
import { createTaskRoutes } from './routes/tasks';
import { createResultRoutes } from './routes/results';
import { createHealthRoutes } from './routes/health';
import { errorHandler } from './middleware/error-handler';
import { RabbitMQService } from './services/rabbitmq';

export function createApp(rabbitmq: RabbitMQService): express.Application {
  const app = express();

  app.use(express.json());
  app.use('/tasks', createTaskRoutes(rabbitmq));
  app.use('/results', createResultRoutes(rabbitmq));
  app.use('/health', createHealthRoutes(rabbitmq));
  app.use(errorHandler);

  return app;
}

// AFTER:
import express from 'express';
import { createTaskRoutes } from './routes/tasks';
import { createJobRoutes } from './routes/jobs';
import { createResultRoutes } from './routes/results';
import { createHealthRoutes } from './routes/health';
import { errorHandler } from './middleware/error-handler';
import { RabbitMQService } from './services/rabbitmq';

export function createApp(rabbitmq: RabbitMQService): express.Application {
  const app = express();

  app.use(express.json());
  app.use('/tasks', createTaskRoutes(rabbitmq));
  app.use('/jobs', createJobRoutes(rabbitmq));
  app.use('/results', createResultRoutes(rabbitmq));
  app.use('/health', createHealthRoutes(rabbitmq));
  app.use(errorHandler);

  return app;
}
```

- [ ] **Step 3: Build API to verify it compiles**

Run: `cd packages/api && npx tsc --noEmit`
Expected: May still have errors in results.ts (fixed in Task 6). jobs.ts and app.ts should compile.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/jobs.ts packages/api/src/app.ts
git commit -m "feat(api): add /jobs routes for enriched job queue"
```

---

## Task 5: Update API tests — tasks route tests (remove executor/model)

**Files:**
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`

- [ ] **Step 1: Update POST /tasks test payloads — remove executor and executor_model**

In `packages/api/src/__tests__/routes/tasks.test.ts`, update all `.send()` calls for `POST /tasks` to only include `task_type` and `payload`. Remove `executor` and `executor_model` from both the request payloads and the response/publish assertions.

For the '201 with submitted task' test:
```typescript
// BEFORE:
  it('returns 201 with submitted task', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello', executor: 'ttadk', executor_model: 'gpt-5.4' });
    expect(res.status).toBe(201);
    expect(res.body.task_id).toBeDefined();
    expect(res.body.task_type).toBe('generic');
    expect(res.body.payload).toBe('hello');
    expect(res.body.executor).toBe('ttadk');
    expect(res.body.executor_model).toBe('gpt-5.4');
    expect(res.body.submitted_at).toBeDefined();
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith({
      task_id: expect.any(String),
      task_type: 'generic',
      payload: 'hello',
      executor: 'ttadk',
      executor_model: 'gpt-5.4',
      submitted_at: expect.any(String),
    });
  });

// AFTER:
  it('returns 201 with submitted task', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello' });
    expect(res.status).toBe(201);
    expect(res.body.task_id).toBeDefined();
    expect(res.body.task_type).toBe('generic');
    expect(res.body.payload).toBe('hello');
    expect(res.body.submitted_at).toBeDefined();
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith({
      task_id: expect.any(String),
      task_type: 'generic',
      payload: 'hello',
      submitted_at: expect.any(String),
    });
  });
```

- [ ] **Step 2: Update backpressure test — remove executor/model from payload**

```typescript
// BEFORE:
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello', executor: 'ttadk', executor_model: 'gpt-5.4' });

// AFTER:
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello' });
```

- [ ] **Step 3: Remove executor-specific validation tests**

Remove the following tests entirely since executor/executor_model are no longer validated in POST /tasks:
- `'returns 400 when executor missing'`
- `'returns 400 when executor invalid'`
- `'returns 201 with executor_model in response'`
- `'returns 400 when executor_model is missing'`
- `'returns 400 when executor_model is invalid for executor'`

Also update the remaining 400 tests to send only `task_type`/`payload`-relevant payloads (remove executor from those .send() calls).

- [ ] **Step 4: Update GET /tasks/next mock to exclude executor/model**

In the `GET /tasks/next` describe block, update the mock return value:
```typescript
// BEFORE:
    mockRabbitMQ.getNext.mockResolvedValue({
      task_id: 'abc-123',
      task_type: 'generic',
      payload: 'hello',
      executor: 'claude_code',
      executor_model: 'opus',
      submitted_at: '2026-03-26T00:00:00.000Z',
    });
    ...
    expect(res.body.executor).toBe('claude_code');

// AFTER:
    mockRabbitMQ.getNext.mockResolvedValue({
      task_id: 'abc-123',
      task_type: 'generic',
      payload: 'hello',
      submitted_at: '2026-03-26T00:00:00.000Z',
    });
```

Remove the `expect(res.body.executor)` assertion.

- [ ] **Step 5: Run API tests to verify**

Run: `cd packages/api && npx vitest run`
Expected: All tasks route tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/__tests__/routes/tasks.test.ts
git commit -m "test(api): update tasks route tests for slim task submission"
```

---

## Task 6: Update API — results route (add job_id validation)

**Files:**
- Modify: `packages/api/src/routes/results.ts:9-30`

- [ ] **Step 1: Add job_id to result validation and construction**

In `packages/api/src/routes/results.ts`, update the POST handler (lines 11-30):

```typescript
// BEFORE:
      const { task_id, status, exit_code, stdout, stderr } = req.body;

      if (typeof task_id !== 'string' || !task_id) {
        res.status(400).json({ error: 'task_id is required and must be a string' });
        return;
      }
      if (typeof status !== 'string' || !RESULT_STATUSES.includes(status as any)) {
        res.status(400).json({ error: `status is required and must be one of: ${RESULT_STATUSES.join(', ')}` });
        return;
      }

      const result: TaskResult = {
        result_id: uuidv4(),
        task_id,
        status: status as TaskResult['status'],
        exit_code: typeof exit_code === 'number' ? exit_code : null,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        completed_at: new Date().toISOString(),
      };

// AFTER:
      const { job_id, task_id, status, exit_code, stdout, stderr } = req.body;

      if (typeof job_id !== 'string' || !job_id) {
        res.status(400).json({ error: 'job_id is required and must be a string' });
        return;
      }
      if (typeof task_id !== 'string' || !task_id) {
        res.status(400).json({ error: 'task_id is required and must be a string' });
        return;
      }
      if (typeof status !== 'string' || !RESULT_STATUSES.includes(status as any)) {
        res.status(400).json({ error: `status is required and must be one of: ${RESULT_STATUSES.join(', ')}` });
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
      };
```

- [ ] **Step 2: Build API to verify full compilation**

Run: `cd packages/api && npx tsc --noEmit`
Expected: All API files compile with no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/results.ts
git commit -m "feat(api): require job_id in POST /results"
```

---

## Task 7: Update API tests — results route tests (add job_id)

**Files:**
- Modify: `packages/api/src/__tests__/routes/results.test.ts`

- [ ] **Step 1: Add job_id to validSubmission helper**

In `packages/api/src/__tests__/routes/results.test.ts`, update the `validSubmission()` helper:

```typescript
// BEFORE:
function validSubmission() {
  return {
    task_id: 'task-123',
    status: 'success',
    exit_code: 0,
    stdout: 'output text',
    stderr: '',
  };
}

// AFTER:
function validSubmission() {
  return {
    job_id: 'job-456',
    task_id: 'task-123',
    status: 'success',
    exit_code: 0,
    stdout: 'output text',
    stderr: '',
  };
}
```

- [ ] **Step 2: Update assertions to include job_id**

In the `'returns 201 with generated result_id and completed_at'` test, add:
```typescript
    expect(res.body.job_id).toBe('job-456');
```

In the `'publishes to results exchange'` test, add `job_id: 'job-456'` to the `expect.objectContaining()` matcher.

- [ ] **Step 3: Add test for missing job_id**

Add a new test:
```typescript
  it('returns 400 when job_id missing', async () => {
    const app = buildApp();
    const { job_id, ...noJobId } = validSubmission();
    const res = await request(app).post('/results').send(noJobId);
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 4: Update existing 400 tests to include job_id in payloads**

The `'returns 400 when task_id missing'` and `'returns 400 when status missing/invalid'` tests send payloads without `job_id`. Update them to include `job_id` so they test only the intended validation:

```typescript
  it('returns 400 when task_id missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send({ job_id: 'job-456', status: 'success', exit_code: 0, stdout: '', stderr: '' });
    expect(res.status).toBe(400);
  });
```

Note: The `'returns 400 when status missing'` and `'returns 400 when status is invalid value'` tests should also include `job_id` in their payloads. Since `job_id` is validated first, without it these tests would fail on `job_id` validation before reaching `status` validation.

- [ ] **Step 5: Run API tests to verify**

Run: `cd packages/api && npx vitest run`
Expected: All results route tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/__tests__/routes/results.test.ts
git commit -m "test(api): update results route tests to require job_id"
```

---

## Task 8: Refactor task-daemon — change Task to Job

**Files:**
- Modify: `packages/task-daemon/src/ports/task-executor.ts:1-5`
- Modify: `packages/task-daemon/src/adapters/claude-cli-executor.ts:1-57`
- Modify: `packages/task-daemon/src/adapters/ttadk-executor.ts:1-57`
- Modify: `packages/task-daemon/src/core/task-orchestrator.ts:1-28`
- Modify: `packages/task-daemon/src/task-poller.ts:1-90`

- [ ] **Step 1: Update TaskExecutor port interface**

In `packages/task-daemon/src/ports/task-executor.ts`, replace entire file:

```typescript
import { Job, TaskResultSubmission } from '@local-agent/shared';

export interface TaskExecutor {
  execute(job: Job): Promise<TaskResultSubmission>;
}
```

- [ ] **Step 2: Update ClaudeCliExecutor — change Task to Job**

In `packages/task-daemon/src/adapters/claude-cli-executor.ts`, replace lines 1-3:

```typescript
// BEFORE:
import { execFile } from 'node:child_process';
import { Task, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';

// AFTER:
import { execFile } from 'node:child_process';
import { Job, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';
```

Then replace every occurrence of `(task: Task)` with `(job: Job)`, and every `task.` reference with `job.`:

```typescript
export class ClaudeCliExecutor implements TaskExecutor {
  async execute(job: Job): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning Claude Code');

    if (!job.payload) {
      logger.error({ job_id: job.job_id }, 'Job payload is missing or empty — skipping');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Job payload is missing or empty',
      };
    }

    return new Promise((resolve) => {
      execFile(
        'claude',
        ['--dangerously-skip-permissions', '--model', job.executor_model, '-p', job.payload],
        { maxBuffer: 50 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const execErr = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            logger.error(
              { job_id: job.job_id, exit_code: execErr.code, stdout: execErr.stdout, stderr: execErr.stderr },
              'Claude Code failed',
            );

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              status: 'failure',
              exit_code: typeof execErr.code === 'number' ? execErr.code : null,
              stdout: truncate(execErr.stdout ?? '', MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(execErr.stderr ?? '', MAX_RESULT_OUTPUT_BYTES),
            });
          } else {
            logger.info({ job_id: job.job_id, stdout, stderr }, 'Claude Code completed');

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              status: 'success',
              exit_code: 0,
              stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
            });
          }
        },
      );
    });
  }
}
```

- [ ] **Step 3: Update TTADKExecutor — same pattern as ClaudeCliExecutor**

In `packages/task-daemon/src/adapters/ttadk-executor.ts`, apply the same Task→Job rename pattern:
- Import `Job` instead of `Task`
- Change `(task: Task)` to `(job: Job)`
- Change all `task.` references to `job.`
- Change `task_id: task.task_id` to `job_id: job.job_id, task_id: job.task_id` in all result objects
- Change log fields from `task_id: task.task_id` to `job_id: job.job_id, task_id: job.task_id`

- [ ] **Step 4: Update TaskOrchestrator — change Task to Job**

In `packages/task-daemon/src/core/task-orchestrator.ts`, replace entire file:

```typescript
import { Job, TaskResultSubmission, createLogger } from '@local-agent/shared';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';
import { TTADKExecutor } from '../adapters/ttadk-executor';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('task-daemon:orchestrator');

export class TaskOrchestrator {
  async handle(job: Job): Promise<TaskResultSubmission> {
    logger.info(
      { job_id: job.job_id, task_id: job.task_id, task_type: job.task_type, executor: job.executor },
      'Processing job',
    );

    let executor: TaskExecutor;

    if (job.executor === 'claude_code') {
      executor = new ClaudeCliExecutor();
    } else if (job.executor === 'ttadk') {
      executor = new TTADKExecutor();
    } else {
      logger.error({ job_id: job.job_id, executor: job.executor }, 'Unknown job executor — refusing to ack');
      throw new Error(`Unknown job executor: ${job.executor}`);
    }

    return executor.execute(job);
  }
}
```

- [ ] **Step 5: Update TaskPoller — poll /jobs/next, ACK /jobs/:id/ack**

In `packages/task-daemon/src/task-poller.ts`, replace entire file:

```typescript
import { Job, TaskResultSubmission, createLogger } from '@local-agent/shared';
import { TaskOrchestrator } from './core/task-orchestrator';

const logger = createLogger('task-daemon:poller');

export class TaskPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly apiUrl: string,
    private readonly orchestrator: TaskOrchestrator,
  ) {}

  async pollOnce(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/jobs/next`);

      if (res.status === 204) {
        logger.debug('No jobs available');
        return;
      }

      if (res.status !== 200) {
        logger.warn({ status: res.status }, 'Unexpected response from API');
        return;
      }

      const job = (await res.json()) as Job;
      logger.info({ job_id: job.job_id, task_id: job.task_id }, 'Received job');

      let result: TaskResultSubmission;
      try {
        result = await this.orchestrator.handle(job);
      } catch (err) {
        logger.error({ job_id: job.job_id, err }, 'Orchestrator error — not acking');
        return;
      }

      // Publish result to API (best-effort)
      try {
        const resultRes = await fetch(`${this.apiUrl}/results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        });
        if (resultRes.status !== 201) {
          logger.warn({ job_id: job.job_id, status: resultRes.status }, 'Result publish failed');
        }
      } catch (resultErr) {
        logger.error({ job_id: job.job_id, err: resultErr }, 'Result publish request failed');
      }

      // ACK the job
      try {
        const ackRes = await fetch(`${this.apiUrl}/jobs/${job.job_id}/ack`, { method: 'POST' });
        if (ackRes.status !== 200) {
          logger.warn({ job_id: job.job_id, status: ackRes.status }, 'ACK failed');
        } else {
          logger.info({ job_id: job.job_id }, 'Job acknowledged');
        }
      } catch (ackErr) {
        logger.error({ job_id: job.job_id, err: ackErr }, 'ACK request failed');
      }
    } catch (err) {
      logger.error({ err }, 'Poll error');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs }, 'Starting task poller');
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
      logger.info('Task poller stopped');
    }
  }
}
```

- [ ] **Step 6: Build task-daemon to verify compilation**

Run: `cd packages/task-daemon && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/task-daemon/src/
git commit -m "refactor(task-daemon): consume jobs instead of tasks"
```

---

## Task 9: Update task-daemon tests

**Files:**
- Modify: `packages/task-daemon/src/adapters/__tests__/claude-cli-executor.test.ts`
- Modify: `packages/task-daemon/src/adapters/__tests__/ttadk-executor.test.ts`
- Modify: `packages/task-daemon/src/core/__tests__/task-orchestrator.test.ts`
- Modify: `packages/task-daemon/src/__tests__/task-poller.test.ts`

- [ ] **Step 1: Update claude-cli-executor test — change Task→Job helper**

In `packages/task-daemon/src/adapters/__tests__/claude-cli-executor.test.ts`:

Replace line 3:
```typescript
// BEFORE:
import { Task } from '@local-agent/shared';
// AFTER:
import { Job } from '@local-agent/shared';
```

Replace lines 14-24 (createTask helper):
```typescript
// BEFORE:
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

// AFTER:
function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'claude_code',
    executor_model: 'opus',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    ...overrides,
  };
}
```

Then rename all `createTask()` calls to `createJob()` throughout the file.

Update assertions that check `result.task_id` to also check `result.job_id`:
- `expect(result.job_id).toBe('job-456');` alongside existing `expect(result.task_id).toBe('test-123');`

Update the empty payload test assertion to match the new error message:
- Change `expect(result.stderr).toBe('Task payload is missing or empty')` to `expect(result.stderr).toBe('Job payload is missing or empty')`

- [ ] **Step 2: Update ttadk-executor test — same pattern**

Apply the same Task→Job changes to `packages/task-daemon/src/adapters/__tests__/ttadk-executor.test.ts`.

Also update the empty payload test assertion:
- Change `expect(result.stderr).toBe('Task payload is missing or empty')` to `expect(result.stderr).toBe('Job payload is missing or empty')`

- [ ] **Step 3: Update task-orchestrator test — change Task→Job**

In `packages/task-daemon/src/core/__tests__/task-orchestrator.test.ts`:
- Import `Job` instead of `Task`
- Update `createTask` helper to `createJob` with added `job_id` and `enriched_at` fields
- Rename all `createTask()` calls to `createJob()`
- Add `job_id: 'job-456'` to `mockResultSubmission`
- Update the error assertion from `'Unknown task executor: invalid'` to `'Unknown job executor: invalid'`

- [ ] **Step 4: Update task-poller test — change Task→Job, update endpoints**

In `packages/task-daemon/src/__tests__/task-poller.test.ts`:

Replace line 2:
```typescript
// BEFORE:
import { Task, TaskResultSubmission } from '@local-agent/shared';
// AFTER:
import { Job, TaskResultSubmission } from '@local-agent/shared';
```

Replace mockResultSubmission (lines 6-12):
```typescript
const mockResultSubmission: TaskResultSubmission = {
  job_id: 'job-456',
  task_id: 'abc-123',
  status: 'success',
  exit_code: 0,
  stdout: 'result output',
  stderr: '',
};
```

Replace createTask helper (lines 25-35):
```typescript
function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'abc-123',
    task_type: 'generic',
    payload: 'hello',
    executor: 'claude_code',
    executor_model: 'opus',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    ...overrides,
  };
}
```

Update all test cases:
- Replace `createTask()` with `createJob()`
- Replace `'http://localhost:3000/tasks/next'` with `'http://localhost:3000/jobs/next'`
- Replace `'http://localhost:3000/tasks/abc-123/ack'` with `'http://localhost:3000/jobs/job-456/ack'` (in all 3 tests that assert the ACK URL: 'fetches task, executes...', 'still acks task even if result POST fails', and 'still acks task even if result POST throws')

- [ ] **Step 5: Run all task-daemon tests**

Run: `cd packages/task-daemon && npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/task-daemon/src/__tests__/ packages/task-daemon/src/adapters/__tests__/ packages/task-daemon/src/core/__tests__/
git commit -m "test(task-daemon): update tests for Job type and /jobs endpoints"
```

---

## Task 10: Update lark-result-daemon

**Files:**
- Modify: `packages/lark-result-daemon/src/lark-poller.ts:31`
- Modify: `packages/lark-result-daemon/src/adapters/lark-notifier.ts:54-58`

- [ ] **Step 1: Update LarkPoller — log job_id**

In `packages/lark-result-daemon/src/lark-poller.ts`, replace line 31:

```typescript
// BEFORE:
      logger.info({ result_id: result.result_id, task_id: result.task_id }, 'Received result');

// AFTER:
      logger.info({ result_id: result.result_id, job_id: result.job_id, task_id: result.task_id }, 'Received result');
```

- [ ] **Step 2: Update LarkNotifier — include job_id in notification text**

In `packages/lark-result-daemon/src/adapters/lark-notifier.ts`, replace lines 54-58:

```typescript
// BEFORE:
    const text = [
      `Task ${result.task_id} — ${result.status}`,
      `Exit code: ${result.exit_code ?? 'N/A'}`,
      snippet ? `Output:\n${snippet}` : 'No output',
    ].join('\n');

// AFTER:
    const text = [
      `Job ${result.job_id} (Task ${result.task_id}) — ${result.status}`,
      `Exit code: ${result.exit_code ?? 'N/A'}`,
      snippet ? `Output:\n${snippet}` : 'No output',
    ].join('\n');
```

- [ ] **Step 3: Build lark-result-daemon to verify compilation**

Run: `cd packages/lark-result-daemon && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/lark-result-daemon/src/
git commit -m "feat(lark-result-daemon): include job_id in result logs and notifications"
```

---

## Task 11: Update CLI — remove executor/model from submit command

**Files:**
- Modify: `packages/cli/src/commands/submit.ts`
- Modify: `packages/cli/src/__tests__/submit.test.ts`

- [ ] **Step 1: Simplify submit.ts — remove executor/model**

In `packages/cli/src/commands/submit.ts`, update the imports:

```typescript
// BEFORE:
import {
  DEFAULT_API_URL,
  TASK_EXECUTOR_OPTIONS,
  type TaskExecutorType,
  type TaskSubmission,
  isTaskExecutorType,
  isValidExecutorModel,
  getExecutorModelOptions,
} from '@local-agent/shared';

// AFTER:
import {
  DEFAULT_API_URL,
  type TaskSubmission,
} from '@local-agent/shared';
```

Update `SubmitOptions` to remove `executor` and `model`:

```typescript
// BEFORE:
export interface SubmitOptions {
  payload: string;
  type: string;
  executor: TaskExecutorType;
  model: string;
  apiUrl: string;
}

// AFTER:
export interface SubmitOptions {
  payload: string;
  type: string;
  apiUrl: string;
}
```

Remove the `assertValidExecutor` and `assertValidExecutorModel` functions entirely.

Update `submitTask` to remove executor/model validation and body fields:

```typescript
// BEFORE:
export async function submitTask(options: SubmitOptions): Promise<SubmitResult> {
  assertValidExecutor(options.executor);
  assertValidExecutorModel(options.executor, options.model);

  const url = `${options.apiUrl.replace(/\/+$/, '')}/tasks`;
  const body: TaskSubmission = {
    task_type: options.type,
    payload: options.payload,
    executor: options.executor,
    executor_model: options.model,
  };

// AFTER:
export async function submitTask(options: SubmitOptions): Promise<SubmitResult> {
  const url = `${options.apiUrl.replace(/\/+$/, '')}/tasks`;
  const body: TaskSubmission = {
    task_type: options.type,
    payload: options.payload,
  };
```

Update `registerSubmitCommand` to remove the `--executor` and `--model` options:

```typescript
// BEFORE:
    .requiredOption('-e, --executor <claude_code|ttadk>', 'Task executor')
    .requiredOption('-m, --model <string>', 'Executor model')
    .option('-u, --api-url <string>', 'API base URL')
    .action(async (opts: { payload: string; type: string; executor: TaskExecutorType; model: string; apiUrl?: string }) => {
      const apiUrl = opts.apiUrl ?? process.env.API_URL ?? DEFAULT_API_URL;

      const result = await submit({
        payload: opts.payload,
        type: opts.type,
        executor: opts.executor,
        model: opts.model,
        apiUrl,
      });

// AFTER:
    .option('-u, --api-url <string>', 'API base URL')
    .action(async (opts: { payload: string; type: string; apiUrl?: string }) => {
      const apiUrl = opts.apiUrl ?? process.env.API_URL ?? DEFAULT_API_URL;

      const result = await submit({
        payload: opts.payload,
        type: opts.type,
        apiUrl,
      });
```

- [ ] **Step 2: Update submit tests — remove executor/model**

In `packages/cli/src/__tests__/submit.test.ts`:

- Remove `executor` and `model` from all `submitTask()` call options
- Remove `executor` and `executor_model` from all expected request body assertions
- Remove tests that specifically test executor/model validation (`'rejects unsupported executor values before submit'`, `'rejects invalid model for executor before submit'`)
- Remove `executor` and `model` from all `program.parseAsync` call options
- Update all test call sites to match the simplified `SubmitOptions` interface

- [ ] **Step 3: Build and test CLI package**

Run: `cd packages/cli && npx tsc --noEmit && npx vitest run`
Expected: Compilation succeeds and all remaining tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/submit.ts packages/cli/src/__tests__/submit.test.ts
git commit -m "feat(cli): simplify submit command to only send task_type and payload"
```

---

## Task 12: Create task-enrichment-daemon — package scaffold

**Files:**
- Create: `packages/task-enrichment-daemon/package.json`
- Create: `packages/task-enrichment-daemon/tsconfig.json`
- Create: `packages/task-enrichment-daemon/vitest.config.ts`
- Create: `packages/task-enrichment-daemon/config/enrichment.yaml`
- Modify: `rush.json:9-30`

- [ ] **Step 1: Create package.json**

Create `packages/task-enrichment-daemon/package.json`:

```json
{
  "name": "@local-agent/task-enrichment-daemon",
  "version": "0.0.1",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "@local-agent/shared": "workspace:*",
    "dotenv": "~16.4.7",
    "js-yaml": "~4.1.0"
  },
  "devDependencies": {
    "@types/js-yaml": "~4.0.9",
    "typescript": "~5.7.0",
    "vitest": "~1.6.0",
    "rimraf": "~5.0.0",
    "ts-node": "~10.9.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/task-enrichment-daemon/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

Create `packages/task-enrichment-daemon/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: './src',
  },
});
```

- [ ] **Step 4: Create default enrichment config**

Create `packages/task-enrichment-daemon/config/enrichment.yaml`:

```yaml
rules:
  default:
    executor: claude_code
    executor_model: sonnet
```

- [ ] **Step 5: Add project to rush.json**

In `rush.json`, add after the lark-result-daemon entry (line 24-27):

```json
    {
      "packageName": "@local-agent/task-enrichment-daemon",
      "projectFolder": "packages/task-enrichment-daemon"
    },
```

- [ ] **Step 6: Run rush update to install dependencies**

Run: `rush update`
Expected: Installs js-yaml and @types/js-yaml.

- [ ] **Step 7: Commit**

```bash
git add packages/task-enrichment-daemon/package.json packages/task-enrichment-daemon/tsconfig.json packages/task-enrichment-daemon/vitest.config.ts packages/task-enrichment-daemon/config/enrichment.yaml rush.json common/
git commit -m "feat(task-enrichment-daemon): scaffold package with config"
```

---

## Task 13: Create enrichment service — write test first

**Files:**
- Create: `packages/task-enrichment-daemon/src/__tests__/enrichment-service.test.ts`
- Create: `packages/task-enrichment-daemon/src/enrichment-service.ts`

- [ ] **Step 1: Write the enrichment service test**

Create `packages/task-enrichment-daemon/src/__tests__/enrichment-service.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { Task } from '@local-agent/shared';
import { EnrichmentService } from '../enrichment-service';

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this code',
    submitted_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('EnrichmentService', () => {
  describe('with rules including default', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          code_review: { executor: 'claude_code', executor_model: 'opus' },
          quick_question: { executor: 'claude_code', executor_model: 'haiku' },
          default: { executor: 'claude_code', executor_model: 'sonnet' },
        },
      });
    });

    it('enriches a task with a matching rule', () => {
      const result = service.enrich(createTask({ task_type: 'code_review' }));

      expect(result).not.toBeNull();
      expect(result!.task_id).toBe('task-123');
      expect(result!.task_type).toBe('code_review');
      expect(result!.payload).toBe('Review this code');
      expect(result!.executor).toBe('claude_code');
      expect(result!.executor_model).toBe('opus');
      expect(result!.submitted_at).toBe('2026-03-29T00:00:00.000Z');
    });

    it('falls back to default for unknown task_type', () => {
      const result = service.enrich(createTask({ task_type: 'unknown_type' }));

      expect(result).not.toBeNull();
      expect(result!.executor).toBe('claude_code');
      expect(result!.executor_model).toBe('sonnet');
    });

    it('returns all required JobSubmission fields', () => {
      const result = service.enrich(createTask());

      expect(result).toHaveProperty('task_id');
      expect(result).toHaveProperty('task_type');
      expect(result).toHaveProperty('payload');
      expect(result).toHaveProperty('executor');
      expect(result).toHaveProperty('executor_model');
      expect(result).toHaveProperty('submitted_at');
    });
  });

  describe('with no default rule', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          code_review: { executor: 'claude_code', executor_model: 'opus' },
        },
      });
    });

    it('returns null for unknown task_type when no default exists', () => {
      const result = service.enrich(createTask({ task_type: 'unknown_type' }));
      expect(result).toBeNull();
    });

    it('still enriches known task_types', () => {
      const result = service.enrich(createTask({ task_type: 'code_review' }));
      expect(result).not.toBeNull();
      expect(result!.executor).toBe('claude_code');
    });
  });

  describe('validation', () => {
    it('returns null for invalid executor', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          bad_rule: { executor: 'nonexistent', executor_model: 'opus' },
        },
      });

      const result = service.enrich(createTask({ task_type: 'bad_rule' }));
      expect(result).toBeNull();
    });

    it('returns null for invalid executor_model', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          bad_model: { executor: 'claude_code', executor_model: 'nonexistent' },
        },
      });

      const result = service.enrich(createTask({ task_type: 'bad_model' }));
      expect(result).toBeNull();
    });
  });

  describe('fromFile', () => {
    it('loads config from a YAML file', () => {
      const configPath = new URL('../../config/enrichment.yaml', import.meta.url).pathname;
      const service = EnrichmentService.fromFile(configPath);
      const result = service.enrich(createTask({ task_type: 'anything' }));

      expect(result).not.toBeNull();
      expect(result!.executor).toBe('claude_code');
      expect(result!.executor_model).toBe('sonnet');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/task-enrichment-daemon && npx vitest run`
Expected: FAIL — `EnrichmentService` module not found.

- [ ] **Step 3: Write the EnrichmentService implementation**

Create `packages/task-enrichment-daemon/src/enrichment-service.ts`:

```typescript
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { Task, JobSubmission, isTaskExecutorType, isValidExecutorModel, TaskExecutorType, createLogger } from '@local-agent/shared';

const logger = createLogger('enrichment-daemon:service');

interface EnrichmentRule {
  executor: string;
  executor_model: string;
}

interface EnrichmentConfig {
  rules: Record<string, EnrichmentRule>;
}

export class EnrichmentService {
  private constructor(private readonly rules: Record<string, EnrichmentRule>) {}

  static fromFile(filePath: string): EnrichmentService {
    const content = readFileSync(filePath, 'utf-8');
    const config = yaml.load(content) as EnrichmentConfig;
    return new EnrichmentService(config.rules);
  }

  static fromObject(config: EnrichmentConfig): EnrichmentService {
    return new EnrichmentService(config.rules);
  }

  enrich(task: Task): JobSubmission | null {
    const rule = this.rules[task.task_type] ?? this.rules['default'];

    if (!rule) {
      logger.error({ task_id: task.task_id, task_type: task.task_type }, 'No enrichment rule found and no default — rejecting task');
      return null;
    }

    if (!isTaskExecutorType(rule.executor)) {
      logger.error({ task_id: task.task_id, executor: rule.executor }, 'Invalid executor in enrichment rule — rejecting task');
      return null;
    }

    if (!isValidExecutorModel(rule.executor as TaskExecutorType, rule.executor_model)) {
      logger.error({ task_id: task.task_id, executor: rule.executor, model: rule.executor_model }, 'Invalid executor_model in enrichment rule — rejecting task');
      return null;
    }

    return {
      task_id: task.task_id,
      task_type: task.task_type,
      payload: task.payload,
      executor: rule.executor as TaskExecutorType,
      executor_model: rule.executor_model,
      submitted_at: task.submitted_at,
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/task-enrichment-daemon && npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/task-enrichment-daemon/src/enrichment-service.ts packages/task-enrichment-daemon/src/__tests__/enrichment-service.test.ts
git commit -m "feat(task-enrichment-daemon): add EnrichmentService with YAML config loading"
```

---

## Task 14: Create enrichment poller — write test first

**Files:**
- Create: `packages/task-enrichment-daemon/src/__tests__/enrichment-poller.test.ts`
- Create: `packages/task-enrichment-daemon/src/enrichment-poller.ts`

- [ ] **Step 1: Write the enrichment poller test**

Create `packages/task-enrichment-daemon/src/__tests__/enrichment-poller.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Task, JobSubmission } from '@local-agent/shared';
import { EnrichmentService } from '../enrichment-service';

const mockEnrich = vi.fn();

vi.mock('../enrichment-service', () => ({
  EnrichmentService: vi.fn().mockImplementation(() => ({
    enrich: mockEnrich,
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this',
    submitted_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

function createJobSubmission(overrides?: Partial<JobSubmission>): JobSubmission {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this',
    executor: 'claude_code',
    executor_model: 'opus',
    submitted_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

import { EnrichmentPoller } from '../enrichment-poller';

describe('EnrichmentPoller', () => {
  let poller: EnrichmentPoller;

  beforeEach(() => {
    vi.clearAllMocks();
    const service = new EnrichmentService() as any;
    poller = new EnrichmentPoller('http://localhost:3000', service);
  });

  afterEach(() => {
    poller.stop();
  });

  it('fetches task, enriches, posts job, then acks task', async () => {
    const task = createTask();
    const jobSubmission = createJobSubmission();
    mockEnrich.mockReturnValue(jobSubmission);

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      })
      .mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve({ job_id: 'job-456', ...jobSubmission }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ acknowledged: true }),
      });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/tasks/next');
    expect(mockEnrich).toHaveBeenCalledWith(task);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jobSubmission),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('does nothing when queue is empty (204)', async () => {
    mockFetch.mockResolvedValueOnce({ status: 204 });
    await poller.pollOnce();
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it('acks task and does not post job when enrichment fails (returns null)', async () => {
    const task = createTask();
    mockEnrich.mockReturnValue(null);

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

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('does not ack task when POST /jobs fails', async () => {
    const task = createTask();
    const jobSubmission = createJobSubmission();
    mockEnrich.mockReturnValue(jobSubmission);

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      })
      .mockResolvedValueOnce({
        status: 500,
      });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // No ack call — only 2 fetches (get task + failed post job)
  });

  it('handles fetch errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    await expect(poller.pollOnce()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/task-enrichment-daemon && npx vitest run`
Expected: FAIL — `EnrichmentPoller` module not found.

- [ ] **Step 3: Write the EnrichmentPoller implementation**

Create `packages/task-enrichment-daemon/src/enrichment-poller.ts`:

```typescript
import { Task, createLogger } from '@local-agent/shared';
import { EnrichmentService } from './enrichment-service';

const logger = createLogger('enrichment-daemon:poller');

export class EnrichmentPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly apiUrl: string,
    private readonly enrichmentService: EnrichmentService,
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
      logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Received task for enrichment');

      const jobSubmission = this.enrichmentService.enrich(task);

      if (!jobSubmission) {
        logger.warn({ task_id: task.task_id, task_type: task.task_type }, 'Enrichment failed — acking task');
        await this.ackTask(task.task_id);
        return;
      }

      // Publish enriched job
      try {
        const jobRes = await fetch(`${this.apiUrl}/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(jobSubmission),
        });
        if (jobRes.status !== 201) {
          logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed — not acking task');
          return;
        }
      } catch (jobErr) {
        logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed — not acking task');
        return;
      }

      await this.ackTask(task.task_id);
    } catch (err) {
      logger.error({ err }, 'Enrichment poll error');
    }
  }

  private async ackTask(taskId: string): Promise<void> {
    try {
      const ackRes = await fetch(`${this.apiUrl}/tasks/${taskId}/ack`, { method: 'POST' });
      if (ackRes.status !== 200) {
        logger.warn({ task_id: taskId, status: ackRes.status }, 'Task ACK failed');
      } else {
        logger.info({ task_id: taskId }, 'Task acknowledged');
      }
    } catch (ackErr) {
      logger.error({ task_id: taskId, err: ackErr }, 'Task ACK request failed');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs }, 'Starting enrichment poller');
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
      logger.info('Enrichment poller stopped');
    }
  }
}
```

- [ ] **Step 4: Run all enrichment daemon tests**

Run: `cd packages/task-enrichment-daemon && npx vitest run`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/task-enrichment-daemon/src/enrichment-poller.ts packages/task-enrichment-daemon/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(task-enrichment-daemon): add EnrichmentPoller with test"
```

---

## Task 15: Create enrichment daemon — config and entry point

**Files:**
- Create: `packages/task-enrichment-daemon/src/config.ts`
- Create: `packages/task-enrichment-daemon/src/index.ts`

- [ ] **Step 1: Create config.ts**

Create `packages/task-enrichment-daemon/src/config.ts`:

```typescript
import dotenv from 'dotenv';
import { resolve } from 'node:path';
import {
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
} from '@local-agent/shared';

dotenv.config();

export interface EnrichmentDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  enrichmentConfigPath: string;
}

const DEFAULT_ENRICHMENT_CONFIG_PATH = resolve(__dirname, '../config/enrichment.yaml');

export function loadEnrichmentDaemonConfig(env: Record<string, string | undefined> = process.env): EnrichmentDaemonConfig {
  return {
    apiUrl: env.API_URL ?? DEFAULT_API_URL,
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    enrichmentConfigPath: env.ENRICHMENT_CONFIG_PATH ?? DEFAULT_ENRICHMENT_CONFIG_PATH,
  };
}
```

- [ ] **Step 2: Create index.ts entry point**

Create `packages/task-enrichment-daemon/src/index.ts`:

```typescript
import { createLogger } from '@local-agent/shared';
import { loadEnrichmentDaemonConfig } from './config';
import { EnrichmentService } from './enrichment-service';
import { EnrichmentPoller } from './enrichment-poller';

const logger = createLogger('enrichment-daemon');

function main() {
  const config = loadEnrichmentDaemonConfig();
  logger.info({ config }, 'Starting enrichment daemon');

  const enrichmentService = EnrichmentService.fromFile(config.enrichmentConfigPath);
  logger.info({ configPath: config.enrichmentConfigPath }, 'Loaded enrichment config');

  const poller = new EnrichmentPoller(config.apiUrl, enrichmentService);
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down enrichment daemon');
    poller.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
```

- [ ] **Step 3: Build enrichment daemon to verify compilation**

Run: `cd packages/task-enrichment-daemon && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/task-enrichment-daemon/src/config.ts packages/task-enrichment-daemon/src/index.ts
git commit -m "feat(task-enrichment-daemon): add config loading and entry point"
```

---

## Task 16: Create Dockerfile and update docker-compose

**Files:**
- Create: `packages/task-enrichment-daemon/Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Create Dockerfile**

Create `packages/task-enrichment-daemon/Dockerfile`:

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/task-daemon/package.json packages/task-daemon/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/lark-result-daemon/package.json packages/lark-result-daemon/package.json
COPY packages/task-enrichment-daemon/package.json packages/task-enrichment-daemon/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/task-enrichment-daemon

COPY packages/shared/ packages/shared/
COPY packages/task-enrichment-daemon/ packages/task-enrichment-daemon/

RUN cd packages/shared && npx tsc
RUN cd packages/task-enrichment-daemon && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/task-enrichment-daemon/package.json packages/task-enrichment-daemon/package.json
COPY --from=builder /app/packages/task-enrichment-daemon/dist/ packages/task-enrichment-daemon/dist/
COPY --from=builder /app/packages/task-enrichment-daemon/config/ packages/task-enrichment-daemon/config/
COPY --from=builder /app/packages/task-enrichment-daemon/node_modules/ packages/task-enrichment-daemon/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/task-enrichment-daemon

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Add task-enrichment-daemon service to docker-compose.yml**

In `docker-compose.yml`, add after the lark-result-daemon service (after line 69):

```yaml

  task-enrichment-daemon:
    build:
      context: .
      dockerfile: packages/task-enrichment-daemon/Dockerfile
    environment:
      API_URL: http://api:3000
      POLL_INTERVAL_MS: "5000"
      LOG_LEVEL: info
    depends_on:
      rabbitmq:
        condition: service_healthy
      api:
        condition: service_started
    profiles:
      - task-enrichment-daemon
      - full
```

- [ ] **Step 3: Commit**

```bash
git add packages/task-enrichment-daemon/Dockerfile docker-compose.yml
git commit -m "feat(task-enrichment-daemon): add Dockerfile and docker-compose service"
```

---

## Task 17: Full build and test verification

- [ ] **Step 1: Build all packages**

Run: `rush build`
Expected: All packages compile successfully.

- [ ] **Step 2: Run all tests across the monorepo**

Run: `cd packages/shared && npx vitest run && cd ../api && npx vitest run && cd ../task-daemon && npx vitest run && cd ../task-enrichment-daemon && npx vitest run && cd ../cli && npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Verify type correctness with strict compilation**

Run: `cd packages/shared && npx tsc --noEmit && cd ../api && npx tsc --noEmit && cd ../task-daemon && npx tsc --noEmit && cd ../task-enrichment-daemon && npx tsc --noEmit && cd ../lark-result-daemon && npx tsc --noEmit && cd ../cli && npx tsc --noEmit`
Expected: No type errors in any package.

- [ ] **Step 4: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: resolve build and test issues from task-job refactor"
```
