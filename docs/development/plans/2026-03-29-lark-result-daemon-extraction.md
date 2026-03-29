# Lark Result Daemon Extraction Implementation Plan

**Goal:** Extract the Lark notification daemon from `@local-agent/daemon` into a standalone `@local-agent/lark-result-daemon` package, rename the remaining daemon to `@local-agent/task-daemon`, and update Docker Compose with per-service profiles.

**Architecture:** Move `lark-daemon.ts`, `lark-poller.ts`, `lark-notifier.ts`, and their tests into a new `packages/lark-result-daemon/` Rush package. Move `loadLarkDaemonConfig` and `DEFAULT_LARK_MAX_RETRIES` from shared to the new package. Rename `packages/daemon/` to `packages/task-daemon/`. Add Dockerfiles for both daemons, update docker-compose.yml with per-service profiles, and update `.env.example` with Lark placeholder env vars.

**Tech Stack:** TypeScript, Vitest, Rush (pnpm), Docker

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/lark-result-daemon/package.json` | Create | Package manifest with deps and scripts |
| `packages/lark-result-daemon/tsconfig.json` | Create | TypeScript config extending base |
| `packages/lark-result-daemon/Dockerfile` | Create | Multi-stage Docker build |
| `packages/lark-result-daemon/src/index.ts` | Create | Entry point (from daemon's `lark-daemon.ts`) |
| `packages/lark-result-daemon/src/config.ts` | Create | `loadLarkDaemonConfig` + `LarkDaemonConfig` (from shared) |
| `packages/lark-result-daemon/src/constants.ts` | Create | `DEFAULT_LARK_MAX_RETRIES` (from shared) |
| `packages/lark-result-daemon/src/lark-poller.ts` | Create | LarkPoller class (from daemon) |
| `packages/lark-result-daemon/src/adapters/lark-notifier.ts` | Create | LarkNotifier class (from daemon) |
| `packages/lark-result-daemon/src/__tests__/config.test.ts` | Create | Config loader tests (from shared) |
| `packages/lark-result-daemon/src/__tests__/lark-poller.test.ts` | Create | Poller tests (from daemon) |
| `packages/lark-result-daemon/src/__tests__/lark-notifier.test.ts` | Create | Notifier tests (from daemon) |
| `packages/shared/src/config.ts` | Modify | Remove `LarkDaemonConfig` and `loadLarkDaemonConfig` |
| `packages/shared/src/constants.ts` | Modify | Remove `DEFAULT_LARK_MAX_RETRIES` |
| `packages/shared/src/index.ts` | Modify | Remove lark config/constant exports |
| `packages/shared/src/__tests__/config.test.ts` | Modify | Remove `loadLarkDaemonConfig` test block |
| `packages/daemon/` → `packages/task-daemon/` | Rename dir | Directory rename |
| `packages/task-daemon/package.json` | Modify | Rename to `@local-agent/task-daemon`, simplify scripts |
| `packages/task-daemon/src/lark-daemon.ts` | Delete | Moved to lark-result-daemon |
| `packages/task-daemon/src/lark-poller.ts` | Delete | Moved to lark-result-daemon |
| `packages/task-daemon/src/adapters/lark-notifier.ts` | Delete | Moved to lark-result-daemon |
| `packages/task-daemon/src/__tests__/lark-poller.test.ts` | Delete | Moved to lark-result-daemon |
| `packages/task-daemon/src/adapters/__tests__/lark-notifier.test.ts` | Delete | Moved to lark-result-daemon |
| `packages/task-daemon/Dockerfile` | Create | Multi-stage Docker build for task-daemon |
| `rush.json` | Modify | Add lark-result-daemon project (Task 1), rename daemon to task-daemon (Task 12) |
| `docker-compose.yml` | Modify | Add all services with per-service profiles |
| `packages/api/Dockerfile` | Modify | Update manifest COPY paths for renamed daemon |
| `.env.example` | Modify | Add Lark placeholder env vars |

---

### Task 1: Create the `@local-agent/lark-result-daemon` package scaffold

**Files:**
- Create: `packages/lark-result-daemon/package.json`
- Create: `packages/lark-result-daemon/tsconfig.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@local-agent/lark-result-daemon",
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
    "dotenv": "~16.4.7"
  },
  "devDependencies": {
    "typescript": "~5.7.0",
    "vitest": "~1.6.0",
    "rimraf": "~5.0.0",
    "ts-node": "~10.9.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

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

- [ ] **Step 3: Create `src/` directory**

```bash
mkdir -p packages/lark-result-daemon/src/adapters
mkdir -p packages/lark-result-daemon/src/__tests__
```

- [ ] **Step 4: Add `@local-agent/lark-result-daemon` to rush.json**

Add the new package entry to the `projects` array in `rush.json` (keep the existing `@local-agent/daemon` entry for now — it will be renamed in Task 12):

```json
{
  "packageName": "@local-agent/lark-result-daemon",
  "projectFolder": "packages/lark-result-daemon"
}
```

- [ ] **Step 5: Run `rush update` to install dependencies for the new package**

```bash
rush update
```

Expected: Success. The new package's `node_modules` (including `vitest`) are installed, so tests in later tasks can run.

- [ ] **Step 6: Commit**

```bash
git add packages/lark-result-daemon/package.json packages/lark-result-daemon/tsconfig.json rush.json common/
git commit -m "feat(lark-result-daemon): add package scaffold and register in rush.json"
```

---

### Task 2: Move config and constants from shared to lark-result-daemon

**Files:**
- Create: `packages/lark-result-daemon/src/config.ts`
- Create: `packages/lark-result-daemon/src/constants.ts`

- [ ] **Step 1: Create `src/constants.ts`**

```ts
// packages/lark-result-daemon/src/constants.ts
export const DEFAULT_LARK_MAX_RETRIES = 3;
```

- [ ] **Step 2: Create `src/config.ts`**

```ts
// packages/lark-result-daemon/src/config.ts
import dotenv from 'dotenv';
import {
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
} from '@local-agent/shared';

dotenv.config();

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

- [ ] **Step 3: Commit**

```bash
git add packages/lark-result-daemon/src/constants.ts packages/lark-result-daemon/src/config.ts
git commit -m "feat(lark-result-daemon): add config loader and constants"
```

---

### Task 3: Write config tests

**Files:**
- Create: `packages/lark-result-daemon/src/__tests__/config.test.ts`

- [ ] **Step 1: Create config test (moved from shared)**

```ts
// packages/lark-result-daemon/src/__tests__/config.test.ts
import { describe, it, expect } from 'vitest';
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

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/lark-result-daemon && npx vitest run src/__tests__/config.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: Commit**

```bash
git add packages/lark-result-daemon/src/__tests__/config.test.ts
git commit -m "test(lark-result-daemon): add config loader tests"
```

---

### Task 4: Move LarkNotifier adapter

**Files:**
- Create: `packages/lark-result-daemon/src/adapters/lark-notifier.ts`

- [ ] **Step 1: Create lark-notifier.ts**

Copy from `packages/daemon/src/adapters/lark-notifier.ts`, updating the import for `DEFAULT_LARK_MAX_RETRIES`:

```ts
// packages/lark-result-daemon/src/adapters/lark-notifier.ts
import { TaskResult, createLogger } from '@local-agent/shared';
import { DEFAULT_LARK_MAX_RETRIES } from '../constants';

const logger = createLogger('lark-daemon:notifier');

const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
const LARK_MESSAGE_URL = 'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id';
const MAX_SNIPPET_CHARS = 2000;
const MAX_RETRIES = DEFAULT_LARK_MAX_RETRIES;

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
    const tokenRes = await fetch(LARK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const tokenData = await tokenRes.json() as { tenant_access_token: string; code: number };

    if (tokenData.code !== 0) {
      throw new Error(`Lark token request failed with code ${tokenData.code}`);
    }

    const snippet = result.stdout.length > MAX_SNIPPET_CHARS
      ? result.stdout.substring(0, MAX_SNIPPET_CHARS)
      : result.stdout;

    const text = [
      `Task ${result.task_id} — ${result.status}`,
      `Exit code: ${result.exit_code ?? 'N/A'}`,
      snippet ? `Output:\n${snippet}` : 'No output',
    ].join('\n');

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

- [ ] **Step 2: Commit**

```bash
git add packages/lark-result-daemon/src/adapters/lark-notifier.ts
git commit -m "feat(lark-result-daemon): move LarkNotifier adapter"
```

---

### Task 5: Move LarkNotifier tests

**Files:**
- Create: `packages/lark-result-daemon/src/__tests__/lark-notifier.test.ts`

- [ ] **Step 1: Create lark-notifier.test.ts**

Copy from `packages/daemon/src/adapters/__tests__/lark-notifier.test.ts`, updating the import path (flattened from `adapters/__tests__/` to `__tests__/`):

```ts
// packages/lark-result-daemon/src/__tests__/lark-notifier.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskResult } from '@local-agent/shared';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { LarkNotifier } from '../adapters/lark-notifier';

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
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult());

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(1,
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: 'app-id', app_secret: 'app-secret' }),
      }),
    );
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
    expect(content.text).toContain('task-123');
    expect(content.text).toContain('success');
    expect(content.text.length).toBeLessThan(3000);
  });

  it('retries up to 3 times on fetch failure then resolves', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'));

    await expect(notifier.notify(createResult())).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on retry after initial failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult());
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/lark-result-daemon && npx vitest run src/__tests__/lark-notifier.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 3: Commit**

```bash
git add packages/lark-result-daemon/src/__tests__/lark-notifier.test.ts
git commit -m "test(lark-result-daemon): move LarkNotifier tests"
```

---

### Task 6: Move LarkPoller

**Files:**
- Create: `packages/lark-result-daemon/src/lark-poller.ts`

- [ ] **Step 1: Create lark-poller.ts**

Copy from `packages/daemon/src/lark-poller.ts`. No import changes needed — it already imports `LarkNotifier` from `./adapters/lark-notifier` and types from `@local-agent/shared`:

```ts
// packages/lark-result-daemon/src/lark-poller.ts
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

      await this.notifier.notify(result);

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

- [ ] **Step 2: Commit**

```bash
git add packages/lark-result-daemon/src/lark-poller.ts
git commit -m "feat(lark-result-daemon): move LarkPoller"
```

---

### Task 7: Move LarkPoller tests

**Files:**
- Create: `packages/lark-result-daemon/src/__tests__/lark-poller.test.ts`

- [ ] **Step 1: Create lark-poller.test.ts**

Copy from `packages/daemon/src/__tests__/lark-poller.test.ts`, updating the mock path and import path (both go up one level since tests are now in `__tests__/` not `src/__tests__/` relative to the module):

```ts
// packages/lark-result-daemon/src/__tests__/lark-poller.test.ts
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
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(sampleResult),
        })
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

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/lark-result-daemon && npx vitest run src/__tests__/lark-poller.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 3: Commit**

```bash
git add packages/lark-result-daemon/src/__tests__/lark-poller.test.ts
git commit -m "test(lark-result-daemon): move LarkPoller tests"
```

---

### Task 8: Create entry point

**Files:**
- Create: `packages/lark-result-daemon/src/index.ts`

- [ ] **Step 1: Create index.ts**

Adapted from `packages/daemon/src/lark-daemon.ts`, updating imports to use local config instead of shared:

```ts
// packages/lark-result-daemon/src/index.ts
import { createLogger, DEFAULT_LARK_QUEUE_NAME } from '@local-agent/shared';
import { loadLarkDaemonConfig } from './config';
import { LarkPoller } from './lark-poller';
import { LarkNotifier } from './adapters/lark-notifier';

async function main() {
  const config = loadLarkDaemonConfig();
  const logger = createLogger('lark-daemon', config.logLevel);

  if (!config.larkAppId?.trim() || !config.larkAppSecret?.trim() || !config.larkRecipientId?.trim()) {
    logger.fatal('LARK_APP_ID, LARK_APP_SECRET, and LARK_RECIPIENT_ID must be set and non-empty');
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

- [ ] **Step 2: Run all lark-result-daemon tests**

Run: `cd packages/lark-result-daemon && npx vitest run`
Expected: PASS (all 9 tests across 3 test files)

- [ ] **Step 3: Commit**

```bash
git add packages/lark-result-daemon/src/index.ts
git commit -m "feat(lark-result-daemon): add entry point"
```

---

### Task 9: Remove lark exports from shared package

**Files:**
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/__tests__/config.test.ts`

- [ ] **Step 1: Remove `LarkDaemonConfig` and `loadLarkDaemonConfig` from `config.ts`**

Remove the `LarkDaemonConfig` interface and `loadLarkDaemonConfig` function (lines 38-55 of `packages/shared/src/config.ts`). The file should end after `loadDaemonConfig`.

- [ ] **Step 2: Remove `DEFAULT_LARK_MAX_RETRIES` from `constants.ts`**

Remove the line `export const DEFAULT_LARK_MAX_RETRIES = 3;` from `packages/shared/src/constants.ts`. Keep `DEFAULT_LARK_QUEUE_NAME` — it's still used by the API.

- [ ] **Step 3: Remove lark exports from `index.ts`**

Remove these exports from `packages/shared/src/index.ts`:
- `loadLarkDaemonConfig`
- `LarkDaemonConfig`
- `DEFAULT_LARK_MAX_RETRIES`

- [ ] **Step 4: Remove `loadLarkDaemonConfig` test block from `config.test.ts`**

Remove the entire `describe('loadLarkDaemonConfig', ...)` block (lines 47-74) and the `loadLarkDaemonConfig` import from line 2 of `packages/shared/src/__tests__/config.test.ts`.

- [ ] **Step 5: Run shared tests to verify nothing broke**

Run: `cd packages/shared && npx vitest run`
Expected: PASS (all remaining tests pass, `loadLarkDaemonConfig` tests gone)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/config.ts packages/shared/src/constants.ts packages/shared/src/index.ts packages/shared/src/__tests__/config.test.ts
git commit -m "refactor(shared): remove lark-specific config, constants, and exports"
```

---

### Task 10: Rename `packages/daemon/` to `packages/task-daemon/`

**Files:**
- Rename dir: `packages/daemon/` → `packages/task-daemon/`
- Modify: `packages/task-daemon/package.json`

- [ ] **Step 1: Rename the directory**

```bash
mv packages/daemon packages/task-daemon
```

- [ ] **Step 2: Update package.json**

In `packages/task-daemon/package.json`, change:
- `"name"` from `"@local-agent/daemon"` to `"@local-agent/task-daemon"`
- `"main"` stays `"dist/task-daemon.js"`
- Replace scripts with:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/task-daemon.js",
    "dev": "ts-node src/task-daemon.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rimraf dist"
  }
}
```

(Remove `start:lark-daemon` and `dev:lark-daemon` scripts, rename `start:task-daemon` to `start` and `dev:task-daemon` to `dev`.)

- [ ] **Step 3: Commit**

```bash
git add -A packages/task-daemon/ packages/daemon/
git commit -m "refactor: rename @local-agent/daemon to @local-agent/task-daemon"
```

---

### Task 11: Delete lark files from task-daemon

**Files:**
- Delete: `packages/task-daemon/src/lark-daemon.ts`
- Delete: `packages/task-daemon/src/lark-poller.ts`
- Delete: `packages/task-daemon/src/adapters/lark-notifier.ts`
- Delete: `packages/task-daemon/src/__tests__/lark-poller.test.ts`
- Delete: `packages/task-daemon/src/adapters/__tests__/lark-notifier.test.ts`

- [ ] **Step 1: Delete all lark files**

```bash
rm packages/task-daemon/src/lark-daemon.ts
rm packages/task-daemon/src/lark-poller.ts
rm packages/task-daemon/src/adapters/lark-notifier.ts
rm packages/task-daemon/src/__tests__/lark-poller.test.ts
rm packages/task-daemon/src/adapters/__tests__/lark-notifier.test.ts
```

- [ ] **Step 2: Run task-daemon tests to verify remaining tests pass**

Run: `cd packages/task-daemon && npx vitest run`
Expected: PASS (task-poller, orchestrator, executor tests still pass)

- [ ] **Step 3: Commit**

```bash
git add -A packages/task-daemon/
git commit -m "refactor(task-daemon): remove lark notification code"
```

---

### Task 12: Update rush.json for daemon rename

**Files:**
- Modify: `rush.json`

Note: `@local-agent/lark-result-daemon` was already added to `rush.json` in Task 1. This task only renames the daemon entry to match the directory rename from Task 10.

- [ ] **Step 1: Rename the daemon entry in the projects array**

Change the existing `@local-agent/daemon` entry:
```json
{
  "packageName": "@local-agent/task-daemon",
  "projectFolder": "packages/task-daemon"
}
```

The final `projects` array should contain: `@local-agent/shared`, `@local-agent/api`, `@local-agent/task-daemon`, `@local-agent/lark-result-daemon`, `@local-agent/cli`.

- [ ] **Step 2: Run rush update**

```bash
rush update
```

Expected: Success. All packages resolved with the renamed project folder.

- [ ] **Step 3: Run rush build**

```bash
rush build
```

Expected: All 5 packages build successfully.

- [ ] **Step 4: Commit**

```bash
git add rush.json common/
git commit -m "chore: update rush.json for daemon rename to task-daemon"
```

---

### Task 13: Update API Dockerfile

**Files:**
- Modify: `packages/api/Dockerfile`

- [ ] **Step 1: Update COPY line for daemon manifest**

In `packages/api/Dockerfile`, change:
```dockerfile
COPY packages/daemon/package.json packages/daemon/package.json
```
to:
```dockerfile
COPY packages/task-daemon/package.json packages/task-daemon/package.json
COPY packages/lark-result-daemon/package.json packages/lark-result-daemon/package.json
```

Also add the cli package manifest if not already present (Rush requires all projects in rush.json):
```dockerfile
COPY packages/cli/package.json packages/cli/package.json
```

- [ ] **Step 2: Commit**

```bash
git add packages/api/Dockerfile
git commit -m "fix(api): update Dockerfile for renamed daemon package"
```

---

### Task 14: Create task-daemon Dockerfile

**Files:**
- Create: `packages/task-daemon/Dockerfile`

- [ ] **Step 1: Create Dockerfile**

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
COPY packages/cli/package.json packages/cli/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/task-daemon

COPY packages/shared/ packages/shared/
COPY packages/task-daemon/ packages/task-daemon/

RUN cd packages/shared && npx tsc
RUN cd packages/task-daemon && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/task-daemon/package.json packages/task-daemon/package.json
COPY --from=builder /app/packages/task-daemon/dist/ packages/task-daemon/dist/
COPY --from=builder /app/packages/task-daemon/node_modules/ packages/task-daemon/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/task-daemon

CMD ["node", "dist/task-daemon.js"]
```

- [ ] **Step 2: Commit**

```bash
git add packages/task-daemon/Dockerfile
git commit -m "feat(task-daemon): add Dockerfile"
```

---

### Task 15: Create lark-result-daemon Dockerfile

**Files:**
- Create: `packages/lark-result-daemon/Dockerfile`

- [ ] **Step 1: Create Dockerfile**

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/lark-result-daemon/package.json packages/lark-result-daemon/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/task-daemon/package.json packages/task-daemon/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/lark-result-daemon

COPY packages/shared/ packages/shared/
COPY packages/lark-result-daemon/ packages/lark-result-daemon/

RUN cd packages/shared && npx tsc
RUN cd packages/lark-result-daemon && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/lark-result-daemon/package.json packages/lark-result-daemon/package.json
COPY --from=builder /app/packages/lark-result-daemon/dist/ packages/lark-result-daemon/dist/
COPY --from=builder /app/packages/lark-result-daemon/node_modules/ packages/lark-result-daemon/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/lark-result-daemon

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Commit**

```bash
git add packages/lark-result-daemon/Dockerfile
git commit -m "feat(lark-result-daemon): add Dockerfile"
```

---

### Task 16: Update docker-compose.yml with profiles

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Replace docker-compose.yml contents**

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
    profiles:
      - api
      - full

  task-daemon:
    build:
      context: .
      dockerfile: packages/task-daemon/Dockerfile
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
      - task-daemon
      - full

  lark-result-daemon:
    build:
      context: .
      dockerfile: packages/lark-result-daemon/Dockerfile
    environment:
      API_URL: http://api:3000
      POLL_INTERVAL_MS: "5000"
      LOG_LEVEL: info
      LARK_APP_ID: ${LARK_APP_ID}
      LARK_APP_SECRET: ${LARK_APP_SECRET}
      LARK_RECIPIENT_ID: ${LARK_RECIPIENT_ID}
    depends_on:
      rabbitmq:
        condition: service_healthy
      api:
        condition: service_started
    profiles:
      - lark-result-daemon
      - full
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: update docker-compose with per-service profiles"
```

---

### Task 17: Update .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Replace .env.example contents**

```env
# API Configuration
PORT=3000
RABBITMQ_URL=amqp://guest:guest@localhost:5672
QUEUE_NAME=tasks
LOG_LEVEL=info

# Daemon Configuration (shared by task-daemon and lark-result-daemon)
API_URL=http://localhost:3000
POLL_INTERVAL_MS=5000

# Lark Result Daemon Configuration
LARK_APP_ID=your_lark_app_id
LARK_APP_SECRET=your_lark_app_secret
LARK_RECIPIENT_ID=your_lark_recipient_open_id
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: add Lark env vars to .env.example"
```

---

### Task 18: Final verification

- [ ] **Step 1: Run rush build**

```bash
rush build
```

Expected: All 5 packages build successfully.

- [ ] **Step 2: Run all tests across the monorepo**

```bash
cd packages/shared && npx vitest run
cd ../task-daemon && npx vitest run
cd ../lark-result-daemon && npx vitest run
cd ../api && npx vitest run
```

Expected: All tests pass across all packages.

- [ ] **Step 3: Verify no lark references remain in task-daemon**

```bash
grep -r "lark" packages/task-daemon/src/ --include="*.ts"
```

Expected: No output (no matches).

- [ ] **Step 4: Verify no `loadLarkDaemonConfig` or `DEFAULT_LARK_MAX_RETRIES` references remain in shared**

```bash
grep -r "loadLarkDaemonConfig\|DEFAULT_LARK_MAX_RETRIES\|LarkDaemonConfig" packages/shared/src/ --include="*.ts"
```

Expected: No output (no matches).

- [ ] **Step 5: Verify docker-compose config is valid**

```bash
docker compose config
```

Expected: Valid YAML output showing all 4 services.

- [ ] **Step 6: Commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: final verification fixups"
```
