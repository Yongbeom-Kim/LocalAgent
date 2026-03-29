# Result Reporting and Lark Notification Implementation Plan

**Goal:** After task execution, capture results (stdout/stderr/exit_code) and publish them to a RabbitMQ fanout exchange via the API, then consume them with a new lark-daemon that sends Lark Bot API notifications.

**Architecture:** Task-daemon executors return `TaskResultSubmission` instead of void. The task-poller POSTs results to a new `POST /results` API endpoint, which publishes to a `results` fanout exchange. A `lark-messages` queue is bound to that exchange. A new lark-daemon polls `GET /results/next/lark-messages`, sends Lark Bot API notifications, and ACKs. The current daemon is renamed to task-daemon.

**Tech Stack:** TypeScript, Vitest, Express, RabbitMQ (amqplib), Lark Bot API (fetch)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Add `TaskResultSubmission`, `TaskResult` interfaces, `MAX_RESULT_OUTPUT_BYTES` |
| `packages/shared/src/truncate.ts` | Create | `truncate(str, maxBytes)` utility |
| `packages/shared/src/constants.ts` | Modify | Add `DEFAULT_RESULTS_EXCHANGE_NAME`, `DEFAULT_LARK_QUEUE_NAME`, `DEFAULT_LARK_MAX_RETRIES` |
| `packages/shared/src/config.ts` | Modify | Add `LarkDaemonConfig`, `loadLarkDaemonConfig()` |
| `packages/shared/src/index.ts` | Modify | Re-export new symbols |
| `packages/shared/src/__tests__/truncate.test.ts` | Create | Unit tests for truncate |
| `packages/shared/src/__tests__/config.test.ts` | Modify | Tests for `loadLarkDaemonConfig` |
| `packages/api/src/services/rabbitmq.ts` | Modify | Add exchange/queue topology, `publishToExchange()`, `getNextFromQueue()`, `ackFromQueue()` |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Modify | Tests for new RabbitMQ methods |
| `packages/api/src/routes/results.ts` | Create | `POST /results`, `GET /results/next/:queueName`, `POST /results/:queueName/:id/ack` |
| `packages/api/src/__tests__/routes/results.test.ts` | Create | Tests for results routes |
| `packages/api/src/app.ts` | Modify | Mount results router |
| `packages/daemon/src/ports/task-executor.ts` | Modify | Return `TaskResultSubmission` instead of `void` |
| `packages/daemon/src/adapters/claude-cli-executor.ts` | Modify | Return `TaskResultSubmission` |
| `packages/daemon/src/adapters/ttadk-executor.ts` | Modify | Return `TaskResultSubmission` |
| `packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts` | Modify | Assert `TaskResultSubmission` return values |
| `packages/daemon/src/adapters/__tests__/ttadk-executor.test.ts` | Modify | Assert `TaskResultSubmission` return values |
| `packages/daemon/src/core/task-orchestrator.ts` | Modify | Return `TaskResultSubmission` from `handle()` |
| `packages/daemon/src/core/__tests__/task-orchestrator.test.ts` | Modify | Assert return values |
| `packages/daemon/src/poller.ts` → `task-poller.ts` | Rename+Modify | Add result POST, rename logger |
| `packages/daemon/src/__tests__/poller.test.ts` → `task-poller.test.ts` | Rename+Modify | Test result POST step |
| `packages/daemon/src/index.ts` → `task-daemon.ts` | Rename+Modify | Rename entry point, update imports/logger |
| `packages/daemon/src/adapters/lark-notifier.ts` | Create | Lark Bot API client with retry |
| `packages/daemon/src/adapters/__tests__/lark-notifier.test.ts` | Create | Tests for Lark notifier |
| `packages/daemon/src/lark-poller.ts` | Create | Poll result queue, send notification, ACK |
| `packages/daemon/src/__tests__/lark-poller.test.ts` | Create | Tests for lark poller |
| `packages/daemon/src/lark-daemon.ts` | Create | Lark daemon entry point |
| `packages/daemon/package.json` | Modify | Update main, scripts for task-daemon + lark-daemon |
| `docker-compose.yml` | Modify | No daemon service exists yet, no changes needed |

---

### Task 1: Shared types — `TaskResultSubmission`, `TaskResult`, `MAX_RESULT_OUTPUT_BYTES`

**Files:**
- Modify: `packages/shared/src/types.ts:38-45`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add types and constant to `types.ts`**

Append after the existing `Task` interface (after line 45):

```ts
// packages/shared/src/types.ts — append at end

export const RESULT_STATUSES = ['success', 'failure'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const MAX_RESULT_OUTPUT_BYTES = 100 * 1024; // 100KB

export interface TaskResultSubmission {
  task_id: string;
  status: ResultStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

export interface TaskResult extends TaskResultSubmission {
  result_id: string;
  completed_at: string;
}
```

- [ ] **Step 2: Re-export from `index.ts`**

Add to the existing export block in `packages/shared/src/index.ts`:

```ts
export {
  // ... existing exports ...
  type TaskResultSubmission,
  type TaskResult,
  type ResultStatus,
  RESULT_STATUSES,
  MAX_RESULT_OUTPUT_BYTES,
} from './types';
```

- [ ] **Step 3: Run shared tests to confirm no regressions**

Run: `cd packages/shared && npx vitest run`
Expected: All existing tests pass. No new tests yet for these types (they're just interfaces/constants).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts
git commit -m "feat(shared): add TaskResultSubmission and TaskResult types"
```

---

### Task 2: Shared utility — `truncate()`

**Files:**
- Create: `packages/shared/src/truncate.ts`
- Create: `packages/shared/src/__tests__/truncate.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write failing tests for `truncate`**

```ts
// packages/shared/src/__tests__/truncate.test.ts
import { describe, it, expect } from 'vitest';
import { truncate } from '../truncate';

describe('truncate', () => {
  it('returns string unchanged when shorter than maxBytes', () => {
    expect(truncate('hello', 100)).toBe('hello');
  });

  it('returns empty string unchanged', () => {
    expect(truncate('', 100)).toBe('');
  });

  it('truncates string exceeding maxBytes', () => {
    const long = 'a'.repeat(200);
    const result = truncate(long, 100);
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(100);
  });

  it('handles multi-byte characters without splitting mid-character', () => {
    // Each emoji is 4 bytes in UTF-8
    const emojis = '😀'.repeat(30); // 120 bytes
    const result = truncate(emojis, 100);
    // Should not produce invalid UTF-8
    expect(Buffer.from(result, 'utf-8').toString('utf-8')).toBe(result);
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(100);
  });

  it('returns full string when exactly at maxBytes', () => {
    const exact = 'a'.repeat(100);
    expect(truncate(exact, 100)).toBe(exact);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/__tests__/truncate.test.ts`
Expected: FAIL — `truncate` module not found.

- [ ] **Step 3: Implement `truncate`**

```ts
// packages/shared/src/truncate.ts
export function truncate(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;
  // Slice to maxBytes, then decode — Buffer.toString handles partial multi-byte gracefully
  const sliced = buf.subarray(0, maxBytes);
  // Re-encode to string; Node drops incomplete multi-byte chars at the boundary
  return sliced.toString('utf-8').replace(/\uFFFD$/, '');
}
```

- [ ] **Step 4: Re-export from `index.ts`**

Add to `packages/shared/src/index.ts`:

```ts
export { truncate } from './truncate';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/__tests__/truncate.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/truncate.ts packages/shared/src/__tests__/truncate.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add truncate utility for byte-bounded string truncation"
```

---

### Task 3: Shared constants and config — `LarkDaemonConfig`

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/__tests__/config.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add constants to `constants.ts`**

Append to `packages/shared/src/constants.ts`:

```ts
export const DEFAULT_RESULTS_EXCHANGE_NAME = 'results';
export const DEFAULT_LARK_QUEUE_NAME = 'lark-messages';
export const DEFAULT_LARK_MAX_RETRIES = 3;
```

- [ ] **Step 2: Write failing test for `loadLarkDaemonConfig`**

Append to `packages/shared/src/__tests__/config.test.ts`:

```ts
import { loadLarkDaemonConfig } from '../config';

describe('loadLarkDaemonConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadLarkDaemonConfig({});
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
    expect(config.larkAppId).toBe('');
    expect(config.larkAppSecret).toBe('');
    expect(config.larkRecipientId).toBe('');
  });

  it('reads from env vars', () => {
    const config = loadLarkDaemonConfig({
      API_URL: 'http://other:4000',
      POLL_INTERVAL_MS: '2000',
      LOG_LEVEL: 'debug',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      LARK_RECIPIENT_ID: 'user789',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.logLevel).toBe('debug');
    expect(config.larkAppId).toBe('app123');
    expect(config.larkAppSecret).toBe('secret456');
    expect(config.larkRecipientId).toBe('user789');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/__tests__/config.test.ts`
Expected: FAIL — `loadLarkDaemonConfig` not exported.

- [ ] **Step 4: Implement `LarkDaemonConfig` and loader in `config.ts`**

Add to `packages/shared/src/config.ts` after the existing `loadDaemonConfig`:

```ts
export interface LarkDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  larkAppId: string;
  larkAppSecret: string;
  larkRecipientId: string;
}

export function loadLarkDaemonConfig(env: Record<string, string | undefined> = process.env): LarkDaemonConfig {
  return {
    apiUrl: env.API_URL ?? DEFAULT_API_URL,
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    larkAppId: env.LARK_APP_ID ?? '',
    larkAppSecret: env.LARK_APP_SECRET ?? '',
    larkRecipientId: env.LARK_RECIPIENT_ID ?? '',
  };
}
```

- [ ] **Step 5: Re-export new symbols from `index.ts`**

Add to `packages/shared/src/index.ts`:

```ts
export { loadLarkDaemonConfig, LarkDaemonConfig } from './config';
export {
  DEFAULT_RESULTS_EXCHANGE_NAME,
  DEFAULT_LARK_QUEUE_NAME,
  DEFAULT_LARK_MAX_RETRIES,
} from './constants';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/shared && npx vitest run`
Expected: All tests PASS including the 2 new `loadLarkDaemonConfig` tests.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/config.ts packages/shared/src/__tests__/config.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add LarkDaemonConfig and result queue constants"
```

---

### Task 4: RabbitMQ service — exchange topology and new methods

**Files:**
- Modify: `packages/api/src/services/rabbitmq.ts`
- Modify: `packages/api/src/__tests__/services/rabbitmq.test.ts`

- [ ] **Step 1: Write failing tests for new RabbitMQ methods**

Add to `packages/api/src/__tests__/services/rabbitmq.test.ts`. The mock needs to be updated first — add `assertExchange`, `bindQueue`, and `publish` to the mock channel:

Update the mock at the top of the file — add these to `mockCh`:

```ts
assertExchange: vi.fn().mockResolvedValue({}),
bindQueue: vi.fn().mockResolvedValue({}),
publish: vi.fn().mockReturnValue(true),
```

Then add new describe blocks:

```ts
describe('connect — exchange topology', () => {
  it('asserts results fanout exchange and lark-messages queue with binding', async () => {
    await service.connect();
    expect(channel.assertExchange).toHaveBeenCalledWith('results', 'fanout', { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith('lark-messages', { durable: true });
    expect(channel.bindQueue).toHaveBeenCalledWith('lark-messages', 'results', '');
  });
});

describe('publishToExchange', () => {
  it('publishes persistent message to named exchange', async () => {
    await service.connect();
    const msg = {
      result_id: 'res-1',
      task_id: 'task-123',
      status: 'success' as const,
      exit_code: 0,
      stdout: 'output',
      stderr: '',
      completed_at: '2026-03-27T00:00:00.000Z',
    };
    const result = service.publishToExchange('results', msg);
    expect(result).toBe(true);
    expect(channel.publish).toHaveBeenCalledWith(
      'results',
      '',
      Buffer.from(JSON.stringify(msg)),
      { persistent: true },
    );
  });

  it('throws when not connected', () => {
    expect(() => service.publishToExchange('results', {} as any)).toThrow('Not connected');
  });
});

describe('getNextFromQueue', () => {
  it('returns null when queue is empty', async () => {
    await service.connect();
    channel.get.mockResolvedValue(false);
    const result = await service.getNextFromQueue('lark-messages');
    expect(result).toBeNull();
    expect(channel.get).toHaveBeenCalledWith('lark-messages', { noAck: false });
  });

  it('returns result when message available', async () => {
    await service.connect();
    const content = JSON.stringify({
      result_id: 'res-1',
      task_id: 'task-123',
      status: 'success',
      exit_code: 0,
      stdout: 'output',
      stderr: '',
      completed_at: '2026-03-27T00:00:00.000Z',
    });
    channel.get.mockResolvedValue({
      content: Buffer.from(content),
      fields: { deliveryTag: 99 },
    });
    const result = await service.getNextFromQueue('lark-messages');
    expect(result).toEqual(JSON.parse(content));
  });
});

describe('ackFromQueue', () => {
  it('acknowledges result by result_id and queue name', async () => {
    await service.connect();
    const msg = {
      content: Buffer.from(JSON.stringify({
        result_id: 'res-1',
        task_id: 'task-123',
        status: 'success',
        exit_code: 0,
        stdout: 'output',
        stderr: '',
        completed_at: '2026-03-27T00:00:00.000Z',
      })),
      fields: { deliveryTag: 99 },
    };
    channel.get.mockResolvedValue(msg);
    await service.getNextFromQueue('lark-messages');
    const acked = service.ackFromQueue('lark-messages', 'res-1');
    expect(acked).toBe(true);
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('returns false for unknown result_id', async () => {
    await service.connect();
    const acked = service.ackFromQueue('lark-messages', 'unknown');
    expect(acked).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/api && npx vitest run src/__tests__/services/rabbitmq.test.ts`
Expected: FAIL — `publishToExchange`, `getNextFromQueue`, `ackFromQueue` don't exist.

- [ ] **Step 3: Implement changes in `rabbitmq.ts`**

Update `packages/api/src/services/rabbitmq.ts`:

```ts
import amqplib from 'amqplib';
import {
  Task,
  TaskResult,
  createLogger,
  DEFAULT_RESULTS_EXCHANGE_NAME,
  DEFAULT_LARK_QUEUE_NAME,
} from '@local-agent/shared';

interface GetMessage {
  content: Buffer;
  fields: { deliveryTag: number };
}

const logger = createLogger('api:rabbitmq');

export class RabbitMQService {
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private deliveryMap = new Map<string, GetMessage>();
  private queueDeliveryMaps = new Map<string, Map<string, GetMessage>>();

  constructor(
    private readonly url: string,
    private readonly queueName: string,
  ) {}

  async connect(): Promise<void> {
    const conn = await amqplib.connect(this.url);
    conn.on('error', () => {
      this.connection = null;
      this.channel = null;
    });
    conn.on('close', () => {
      this.connection = null;
      this.channel = null;
    });
    this.connection = conn;
    const ch = await conn.createChannel();
    await ch.assertQueue(this.queueName, { durable: true });

    // Results exchange topology
    await ch.assertExchange(DEFAULT_RESULTS_EXCHANGE_NAME, 'fanout', { durable: true });
    await ch.assertQueue(DEFAULT_LARK_QUEUE_NAME, { durable: true });
    await ch.bindQueue(DEFAULT_LARK_QUEUE_NAME, DEFAULT_RESULTS_EXCHANGE_NAME, '');

    this.channel = ch;
  }

  async close(): Promise<void> {
    await this.connection?.close();
    this.connection = null;
    this.channel = null;
  }

  publish(message: Task): boolean {
    if (!this.channel) throw new Error('Not connected');
    const buffer = Buffer.from(JSON.stringify(message));
    return this.channel.sendToQueue(this.queueName, buffer, { persistent: true });
  }

  publishToExchange(exchange: string, message: TaskResult): boolean {
    if (!this.channel) throw new Error('Not connected');
    const buffer = Buffer.from(JSON.stringify(message));
    return this.channel.publish(exchange, '', buffer, { persistent: true });
  }

  async getNext(): Promise<Task | null> {
    if (!this.channel) throw new Error('Not connected');
    const msg = await this.channel.get(this.queueName, { noAck: false });
    if (msg === false) return null;

    const parsed = JSON.parse(msg.content.toString()) as Task;

    if (this.deliveryMap.has(parsed.task_id)) {
      logger.error(
        { task_id: parsed.task_id, deliveryTag: msg.fields.deliveryTag },
        'Duplicate task_id received while an earlier delivery is still outstanding; acknowledging duplicate message',
      );
      this.channel.ack(msg);
      return null;
    }

    this.deliveryMap.set(parsed.task_id, msg as unknown as GetMessage);

    return parsed;
  }

  async getNextFromQueue(queueName: string): Promise<TaskResult | null> {
    if (!this.channel) throw new Error('Not connected');
    const msg = await this.channel.get(queueName, { noAck: false });
    if (msg === false) return null;

    const parsed = JSON.parse(msg.content.toString()) as TaskResult;

    let deliveryMap = this.queueDeliveryMaps.get(queueName);
    if (!deliveryMap) {
      deliveryMap = new Map();
      this.queueDeliveryMaps.set(queueName, deliveryMap);
    }

    if (deliveryMap.has(parsed.result_id)) {
      logger.error(
        { result_id: parsed.result_id, deliveryTag: msg.fields.deliveryTag },
        'Duplicate result_id received; acknowledging duplicate message',
      );
      this.channel.ack(msg);
      return null;
    }

    deliveryMap.set(parsed.result_id, msg as unknown as GetMessage);

    return parsed;
  }

  ack(taskId: string): boolean {
    if (!this.channel) return false;
    const delivery = this.deliveryMap.get(taskId);
    if (!delivery) return false;
    this.channel.ack(delivery as any);
    this.deliveryMap.delete(taskId);
    return true;
  }

  ackFromQueue(queueName: string, resultId: string): boolean {
    if (!this.channel) return false;
    const deliveryMap = this.queueDeliveryMaps.get(queueName);
    if (!deliveryMap) return false;
    const delivery = deliveryMap.get(resultId);
    if (!delivery) return false;
    this.channel.ack(delivery as any);
    deliveryMap.delete(resultId);
    return true;
  }

  isConnected(): boolean {
    return this.connection !== null && this.channel !== null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run src/__tests__/services/rabbitmq.test.ts`
Expected: All tests PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/rabbitmq.ts packages/api/src/__tests__/services/rabbitmq.test.ts
git commit -m "feat(api): add results exchange topology and queue-specific get/ack methods"
```

---

### Task 5: API routes — results router

**Files:**
- Create: `packages/api/src/routes/results.ts`
- Create: `packages/api/src/__tests__/routes/results.test.ts`
- Modify: `packages/api/src/app.ts`

- [ ] **Step 1: Write failing tests for results routes**

```ts
// packages/api/src/__tests__/routes/results.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createResultRoutes } from '../../routes/results';

const mockRabbitMQ = {
  publishToExchange: vi.fn().mockReturnValue(true),
  getNextFromQueue: vi.fn(),
  ackFromQueue: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/results', createResultRoutes(mockRabbitMQ as any));
  return app;
}

function validSubmission() {
  return {
    task_id: 'task-123',
    status: 'success',
    exit_code: 0,
    stdout: 'output text',
    stderr: '',
  };
}

describe('POST /results', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 201 with generated result_id and completed_at', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send(validSubmission());
    expect(res.status).toBe(201);
    expect(res.body.result_id).toBeDefined();
    expect(res.body.completed_at).toBeDefined();
    expect(res.body.task_id).toBe('task-123');
    expect(res.body.status).toBe('success');
    expect(res.body.exit_code).toBe(0);
    expect(res.body.stdout).toBe('output text');
    expect(res.body.stderr).toBe('');
  });

  it('publishes to results exchange', async () => {
    const app = buildApp();
    await request(app).post('/results').send(validSubmission());
    expect(mockRabbitMQ.publishToExchange).toHaveBeenCalledWith(
      'results',
      expect.objectContaining({
        result_id: expect.any(String),
        task_id: 'task-123',
        status: 'success',
      }),
    );
  });

  it('returns 400 when task_id missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send({ status: 'success', exit_code: 0, stdout: '', stderr: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when status missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send({ task_id: 'task-123', exit_code: 0, stdout: '', stderr: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when status is invalid value', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send({ ...validSubmission(), status: 'pending' });
    expect(res.status).toBe(400);
  });

  it('returns 503 when exchange publish applies backpressure', async () => {
    mockRabbitMQ.publishToExchange.mockReturnValueOnce(false);
    const app = buildApp();
    const res = await request(app).post('/results').send(validSubmission());
    expect(res.status).toBe(503);
  });
});

describe('GET /results/next/:queueName', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with result when available', async () => {
    mockRabbitMQ.getNextFromQueue.mockResolvedValue({
      result_id: 'res-1',
      task_id: 'task-123',
      status: 'success',
      exit_code: 0,
      stdout: 'output',
      stderr: '',
      completed_at: '2026-03-27T00:00:00.000Z',
    });
    const app = buildApp();
    const res = await request(app).get('/results/next/lark-messages');
    expect(res.status).toBe(200);
    expect(res.body.result_id).toBe('res-1');
    expect(mockRabbitMQ.getNextFromQueue).toHaveBeenCalledWith('lark-messages');
  });

  it('returns 204 when queue is empty', async () => {
    mockRabbitMQ.getNextFromQueue.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app).get('/results/next/lark-messages');
    expect(res.status).toBe(204);
  });
});

describe('POST /results/:queueName/:id/ack', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 when ACK succeeds', async () => {
    mockRabbitMQ.ackFromQueue.mockReturnValue(true);
    const app = buildApp();
    const res = await request(app).post('/results/lark-messages/res-1/ack');
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
    expect(mockRabbitMQ.ackFromQueue).toHaveBeenCalledWith('lark-messages', 'res-1');
  });

  it('returns 404 when result ID unknown', async () => {
    mockRabbitMQ.ackFromQueue.mockReturnValue(false);
    const app = buildApp();
    const res = await request(app).post('/results/lark-messages/unknown/ack');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/api && npx vitest run src/__tests__/routes/results.test.ts`
Expected: FAIL — `createResultRoutes` module not found.

- [ ] **Step 3: Implement `results.ts` route**

```ts
// packages/api/src/routes/results.ts
import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { TaskResult, RESULT_STATUSES, DEFAULT_RESULTS_EXCHANGE_NAME } from '@local-agent/shared';
import { RabbitMQService } from '../services/rabbitmq';

export function createResultRoutes(rabbitmq: RabbitMQService): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
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

      const buffered = rabbitmq.publishToExchange(DEFAULT_RESULTS_EXCHANGE_NAME, result);

      if (!buffered) {
        res.status(503).json({ error: 'Server busy, try again later' });
        return;
      }

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/next/:queueName', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await rabbitmq.getNextFromQueue(req.params.queueName);
      if (!result) {
        res.status(204).send();
        return;
      }
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:queueName/:id/ack', (req: Request, res: Response, next: NextFunction) => {
    try {
      const acked = rabbitmq.ackFromQueue(req.params.queueName, req.params.id);
      if (!acked) {
        res.status(404).json({ error: 'Result not found or already acknowledged' });
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

- [ ] **Step 4: Mount results router in `app.ts`**

Update `packages/api/src/app.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/api && npx vitest run`
Expected: All tests PASS (existing tasks tests + new results tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/results.ts packages/api/src/__tests__/routes/results.test.ts packages/api/src/app.ts
git commit -m "feat(api): add results routes for publishing, polling, and acknowledging task results"
```

---

### Task 6: Executor port — change return type to `TaskResultSubmission`

**Files:**
- Modify: `packages/daemon/src/ports/task-executor.ts`

- [ ] **Step 1: Update the interface**

Replace the contents of `packages/daemon/src/ports/task-executor.ts`:

```ts
import { Task, TaskResultSubmission } from '@local-agent/shared';

export interface TaskExecutor {
  execute(task: Task): Promise<TaskResultSubmission>;
}
```

- [ ] **Step 2: Verify the build shows type errors in executors (expected)**

Run: `cd packages/daemon && npx tsc --noEmit 2>&1 | head -20`
Expected: Type errors in `claude-cli-executor.ts` and `ttadk-executor.ts` because they still return `Promise<void>`.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/ports/task-executor.ts
git commit -m "feat(daemon): change TaskExecutor port to return TaskResultSubmission"
```

---

### Task 7: Claude CLI executor — return `TaskResultSubmission`

**Files:**
- Modify: `packages/daemon/src/adapters/claude-cli-executor.ts`
- Modify: `packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts`

- [ ] **Step 1: Update tests to assert return values**

Replace `packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { Task } from '@local-agent/shared';

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
    executor: 'claude_code',
    executor_model: 'opus',
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

  it('returns success result with stdout and stderr on successful execution', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'The answer is 4', 'some warning');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(result.task_id).toBe('test-123');
    expect(result.status).toBe('success');
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('The answer is 4');
    expect(result.stderr).toBe('some warning');
  });

  it('returns failure result when claude exits with non-zero code', async () => {
    const error = Object.assign(new Error('Process exited with code 1'), {
      code: 1,
      stdout: 'partial output',
      stderr: 'something went wrong',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(result.task_id).toBe('test-123');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toBe('partial output');
    expect(result.stderr).toBe('something went wrong');
  });

  it('returns failure result with null exit_code when claude binary is not found', async () => {
    const error = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
      stdout: '',
      stderr: '',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(result.task_id).toBe('test-123');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('');
  });

  it('returns failure result when payload is empty', async () => {
    const result = await executor.execute(createTask({ payload: '' }));

    expect(result.task_id).toBe('test-123');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('Task payload is missing or empty');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('spawns claude with correct arguments', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    await executor.execute(createTask());

    expect(mockExecFile).toHaveBeenCalledWith(
      'claude',
      ['--dangerously-skip-permissions', '--model', 'opus', '-p', 'What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024 },
      expect.any(Function),
    );
  });

  it('truncates stdout and stderr to MAX_RESULT_OUTPUT_BYTES', async () => {
    const largeOutput = 'x'.repeat(200 * 1024); // 200KB
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, largeOutput, largeOutput);
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
    expect(Buffer.byteLength(result.stderr, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: FAIL — executor still returns void/undefined.

- [ ] **Step 3: Update `claude-cli-executor.ts`**

```ts
// packages/daemon/src/adapters/claude-cli-executor.ts
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Task, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger } from '@local-agent/shared';
import { truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('task-daemon:claude-cli');
const execFileAsync = promisify(execFile);

export class ClaudeCliExecutor implements TaskExecutor {
  async execute(task: Task): Promise<TaskResultSubmission> {
    logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Spawning Claude Code');

    if (!task.payload) {
      logger.error({ task_id: task.task_id }, 'Task payload is missing or empty — skipping');
      return {
        task_id: task.task_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Task payload is missing or empty',
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        'claude',
        ['--dangerously-skip-permissions', '--model', task.executor_model, '-p', task.payload],
        {
          maxBuffer: 50 * 1024 * 1024,
        },
      );

      logger.info(
        { task_id: task.task_id, stdout, stderr },
        'Claude Code completed',
      );

      return {
        task_id: task.task_id,
        status: 'success',
        exit_code: 0,
        stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
        stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
      };
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

      return {
        task_id: task.task_id,
        status: 'failure',
        exit_code: typeof execErr.code === 'number' ? execErr.code : null,
        stdout: truncate(execErr.stdout ?? '', MAX_RESULT_OUTPUT_BYTES),
        stderr: truncate(execErr.stderr ?? '', MAX_RESULT_OUTPUT_BYTES),
      };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/adapters/claude-cli-executor.ts packages/daemon/src/adapters/__tests__/claude-cli-executor.test.ts
git commit -m "feat(daemon): ClaudeCliExecutor returns TaskResultSubmission"
```

---

### Task 8: TTADK executor — return `TaskResultSubmission`

**Files:**
- Modify: `packages/daemon/src/adapters/ttadk-executor.ts`
- Modify: `packages/daemon/src/adapters/__tests__/ttadk-executor.test.ts`

- [ ] **Step 1: Update tests to assert return values**

Follow the exact same pattern as Task 7 but for `TTADKExecutor`. The test file structure mirrors `claude-cli-executor.test.ts` — update assertions from `resolves.toBeUndefined()` to checking `TaskResultSubmission` fields. Replace `packages/daemon/src/adapters/__tests__/ttadk-executor.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { Task } from '@local-agent/shared';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { TTADKExecutor } from '../ttadk-executor';
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'test-456',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'ttadk',
    executor_model: 'gpt-5.4',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

describe('TTADKExecutor', () => {
  let executor: TTADKExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new TTADKExecutor();
  });

  it('returns success result with stdout and stderr on successful execution', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'The answer is 4', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(result.task_id).toBe('test-456');
    expect(result.status).toBe('success');
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('The answer is 4');
    expect(result.stderr).toBe('');
  });

  it('returns failure result when ttadk exits with non-zero code', async () => {
    const error = Object.assign(new Error('Process exited with code 1'), {
      code: 1,
      stdout: 'partial',
      stderr: 'error output',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(result.task_id).toBe('test-456');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toBe('partial');
    expect(result.stderr).toBe('error output');
  });

  it('returns failure result with null exit_code when ttadk binary not found', async () => {
    const error = Object.assign(new Error('spawn ttadk ENOENT'), {
      code: 'ENOENT',
      stdout: '',
      stderr: '',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
  });

  it('returns failure result when payload is empty', async () => {
    const result = await executor.execute(createTask({ payload: '' }));

    expect(result.task_id).toBe('test-456');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('Task payload is missing or empty');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('spawns ttadk with correct arguments', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    await executor.execute(createTask());

    expect(mockExecFile).toHaveBeenCalledWith(
      'ttadk',
      ['code', '-t', 'claude', '-m', 'gpt-5.4', '-a', `--dangerously-skip-permissions -p What is 2+2?`],
      { maxBuffer: 50 * 1024 * 1024 },
      expect.any(Function),
    );
  });

  it('truncates stdout and stderr to MAX_RESULT_OUTPUT_BYTES', async () => {
    const largeOutput = 'x'.repeat(200 * 1024);
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, largeOutput, largeOutput);
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
    expect(Buffer.byteLength(result.stderr, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/ttadk-executor.test.ts`
Expected: FAIL — executor still returns void/undefined.

- [ ] **Step 3: Update `ttadk-executor.ts`**

```ts
// packages/daemon/src/adapters/ttadk-executor.ts
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Task, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger } from '@local-agent/shared';
import { truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('task-daemon:ttadk');
const execFileAsync = promisify(execFile);

export class TTADKExecutor implements TaskExecutor {
  async execute(task: Task): Promise<TaskResultSubmission> {
    logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Spawning TTADK');

    if (!task.payload) {
      logger.error({ task_id: task.task_id }, 'Task payload is missing or empty — skipping');
      return {
        task_id: task.task_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Task payload is missing or empty',
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        'ttadk',
        ['code', '-t', 'claude', '-m', task.executor_model, '-a', `--dangerously-skip-permissions -p ${task.payload}`],
        {
          maxBuffer: 50 * 1024 * 1024,
        },
      );

      logger.info({ task_id: task.task_id, stdout, stderr }, 'TTADK completed');

      return {
        task_id: task.task_id,
        status: 'success',
        exit_code: 0,
        stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
        stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
      };
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

      return {
        task_id: task.task_id,
        status: 'failure',
        exit_code: typeof execErr.code === 'number' ? execErr.code : null,
        stdout: truncate(execErr.stdout ?? '', MAX_RESULT_OUTPUT_BYTES),
        stderr: truncate(execErr.stderr ?? '', MAX_RESULT_OUTPUT_BYTES),
      };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/ttadk-executor.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/adapters/ttadk-executor.ts packages/daemon/src/adapters/__tests__/ttadk-executor.test.ts
git commit -m "feat(daemon): TTADKExecutor returns TaskResultSubmission"
```

---

### Task 9: Task orchestrator — return `TaskResultSubmission`

**Files:**
- Modify: `packages/daemon/src/core/task-orchestrator.ts`
- Modify: `packages/daemon/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Update orchestrator tests to check return values**

Update `packages/daemon/src/core/__tests__/task-orchestrator.test.ts`. Change mock return values from `undefined` to `TaskResultSubmission` objects, and assert return values:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Task, TaskResultSubmission } from '@local-agent/shared';

const mockResultSubmission: TaskResultSubmission = {
  task_id: 'test-123',
  status: 'success',
  exit_code: 0,
  stdout: 'output',
  stderr: '',
};

const mockClaudeExecute = vi.fn().mockResolvedValue(mockResultSubmission);
const mockTTADKExecute = vi.fn().mockResolvedValue(mockResultSubmission);

vi.mock('../../adapters/claude-cli-executor', () => ({
  ClaudeCliExecutor: vi.fn().mockImplementation(() => ({
    execute: mockClaudeExecute,
  })),
}));

vi.mock('../../adapters/ttadk-executor', () => ({
  TTADKExecutor: vi.fn().mockImplementation(() => ({
    execute: mockTTADKExecute,
  })),
}));

import { ClaudeCliExecutor } from '../../adapters/claude-cli-executor';
import { TTADKExecutor } from '../../adapters/ttadk-executor';
import { TaskOrchestrator } from '../task-orchestrator';

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

describe('TaskOrchestrator', () => {
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaudeExecute.mockResolvedValue(mockResultSubmission);
    mockTTADKExecute.mockResolvedValue(mockResultSubmission);
    orchestrator = new TaskOrchestrator();
  });

  it('returns TaskResultSubmission from Claude executor for claude_code tasks', async () => {
    const task = createTask({ executor: 'claude_code' });

    const result = await orchestrator.handle(task);

    expect(ClaudeCliExecutor).toHaveBeenCalledTimes(1);
    expect(TTADKExecutor).not.toHaveBeenCalled();
    expect(mockClaudeExecute).toHaveBeenCalledWith(task);
    expect(result).toEqual(mockResultSubmission);
  });

  it('returns TaskResultSubmission from TTADK executor for ttadk tasks', async () => {
    const task = createTask({ executor: 'ttadk' });

    const result = await orchestrator.handle(task);

    expect(TTADKExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    expect(mockTTADKExecute).toHaveBeenCalledWith(task);
    expect(result).toEqual(mockResultSubmission);
  });

  it('rejects invalid executor values without constructing adapters', async () => {
    const task = createTask({ executor: 'invalid' as never });

    await expect(orchestrator.handle(task)).rejects.toThrow('Unknown task executor: invalid');

    expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    expect(TTADKExecutor).not.toHaveBeenCalled();
  });

  it('propagates unexpected executor rejections so ack does not happen', async () => {
    mockClaudeExecute.mockRejectedValue(new Error('boom'));

    await expect(orchestrator.handle(createTask({ executor: 'claude_code' }))).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Update `task-orchestrator.ts`**

```ts
// packages/daemon/src/core/task-orchestrator.ts
import { Task, TaskResultSubmission, createLogger } from '@local-agent/shared';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';
import { TTADKExecutor } from '../adapters/ttadk-executor';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('task-daemon:orchestrator');

export class TaskOrchestrator {
  async handle(task: Task): Promise<TaskResultSubmission> {
    logger.info(
      { task_id: task.task_id, task_type: task.task_type, executor: task.executor },
      'Processing task',
    );

    let executor: TaskExecutor;

    if (task.executor === 'claude_code') {
      executor = new ClaudeCliExecutor();
    } else if (task.executor === 'ttadk') {
      executor = new TTADKExecutor();
    } else {
      logger.error({ task_id: task.task_id, executor: task.executor }, 'Unknown task executor — refusing to ack');
      throw new Error(`Unknown task executor: ${task.executor}`);
    }

    return executor.execute(task);
  }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/core/task-orchestrator.ts packages/daemon/src/core/__tests__/task-orchestrator.test.ts
git commit -m "feat(daemon): TaskOrchestrator returns TaskResultSubmission from handle()"
```

---

### Task 10: Rename daemon — poller → task-poller, add result POST

**Files:**
- Rename: `packages/daemon/src/poller.ts` → `packages/daemon/src/task-poller.ts`
- Rename: `packages/daemon/src/__tests__/poller.test.ts` → `packages/daemon/src/__tests__/task-poller.test.ts`

- [ ] **Step 1: Rename files**

```bash
cd /home/yongbeom_kim/.ows/workspaces/personal-productivity/LocalAgent
git mv packages/daemon/src/poller.ts packages/daemon/src/task-poller.ts
git mv packages/daemon/src/__tests__/poller.test.ts packages/daemon/src/__tests__/task-poller.test.ts
```

- [ ] **Step 2: Write updated tests for task-poller with result POST step**

Replace `packages/daemon/src/__tests__/task-poller.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Task, TaskResultSubmission } from '@local-agent/shared';
import { TaskOrchestrator } from '../core/task-orchestrator';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';

const mockResultSubmission: TaskResultSubmission = {
  task_id: 'abc-123',
  status: 'success',
  exit_code: 0,
  stdout: 'result output',
  stderr: '',
};

const mockClaudeExecute = vi.fn().mockResolvedValue(mockResultSubmission);

vi.mock('../adapters/claude-cli-executor', () => ({
  ClaudeCliExecutor: vi.fn().mockImplementation(() => ({
    execute: mockClaudeExecute,
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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

// Import after mocks are set up
import { TaskPoller } from '../task-poller';

describe('TaskPoller', () => {
  let poller: TaskPoller;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaudeExecute.mockResolvedValue(mockResultSubmission);
    poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator());
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches task, executes, posts result, then acks', async () => {
      const task = createTask();

      mockFetch
        // GET /tasks/next
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(task),
        })
        // POST /results
        .mockResolvedValueOnce({
          status: 201,
          json: () => Promise.resolve({ result_id: 'res-1' }),
        })
        // POST /tasks/:id/ack
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      // Verify order: fetch task, post result, ack
      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/tasks/next');
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mockResultSubmission),
      });
      expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/abc-123/ack', {
        method: 'POST',
      });
    });

    it('still acks task even if result POST fails', async () => {
      const task = createTask();

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(task),
        })
        .mockResolvedValueOnce({
          status: 500,
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/abc-123/ack', {
        method: 'POST',
      });
    });

    it('still acks task even if result POST throws', async () => {
      const task = createTask();

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(task),
        })
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/abc-123/ack', {
        method: 'POST',
      });
    });

    it('does nothing when queue is empty (204)', async () => {
      mockFetch.mockResolvedValueOnce({ status: 204 });
      await poller.pollOnce();
      expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    });

    it('does not post result or ack when executor is unknown', async () => {
      const task = createTask({ executor: 'invalid' as never });

      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/daemon && npx vitest run src/__tests__/task-poller.test.ts`
Expected: FAIL — `TaskPoller` not exported from `task-poller.ts` (file was renamed but class wasn't updated yet).

- [ ] **Step 4: Implement updated `task-poller.ts`**

```ts
// packages/daemon/src/task-poller.ts
import { Task, TaskResultSubmission, createLogger } from '@local-agent/shared';
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

      let result: TaskResultSubmission;
      try {
        result = await this.orchestrator.handle(task);
      } catch (err) {
        logger.error({ task_id: task.task_id, err }, 'Orchestrator error — not acking');
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
          logger.warn({ task_id: task.task_id, status: resultRes.status }, 'Result publish failed');
        }
      } catch (resultErr) {
        logger.error({ task_id: task.task_id, err: resultErr }, 'Result publish request failed');
      }

      // ACK the task
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

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/__tests__/task-poller.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/task-poller.ts packages/daemon/src/__tests__/task-poller.test.ts
git commit -m "feat(daemon): rename Poller to TaskPoller, add result POST step after execution"
```

---

### Task 11: Rename daemon entry point — index.ts → task-daemon.ts

**Files:**
- Rename: `packages/daemon/src/index.ts` → `packages/daemon/src/task-daemon.ts`
- Modify: `packages/daemon/package.json`

- [ ] **Step 1: Rename the entry point**

```bash
cd /home/yongbeom_kim/.ows/workspaces/personal-productivity/LocalAgent
git mv packages/daemon/src/index.ts packages/daemon/src/task-daemon.ts
```

- [ ] **Step 2: Update `task-daemon.ts` imports and logger names**

```ts
// packages/daemon/src/task-daemon.ts
import { loadDaemonConfig, createLogger } from '@local-agent/shared';
import { TaskPoller } from './task-poller';
import { TaskOrchestrator } from './core/task-orchestrator';

async function main() {
  const config = loadDaemonConfig();
  const logger = createLogger('task-daemon', config.logLevel);

  logger.info({ apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs }, 'Starting task-daemon');

  const orchestrator = new TaskOrchestrator();
  const poller = new TaskPoller(config.apiUrl, orchestrator);
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down task-daemon...');
    poller.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('task-daemon');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
```

- [ ] **Step 3: Update `package.json` scripts**

Update `packages/daemon/package.json`:

```json
{
  "name": "@local-agent/daemon",
  "version": "0.0.1",
  "private": true,
  "main": "dist/task-daemon.js",
  "scripts": {
    "build": "tsc",
    "start:task-daemon": "node dist/task-daemon.js",
    "start:lark-daemon": "node dist/lark-daemon.js",
    "dev:task-daemon": "ts-node src/task-daemon.ts",
    "dev:lark-daemon": "ts-node src/lark-daemon.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "@local-agent/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "~5.7.0",
    "vitest": "~1.6.0",
    "rimraf": "~5.0.0",
    "ts-node": "~10.9.0"
  }
}
```

- [ ] **Step 4: Run all daemon tests to verify no regressions**

Run: `cd packages/daemon && npx vitest run`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/task-daemon.ts packages/daemon/package.json
git commit -m "refactor(daemon): rename entry point from index.ts to task-daemon.ts"
```

---

### Task 12: Lark notifier — adapter with retry logic

**Files:**
- Create: `packages/daemon/src/adapters/lark-notifier.ts`
- Create: `packages/daemon/src/adapters/__tests__/lark-notifier.test.ts`

- [ ] **Step 1: Write failing tests for LarkNotifier**

```ts
// packages/daemon/src/adapters/__tests__/lark-notifier.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskResult } from '@local-agent/shared';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { LarkNotifier } from '../lark-notifier';

function createResult(overrides?: Partial<TaskResult>): TaskResult {
  return {
    result_id: 'res-1',
    task_id: 'task-123',
    status: 'success',
    exit_code: 0,
    stdout: 'Task completed successfully',
    stderr: '',
    completed_at: '2026-03-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('LarkNotifier', () => {
  let notifier: LarkNotifier;

  beforeEach(() => {
    vi.clearAllMocks();
    notifier = new LarkNotifier('app-id', 'app-secret', 'user-123');
  });

  it('fetches tenant access token and sends message on success', async () => {
    mockFetch
      // Token request
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      // Send message request
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult());

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Verify token request
    expect(mockFetch).toHaveBeenNthCalledWith(1,
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: 'app-id', app_secret: 'app-secret' }),
      }),
    );
    // Verify message request has Bearer token
    expect(mockFetch).toHaveBeenNthCalledWith(2,
      'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer token-abc',
        },
      }),
    );
  });

  it('includes task_id, status, and truncated stdout in message', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult({ stdout: 'x'.repeat(3000) }));

    const sendCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    const content = JSON.parse(body.content);
    // Message text should contain task_id
    expect(content.text).toContain('task-123');
    // Message text should contain status
    expect(content.text).toContain('success');
    // Stdout should be truncated to 2000 chars
    expect(content.text.length).toBeLessThan(3000);
  });

  it('retries up to 3 times on fetch failure then resolves', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'));

    // Should not throw
    await expect(notifier.notify(createResult())).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on retry after initial failure', async () => {
    mockFetch
      // First attempt: token fails
      .mockRejectedValueOnce(new Error('Network error'))
      // Second attempt: token succeeds + message succeeds
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult());

    // 1 failed attempt + 2 successful calls (token + message)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/lark-notifier.test.ts`
Expected: FAIL — `LarkNotifier` module not found.

- [ ] **Step 3: Implement `lark-notifier.ts`**

```ts
// packages/daemon/src/adapters/lark-notifier.ts
import { TaskResult, createLogger } from '@local-agent/shared';

const logger = createLogger('lark-daemon:notifier');

const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
const LARK_MESSAGE_URL = 'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id';
const MAX_SNIPPET_CHARS = 2000;
const MAX_RETRIES = 3;

export class LarkNotifier {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly recipientId: string,
  ) {}

  async notify(result: TaskResult): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.sendNotification(result);
        return;
      } catch (err) {
        logger.warn(
          { result_id: result.result_id, attempt, err },
          'Lark notification attempt failed',
        );
        if (attempt === MAX_RETRIES) {
          logger.error(
            { result_id: result.result_id },
            `Lark notification failed after ${MAX_RETRIES} attempts — giving up`,
          );
        }
      }
    }
  }

  private async sendNotification(result: TaskResult): Promise<void> {
    // Get tenant access token
    const tokenRes = await fetch(LARK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const tokenData = await tokenRes.json() as { tenant_access_token: string; code: number };

    if (tokenData.code !== 0) {
      throw new Error(`Lark token request failed with code ${tokenData.code}`);
    }

    // Build message text
    const snippet = result.stdout.length > MAX_SNIPPET_CHARS
      ? result.stdout.substring(0, MAX_SNIPPET_CHARS)
      : result.stdout;

    const text = [
      `Task ${result.task_id} — ${result.status}`,
      `Exit code: ${result.exit_code ?? 'N/A'}`,
      snippet ? `Output:\n${snippet}` : 'No output',
    ].join('\n');

    // Send message
    const msgRes = await fetch(LARK_MESSAGE_URL, {
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
    const msgData = await msgRes.json() as { code: number };

    if (msgData.code !== 0) {
      throw new Error(`Lark message send failed with code ${msgData.code}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/adapters/__tests__/lark-notifier.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/adapters/lark-notifier.ts packages/daemon/src/adapters/__tests__/lark-notifier.test.ts
git commit -m "feat(daemon): add LarkNotifier adapter with retry logic"
```

---

### Task 13: Lark poller — polling loop for result queue

**Files:**
- Create: `packages/daemon/src/lark-poller.ts`
- Create: `packages/daemon/src/__tests__/lark-poller.test.ts`

- [ ] **Step 1: Write failing tests for LarkPoller**

```ts
// packages/daemon/src/__tests__/lark-poller.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskResult } from '@local-agent/shared';

const mockNotify = vi.fn().mockResolvedValue(undefined);

vi.mock('../adapters/lark-notifier', () => ({
  LarkNotifier: vi.fn().mockImplementation(() => ({
    notify: mockNotify,
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { LarkPoller } from '../lark-poller';
import { LarkNotifier } from '../adapters/lark-notifier';

const sampleResult: TaskResult = {
  result_id: 'res-1',
  task_id: 'task-123',
  status: 'success',
  exit_code: 0,
  stdout: 'output',
  stderr: '',
  completed_at: '2026-03-27T00:00:00.000Z',
};

describe('LarkPoller', () => {
  let poller: LarkPoller;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotify.mockResolvedValue(undefined);
    const notifier = new LarkNotifier('app-id', 'app-secret', 'user-123');
    poller = new LarkPoller('http://localhost:3000', 'lark-messages', notifier);
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches result, sends notification, then acks', async () => {
      mockFetch
        // GET /results/next/lark-messages
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(sampleResult),
        })
        // POST /results/lark-messages/res-1/ack
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/results/next/lark-messages');
      expect(mockNotify).toHaveBeenCalledWith(sampleResult);
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results/lark-messages/res-1/ack', {
        method: 'POST',
      });
    });

    it('does nothing when queue is empty (204)', async () => {
      mockFetch.mockResolvedValueOnce({ status: 204 });
      await poller.pollOnce();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('still acks result even if notification fails (best-effort)', async () => {
      mockNotify.mockResolvedValue(undefined); // notify always resolves (has internal retry)

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(sampleResult),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results/lark-messages/res-1/ack', {
        method: 'POST',
      });
    });

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon && npx vitest run src/__tests__/lark-poller.test.ts`
Expected: FAIL — `LarkPoller` module not found.

- [ ] **Step 3: Implement `lark-poller.ts`**

```ts
// packages/daemon/src/lark-poller.ts
import { TaskResult, createLogger } from '@local-agent/shared';
import { LarkNotifier } from './adapters/lark-notifier';

const logger = createLogger('lark-daemon:poller');

export class LarkPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly apiUrl: string,
    private readonly queueName: string,
    private readonly notifier: LarkNotifier,
  ) {}

  async pollOnce(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/results/next/${this.queueName}`);

      if (res.status === 204) {
        logger.debug('No results available');
        return;
      }

      if (res.status !== 200) {
        logger.warn({ status: res.status }, 'Unexpected response from API');
        return;
      }

      const result = (await res.json()) as TaskResult;
      logger.info({ result_id: result.result_id, task_id: result.task_id }, 'Received result');

      // Send notification (best-effort — notifier handles its own retries)
      await this.notifier.notify(result);

      // ACK the result
      try {
        const ackRes = await fetch(`${this.apiUrl}/results/${this.queueName}/${result.result_id}/ack`, {
          method: 'POST',
        });
        if (ackRes.status !== 200) {
          logger.warn({ result_id: result.result_id, status: ackRes.status }, 'Result ACK failed');
        } else {
          logger.info({ result_id: result.result_id }, 'Result acknowledged');
        }
      } catch (ackErr) {
        logger.error({ result_id: result.result_id, err: ackErr }, 'Result ACK request failed');
      }
    } catch (err) {
      logger.error({ err }, 'Lark poll error');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs, queueName: this.queueName }, 'Starting lark poller');
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
      logger.info('Lark poller stopped');
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon && npx vitest run src/__tests__/lark-poller.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/lark-poller.ts packages/daemon/src/__tests__/lark-poller.test.ts
git commit -m "feat(daemon): add LarkPoller for consuming results and sending notifications"
```

---

### Task 14: Lark daemon entry point

**Files:**
- Create: `packages/daemon/src/lark-daemon.ts`

- [ ] **Step 1: Create lark-daemon entry point**

```ts
// packages/daemon/src/lark-daemon.ts
import { loadLarkDaemonConfig, createLogger, DEFAULT_LARK_QUEUE_NAME } from '@local-agent/shared';
import { LarkPoller } from './lark-poller';
import { LarkNotifier } from './adapters/lark-notifier';

async function main() {
  const config = loadLarkDaemonConfig();
  const logger = createLogger('lark-daemon', config.logLevel);

  if (!config.larkAppId || !config.larkAppSecret || !config.larkRecipientId) {
    logger.fatal('LARK_APP_ID, LARK_APP_SECRET, and LARK_RECIPIENT_ID must be set');
    process.exit(1);
  }

  logger.info(
    { apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs, queueName: DEFAULT_LARK_QUEUE_NAME },
    'Starting lark-daemon',
  );

  const notifier = new LarkNotifier(config.larkAppId, config.larkAppSecret, config.larkRecipientId);
  const poller = new LarkPoller(config.apiUrl, DEFAULT_LARK_QUEUE_NAME, notifier);
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down lark-daemon...');
    poller.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('lark-daemon');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
```

- [ ] **Step 2: Verify build succeeds**

Run: `cd packages/daemon && npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Run all daemon tests to verify no regressions**

Run: `cd packages/daemon && npx vitest run`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/lark-daemon.ts
git commit -m "feat(daemon): add lark-daemon entry point"
```

---

### Task 15: Full integration verification

- [ ] **Step 1: Run all tests across all packages**

```bash
cd /home/yongbeom_kim/.ows/workspaces/personal-productivity/LocalAgent
cd packages/shared && npx vitest run && cd ../api && npx vitest run && cd ../daemon && npx vitest run
```

Expected: All tests PASS in all three packages.

- [ ] **Step 2: Verify TypeScript compilation for all packages**

```bash
cd /home/yongbeom_kim/.ows/workspaces/personal-productivity/LocalAgent
cd packages/shared && npx tsc --noEmit && cd ../api && npx tsc --noEmit && cd ../daemon && npx tsc --noEmit
```

Expected: No type errors in any package.

- [ ] **Step 3: Commit any remaining fixes**

If any issues found, fix and commit with descriptive message.
