# Task Queue System Implementation Plan

**Goal:** Build a Rush 5 / TypeScript monorepo with an HTTP API that bridges RabbitMQ, and a local daemon that polls tasks via HTTP, processes them, and ACKs.

**Architecture:** Express API wraps RabbitMQ via `channel.get()` (pull-based). Daemon polls `GET /tasks/next`, logs the task, calls `POST /tasks/:id/ack`. Docker-compose runs RabbitMQ + API; daemon runs on host.

**Tech Stack:** Rush 5 (pnpm), Node 20, TypeScript 5, Express 4, amqplib 0.10, pino 8, dotenv 16, Vitest 1, Docker

---

## File Map

```
LocalAgent/
├── rush.json                           # Rush 5 monorepo config
├── tsconfig.base.json                  # Shared TS compiler options
├── docker-compose.yml                  # RabbitMQ + API services
├── .env.example                        # Example env vars
├── .gitignore                          # Node/Rush ignores
├── packages/
│   ├── shared/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                # Re-exports all public API
│   │       ├── types.ts                # TaskSubmission, Task interfaces
│   │       ├── constants.ts            # Queue name, defaults
│   │       ├── config.ts               # Env var loader with defaults
│   │       ├── logger.ts               # Pino logger factory
│   │       └── __tests__/
│   │           └── config.test.ts      # Config loader tests
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   └── src/
│   │       ├── index.ts                # Express app bootstrap + listen
│   │       ├── app.ts                  # Express app factory (for testing)
│   │       ├── services/
│   │       │   └── rabbitmq.ts         # RabbitMQ connect, publish, get, ack
│   │       ├── routes/
│   │       │   ├── tasks.ts            # POST /tasks, GET /tasks/next, POST /tasks/:id/ack
│   │       │   └── health.ts           # GET /health
│   │       ├── middleware/
│   │       │   └── error-handler.ts    # Express error middleware
│   │       └── __tests__/
│   │           ├── routes/
│   │           │   ├── tasks.test.ts   # Task route unit tests
│   │           │   └── health.test.ts  # Health route unit tests
│   │           └── services/
│   │               └── rabbitmq.test.ts # RabbitMQ service unit tests
│   └── daemon/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts                # Entry point: start polling + shutdown
│           ├── poller.ts               # HTTP poll loop logic
│           ├── handler.ts              # Task handler (log + return)
│           └── __tests__/
│               ├── poller.test.ts      # Poller unit tests
│               └── handler.test.ts     # Handler unit tests
```

---

### Task 1: Rush Monorepo Scaffold

**Files:**
- Create: `rush.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Create `rush.json`**

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/rush/v5/rush.schema.json",
  "rushVersion": "5.172.1",
  "pnpmVersion": "9.15.4",
  "nodeSupportedVersionRange": ">=20.0.0 <21.0.0 || >=22.0.0 <23.0.0",
  "projects": [
    {
      "packageName": "@local-agent/shared",
      "projectFolder": "packages/shared"
    },
    {
      "packageName": "@local-agent/api",
      "projectFolder": "packages/api"
    },
    {
      "packageName": "@local-agent/daemon",
      "projectFolder": "packages/daemon"
    }
  ]
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "moduleResolution": "node"
  }
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
*.js.map
*.d.ts
!rush.json
.env
common/temp/
common/autoinstallers/
*.tgz
.rush/
```

- [ ] **Step 4: Create `.env.example`**

```bash
# API Configuration
PORT=3000
RABBITMQ_URL=amqp://guest:guest@localhost:5672
QUEUE_NAME=tasks
LOG_LEVEL=info

# Daemon Configuration
API_URL=http://localhost:3000
POLL_INTERVAL_MS=5000
```

- [ ] **Step 5: Commit**

```bash
git add rush.json tsconfig.base.json .gitignore .env.example
git commit -m "chore: scaffold Rush 5 monorepo with base config"
```

---

### Task 2: Shared Package — Types, Constants, Config, Logger

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/constants.ts`
- Create: `packages/shared/src/config.ts`
- Create: `packages/shared/src/logger.ts`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/vitest.config.ts`
- Test: `packages/shared/src/__tests__/config.test.ts`

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@local-agent/shared",
  "version": "0.0.1",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "dotenv": "~16.4.7",
    "pino": "~8.21.0"
  },
  "devDependencies": {
    "typescript": "~5.7.0",
    "vitest": "~1.6.0",
    "rimraf": "~5.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/shared/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: './src',
  },
});
```

- [ ] **Step 4: Create `packages/shared/src/types.ts`**

```typescript
export interface TaskSubmission {
  task_type: string;
  payload: string;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  submitted_at: string;
}
```

- [ ] **Step 5: Create `packages/shared/src/constants.ts`**

```typescript
export const DEFAULT_QUEUE_NAME = 'tasks';
export const DEFAULT_PORT = 3000;
export const DEFAULT_RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';
export const DEFAULT_API_URL = 'http://localhost:3000';
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_LOG_LEVEL = 'info';
```

- [ ] **Step 6: Create `packages/shared/src/config.ts`**

```typescript
import dotenv from 'dotenv';
import {
  DEFAULT_PORT,
  DEFAULT_RABBITMQ_URL,
  DEFAULT_QUEUE_NAME,
  DEFAULT_LOG_LEVEL,
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
} from './constants';

dotenv.config();

export interface ApiConfig {
  port: number;
  rabbitmqUrl: string;
  queueName: string;
  logLevel: string;
}

export interface DaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
}

export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return {
    port: parseInt(env.PORT ?? String(DEFAULT_PORT), 10),
    rabbitmqUrl: env.RABBITMQ_URL ?? DEFAULT_RABBITMQ_URL,
    queueName: env.QUEUE_NAME ?? DEFAULT_QUEUE_NAME,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  };
}

export function loadDaemonConfig(env: Record<string, string | undefined> = process.env): DaemonConfig {
  return {
    apiUrl: env.API_URL ?? DEFAULT_API_URL,
    pollIntervalMs: parseInt(env.POLL_INTERVAL_MS ?? String(DEFAULT_POLL_INTERVAL_MS), 10),
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  };
}
```

- [ ] **Step 7: Create `packages/shared/src/logger.ts`**

```typescript
import pino from 'pino';

export function createLogger(name: string, level: string = 'info'): pino.Logger {
  return pino({ name, level });
}
```

- [ ] **Step 8: Create `packages/shared/src/index.ts`**

```typescript
export { TaskSubmission, Task } from './types';
export { loadApiConfig, loadDaemonConfig, ApiConfig, DaemonConfig } from './config';
export { createLogger } from './logger';
export {
  DEFAULT_QUEUE_NAME,
  DEFAULT_PORT,
  DEFAULT_RABBITMQ_URL,
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
} from './constants';
```

- [ ] **Step 9: Write config tests**

Create `packages/shared/src/__tests__/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadApiConfig, loadDaemonConfig } from '../config';

describe('loadApiConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadApiConfig({});
    expect(config.port).toBe(3000);
    expect(config.rabbitmqUrl).toBe('amqp://guest:guest@localhost:5672');
    expect(config.queueName).toBe('tasks');
    expect(config.logLevel).toBe('info');
  });

  it('reads from env vars', () => {
    const config = loadApiConfig({
      PORT: '4000',
      RABBITMQ_URL: 'amqp://other:5672',
      QUEUE_NAME: 'jobs',
      LOG_LEVEL: 'debug',
    });
    expect(config.port).toBe(4000);
    expect(config.rabbitmqUrl).toBe('amqp://other:5672');
    expect(config.queueName).toBe('jobs');
    expect(config.logLevel).toBe('debug');
  });
});

describe('loadDaemonConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadDaemonConfig({});
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
  });

  it('reads from env vars', () => {
    const config = loadDaemonConfig({
      API_URL: 'http://other:4000',
      POLL_INTERVAL_MS: '1000',
      LOG_LEVEL: 'warn',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.pollIntervalMs).toBe(1000);
    expect(config.logLevel).toBe('warn');
  });
});
```

- [ ] **Step 10: Run `rush update` to install dependencies**

```bash
rush update
```

Expected: pnpm-lock.yaml generated, node_modules installed.

- [ ] **Step 11: Run shared tests**

```bash
cd packages/shared && npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 12: Build shared package**

```bash
cd packages/shared && npx tsc
```

Expected: `dist/` directory created with `.js` and `.d.ts` files.

- [ ] **Step 13: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): add types, config, logger, and constants"
```

---

### Task 3: API Package — RabbitMQ Service

**Files:**
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/vitest.config.ts`
- Create: `packages/api/src/services/rabbitmq.ts`
- Test: `packages/api/src/__tests__/services/rabbitmq.test.ts`

- [ ] **Step 1: Create `packages/api/package.json`**

```json
{
  "name": "@local-agent/api",
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
    "amqplib": "~0.10.5",
    "express": "~4.21.0",
    "uuid": "~9.0.0"
  },
  "devDependencies": {
    "@types/amqplib": "~0.10.0",
    "@types/express": "~4.17.0",
    "@types/uuid": "~9.0.0",
    "typescript": "~5.7.0",
    "vitest": "~1.6.0",
    "rimraf": "~5.0.0",
    "ts-node": "~10.9.0"
  }
}
```

- [ ] **Step 2: Create `packages/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/api/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: './src',
  },
});
```

- [ ] **Step 4: Write failing RabbitMQ service test**

Create `packages/api/src/__tests__/services/rabbitmq.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RabbitMQService } from '../../services/rabbitmq';

// Mock amqplib
const mockChannel = {
  assertQueue: vi.fn().mockResolvedValue({}),
  sendToQueue: vi.fn().mockReturnValue(true),
  get: vi.fn(),
  ack: vi.fn(),
};

const mockConnection = {
  createChannel: vi.fn().mockResolvedValue(mockChannel),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

vi.mock('amqplib', () => ({
  default: {
    connect: vi.fn().mockResolvedValue(mockConnection),
  },
}));

describe('RabbitMQService', () => {
  let service: RabbitMQService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new RabbitMQService('amqp://localhost', 'test-queue');
  });

  describe('connect', () => {
    it('connects and asserts durable queue', async () => {
      await service.connect();
      expect(mockChannel.assertQueue).toHaveBeenCalledWith('test-queue', { durable: true });
    });
  });

  describe('publish', () => {
    it('sends persistent message to queue', async () => {
      await service.connect();
      const msg = { task_type: 'generic', payload: 'test' };
      service.publish(msg);
      expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
        'test-queue',
        expect.any(Buffer),
        { persistent: true }
      );
    });
  });

  describe('getNext', () => {
    it('returns null when queue is empty', async () => {
      await service.connect();
      mockChannel.get.mockResolvedValue(false);
      const result = await service.getNext();
      expect(result).toBeNull();
    });

    it('returns task with generated ID when message available', async () => {
      await service.connect();
      const content = JSON.stringify({
        task_type: 'generic',
        payload: 'hello',
        submitted_at: '2026-03-26T00:00:00.000Z',
      });
      mockChannel.get.mockResolvedValue({
        content: Buffer.from(content),
        fields: { deliveryTag: 42 },
      });
      const result = await service.getNext();
      expect(result).not.toBeNull();
      expect(result!.task_type).toBe('generic');
      expect(result!.payload).toBe('hello');
      expect(result!.task_id).toBeDefined();
    });
  });

  describe('ack', () => {
    it('acknowledges message by task ID', async () => {
      await service.connect();
      const content = JSON.stringify({
        task_type: 'generic',
        payload: 'hello',
        submitted_at: '2026-03-26T00:00:00.000Z',
      });
      mockChannel.get.mockResolvedValue({
        content: Buffer.from(content),
        fields: { deliveryTag: 42 },
      });
      const task = await service.getNext();
      const acked = service.ack(task!.task_id);
      expect(acked).toBe(true);
      expect(mockChannel.ack).toHaveBeenCalledWith({ content: expect.any(Buffer), fields: { deliveryTag: 42 } });
    });

    it('returns false for unknown task ID', async () => {
      await service.connect();
      const acked = service.ack('unknown-id');
      expect(acked).toBe(false);
    });
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

```bash
cd packages/api && npx vitest run
```

Expected: FAIL — `RabbitMQService` not found.

- [ ] **Step 6: Implement RabbitMQ service**

Create `packages/api/src/services/rabbitmq.ts`:

```typescript
import amqplib, { Channel, Connection, ConsumeMessage } from 'amqplib';
import { v4 as uuidv4 } from 'uuid';
import { Task } from '@local-agent/shared';

interface DeliveryInfo {
  message: ConsumeMessage;
}

export class RabbitMQService {
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private deliveryMap = new Map<string, DeliveryInfo>();

  constructor(
    private readonly url: string,
    private readonly queueName: string,
  ) {}

  async connect(): Promise<void> {
    this.connection = await amqplib.connect(this.url);
    this.connection.on('error', () => {});
    this.connection.on('close', () => {});
    this.channel = await this.connection.createChannel();
    await this.channel.assertQueue(this.queueName, { durable: true });
  }

  async close(): Promise<void> {
    await this.connection?.close();
    this.connection = null;
    this.channel = null;
  }

  publish(message: { task_type: string; payload: string; submitted_at: string }): void {
    if (!this.channel) throw new Error('Not connected');
    const buffer = Buffer.from(JSON.stringify(message));
    this.channel.sendToQueue(this.queueName, buffer, { persistent: true });
  }

  async getNext(): Promise<Task | null> {
    if (!this.channel) throw new Error('Not connected');
    const msg = await this.channel.get(this.queueName, { noAck: false });
    if (msg === false) return null;

    const parsed = JSON.parse(msg.content.toString());
    const taskId = uuidv4();

    this.deliveryMap.set(taskId, { message: msg });

    return {
      task_id: taskId,
      task_type: parsed.task_type,
      payload: parsed.payload,
      submitted_at: parsed.submitted_at,
    };
  }

  ack(taskId: string): boolean {
    if (!this.channel) throw new Error('Not connected');
    const delivery = this.deliveryMap.get(taskId);
    if (!delivery) return false;
    this.channel.ack(delivery.message);
    this.deliveryMap.delete(taskId);
    return true;
  }

  isConnected(): boolean {
    return this.connection !== null && this.channel !== null;
  }
}
```

- [ ] **Step 7: Run `rush update` and run tests**

```bash
rush update
cd packages/api && npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/api/package.json packages/api/tsconfig.json packages/api/vitest.config.ts packages/api/src/services/ packages/api/src/__tests__/
git commit -m "feat(api): add RabbitMQ service with publish, get, and ack"
```

---

### Task 4: API Package — Express Routes

**Files:**
- Create: `packages/api/src/routes/tasks.ts`
- Create: `packages/api/src/routes/health.ts`
- Create: `packages/api/src/middleware/error-handler.ts`
- Create: `packages/api/src/app.ts`
- Test: `packages/api/src/__tests__/routes/tasks.test.ts`
- Test: `packages/api/src/__tests__/routes/health.test.ts`

- [ ] **Step 1: Write failing task route tests**

Create `packages/api/src/__tests__/routes/tasks.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTaskRoutes } from '../../routes/tasks';

const mockRabbitMQ = {
  publish: vi.fn(),
  getNext: vi.fn(),
  ack: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/tasks', createTaskRoutes(mockRabbitMQ as any));
  return app;
}

describe('POST /tasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 201 with submitted task', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic', payload: 'hello' });
    expect(res.status).toBe(201);
    expect(res.body.task_type).toBe('generic');
    expect(res.body.payload).toBe('hello');
    expect(res.body.submitted_at).toBeDefined();
    expect(mockRabbitMQ.publish).toHaveBeenCalled();
  });

  it('returns 400 when task_type missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ payload: 'hello' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when payload missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic' });
    expect(res.status).toBe(400);
  });
});

describe('GET /tasks/next', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with task when available', async () => {
    mockRabbitMQ.getNext.mockResolvedValue({
      task_id: 'abc-123',
      task_type: 'generic',
      payload: 'hello',
      submitted_at: '2026-03-26T00:00:00.000Z',
    });
    const app = buildApp();
    const res = await request(app).get('/tasks/next');
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe('abc-123');
  });

  it('returns 204 when queue is empty', async () => {
    mockRabbitMQ.getNext.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app).get('/tasks/next');
    expect(res.status).toBe(204);
  });
});

describe('POST /tasks/:id/ack', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 when ACK succeeds', async () => {
    mockRabbitMQ.ack.mockReturnValue(true);
    const app = buildApp();
    const res = await request(app).post('/tasks/abc-123/ack');
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
  });

  it('returns 404 when task ID unknown', async () => {
    mockRabbitMQ.ack.mockReturnValue(false);
    const app = buildApp();
    const res = await request(app).post('/tasks/unknown/ack');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Add supertest dev dependency to `packages/api/package.json`**

Add to `devDependencies`:

```json
"supertest": "~6.3.0",
"@types/supertest": "~6.0.0"
```

- [ ] **Step 3: Run test to verify it fails**

```bash
rush update && cd packages/api && npx vitest run
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Implement error handler middleware**

Create `packages/api/src/middleware/error-handler.ts`:

```typescript
import { Request, Response, NextFunction } from 'express';
import { createLogger } from '@local-agent/shared';

const logger = createLogger('api:error');

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}
```

- [ ] **Step 5: Implement task routes**

Create `packages/api/src/routes/tasks.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { RabbitMQService } from '../services/rabbitmq';

export function createTaskRoutes(rabbitmq: RabbitMQService): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const { task_type, payload } = req.body;

    if (typeof task_type !== 'string' || !task_type) {
      res.status(400).json({ error: 'task_type is required and must be a string' });
      return;
    }
    if (typeof payload !== 'string') {
      res.status(400).json({ error: 'payload is required and must be a string' });
      return;
    }

    const submitted_at = new Date().toISOString();
    rabbitmq.publish({ task_type, payload, submitted_at });

    res.status(201).json({ task_type, payload, submitted_at });
  });

  router.get('/next', async (req: Request, res: Response) => {
    const task = await rabbitmq.getNext();
    if (!task) {
      res.status(204).send();
      return;
    }
    res.status(200).json(task);
  });

  router.post('/:id/ack', (req: Request, res: Response) => {
    const acked = rabbitmq.ack(req.params.id);
    if (!acked) {
      res.status(404).json({ error: 'Task not found or already acknowledged' });
      return;
    }
    res.status(200).json({ acknowledged: true });
  });

  return router;
}
```

- [ ] **Step 6: Implement health route**

Create `packages/api/src/routes/health.ts`:

```typescript
import { Router, Request, Response } from 'express';
import { RabbitMQService } from '../services/rabbitmq';

export function createHealthRoutes(rabbitmq: RabbitMQService): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      rabbitmq: rabbitmq.isConnected() ? 'connected' : 'disconnected',
    });
  });

  return router;
}
```

- [ ] **Step 7: Write health route test**

Create `packages/api/src/__tests__/routes/health.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHealthRoutes } from '../../routes/health';

describe('GET /health', () => {
  it('returns connected status when RabbitMQ is connected', async () => {
    const mockRabbitMQ = { isConnected: vi.fn().mockReturnValue(true) };
    const app = express();
    app.use('/health', createHealthRoutes(mockRabbitMQ as any));
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.rabbitmq).toBe('connected');
  });

  it('returns disconnected status when RabbitMQ is down', async () => {
    const mockRabbitMQ = { isConnected: vi.fn().mockReturnValue(false) };
    const app = express();
    app.use('/health', createHealthRoutes(mockRabbitMQ as any));
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.rabbitmq).toBe('disconnected');
  });
});
```

- [ ] **Step 8: Create Express app factory**

Create `packages/api/src/app.ts`:

```typescript
import express from 'express';
import { createTaskRoutes } from './routes/tasks';
import { createHealthRoutes } from './routes/health';
import { errorHandler } from './middleware/error-handler';
import { RabbitMQService } from './services/rabbitmq';

export function createApp(rabbitmq: RabbitMQService): express.Application {
  const app = express();

  app.use(express.json());
  app.use('/tasks', createTaskRoutes(rabbitmq));
  app.use('/health', createHealthRoutes(rabbitmq));
  app.use(errorHandler);

  return app;
}
```

- [ ] **Step 9: Run tests**

```bash
cd packages/api && npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/api/src/routes/ packages/api/src/middleware/ packages/api/src/app.ts packages/api/src/__tests__/routes/ packages/api/package.json
git commit -m "feat(api): add Express routes for tasks, health, and error handling"
```

---

### Task 5: API Package — Entry Point and Dockerfile

**Files:**
- Create: `packages/api/src/index.ts`
- Create: `packages/api/Dockerfile`

- [ ] **Step 1: Create API entry point**

Create `packages/api/src/index.ts`:

```typescript
import { loadApiConfig, createLogger } from '@local-agent/shared';
import { RabbitMQService } from './services/rabbitmq';
import { createApp } from './app';

async function main() {
  const config = loadApiConfig();
  const logger = createLogger('api', config.logLevel);

  const rabbitmq = new RabbitMQService(config.rabbitmqUrl, config.queueName);

  let retries = 0;
  const maxRetries = 10;
  while (retries < maxRetries) {
    try {
      await rabbitmq.connect();
      logger.info('Connected to RabbitMQ');
      break;
    } catch (err) {
      retries++;
      const delay = Math.min(1000 * Math.pow(2, retries), 30000);
      logger.warn({ err, retries, delay }, 'Failed to connect to RabbitMQ, retrying...');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (retries >= maxRetries) {
    logger.fatal('Could not connect to RabbitMQ after max retries');
    process.exit(1);
  }

  const app = createApp(rabbitmq);

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'API server started');
  });

  const shutdown = async () => {
    logger.info('Shutting down...');
    server.close();
    await rabbitmq.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Create Dockerfile**

Create `packages/api/Dockerfile`:

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Copy Rush config
COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Copy package manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api/package.json packages/api/package.json

# Install Rush globally and run rush install
RUN npm install -g @microsoft/rush@5.172.1
RUN rush install --to @local-agent/api

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/api/ packages/api/

# Build shared first, then api
RUN cd packages/shared && npx tsc
RUN cd packages/api && npx tsc

# Production stage
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/api/package.json packages/api/package.json
COPY --from=builder /app/packages/api/dist/ packages/api/dist/
COPY --from=builder /app/packages/api/node_modules/ packages/api/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/api

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Build TypeScript to verify compilation**

```bash
cd packages/shared && npx tsc && cd ../api && npx tsc
```

Expected: No compilation errors.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/index.ts packages/api/Dockerfile
git commit -m "feat(api): add entry point with retry logic and Dockerfile"
```

---

### Task 6: Docker Compose

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: guest
      RABBITMQ_DEFAULT_PASS: guest
    healthcheck:
      test: rabbitmq-diagnostics -q ping
      interval: 10s
      timeout: 5s
      retries: 5

  api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
    ports:
      - "3000:3000"
    environment:
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
      QUEUE_NAME: tasks
      PORT: "3000"
      LOG_LEVEL: info
    depends_on:
      rabbitmq:
        condition: service_healthy
```

- [ ] **Step 2: Verify docker-compose config**

```bash
docker compose config
```

Expected: Valid YAML output, no errors.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add docker-compose with RabbitMQ and API services"
```

---

### Task 7: Daemon Package — Handler and Poller

**Files:**
- Create: `packages/daemon/package.json`
- Create: `packages/daemon/tsconfig.json`
- Create: `packages/daemon/vitest.config.ts`
- Create: `packages/daemon/src/handler.ts`
- Create: `packages/daemon/src/poller.ts`
- Test: `packages/daemon/src/__tests__/handler.test.ts`
- Test: `packages/daemon/src/__tests__/poller.test.ts`

- [ ] **Step 1: Create `packages/daemon/package.json`**

```json
{
  "name": "@local-agent/daemon",
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

- [ ] **Step 2: Create `packages/daemon/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/daemon/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: './src',
  },
});
```

- [ ] **Step 4: Write failing handler test**

Create `packages/daemon/src/__tests__/handler.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleTask } from '../handler';
import { Task } from '@local-agent/shared';

describe('handleTask', () => {
  it('logs the task and returns without error', async () => {
    const task: Task = {
      task_id: 'test-123',
      task_type: 'generic',
      payload: 'hello world',
      submitted_at: '2026-03-26T00:00:00.000Z',
    };
    // Should not throw
    await expect(handleTask(task)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

```bash
rush update && cd packages/daemon && npx vitest run
```

Expected: FAIL — `handleTask` not found.

- [ ] **Step 6: Implement handler**

Create `packages/daemon/src/handler.ts`:

```typescript
import { Task, createLogger } from '@local-agent/shared';

const logger = createLogger('daemon:handler');

export async function handleTask(task: Task): Promise<void> {
  logger.info({ task_id: task.task_id, task_type: task.task_type, payload: task.payload }, 'Processing task');
}
```

- [ ] **Step 7: Run handler test**

```bash
cd packages/daemon && npx vitest run src/__tests__/handler.test.ts
```

Expected: PASS.

- [ ] **Step 8: Write failing poller test**

Create `packages/daemon/src/__tests__/poller.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Poller } from '../poller';
import { Task } from '@local-agent/shared';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Poller', () => {
  let poller: Poller;
  const mockHandler = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    poller = new Poller('http://localhost:3000', mockHandler);
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches next task and calls handler + ack when task available', async () => {
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
      expect(mockHandler).toHaveBeenCalledWith(task);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks/abc-123/ack', {
        method: 'POST',
      });
    });

    it('does nothing when queue is empty (204)', async () => {
      mockFetch.mockResolvedValueOnce({ status: 204 });
      await poller.pollOnce();
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      // Should not throw
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 9: Run poller test to verify it fails**

```bash
cd packages/daemon && npx vitest run src/__tests__/poller.test.ts
```

Expected: FAIL — `Poller` not found.

- [ ] **Step 10: Implement poller**

Create `packages/daemon/src/poller.ts`:

```typescript
import { Task, createLogger } from '@local-agent/shared';

const logger = createLogger('daemon:poller');

type TaskHandler = (task: Task) => Promise<void>;

export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly apiUrl: string,
    private readonly handler: TaskHandler,
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

      const task: Task = await res.json();
      logger.info({ task_id: task.task_id }, 'Received task');

      await this.handler(task);

      await fetch(`${this.apiUrl}/tasks/${task.task_id}/ack`, { method: 'POST' });
      logger.info({ task_id: task.task_id }, 'Task acknowledged');
    } catch (err) {
      logger.error({ err }, 'Poll error');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs }, 'Starting poller');
    this.timer = setInterval(() => this.pollOnce(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Poller stopped');
    }
  }
}
```

- [ ] **Step 11: Run all daemon tests**

```bash
cd packages/daemon && npx vitest run
```

Expected: All tests PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/daemon/
git commit -m "feat(daemon): add task handler and HTTP poller with tests"
```

---

### Task 8: Daemon Package — Entry Point

**Files:**
- Create: `packages/daemon/src/index.ts`

- [ ] **Step 1: Create daemon entry point**

Create `packages/daemon/src/index.ts`:

```typescript
import { loadDaemonConfig, createLogger } from '@local-agent/shared';
import { Poller } from './poller';
import { handleTask } from './handler';

function main() {
  const config = loadDaemonConfig();
  const logger = createLogger('daemon', config.logLevel);

  logger.info({ apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs }, 'Starting daemon');

  const poller = new Poller(config.apiUrl, handleTask);
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

- [ ] **Step 2: Build daemon**

```bash
cd packages/daemon && npx tsc
```

Expected: No compilation errors.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/index.ts
git commit -m "feat(daemon): add entry point with graceful shutdown"
```

---

### Task 9: End-to-End Verification

**Files:** None (verification only)

- [ ] **Step 1: Run `rush update` to finalize all dependencies**

```bash
rush update
```

Expected: All packages resolved, pnpm-lock.yaml up to date.

- [ ] **Step 2: Build all packages**

```bash
rush build
```

Expected: All 3 packages build successfully.

- [ ] **Step 3: Run all tests**

```bash
rush test --verbose
```

If `rush test` is not configured, run per package:

```bash
cd packages/shared && npx vitest run && cd ../api && npx vitest run && cd ../daemon && npx vitest run
```

Expected: All tests PASS across all packages.

- [ ] **Step 4: Start docker-compose and verify**

```bash
docker compose up --build -d
```

Wait for services to be healthy, then test:

```bash
# Health check
curl http://localhost:3000/health

# Submit a task
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{"task_type": "generic", "payload": "hello world"}'

# Poll for task
curl http://localhost:3000/tasks/next

# ACK the task (use the task_id from the previous response)
curl -X POST http://localhost:3000/tasks/<task_id>/ack
```

Expected: All endpoints respond correctly per spec.

- [ ] **Step 5: Test daemon locally**

In a separate terminal:

```bash
cd packages/daemon && npx ts-node src/index.ts
```

Submit a task via curl, observe daemon logs showing it picks up and ACKs the task.

- [ ] **Step 6: Tear down**

```bash
docker compose down
```

- [ ] **Step 7: Commit lock file if changed**

```bash
git add common/config/rush/pnpm-lock.yaml
git commit -m "chore: update pnpm-lock.yaml"
```
