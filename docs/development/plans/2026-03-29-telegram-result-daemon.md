# telegram-result-daemon Implementation Plan

**Goal:** Add a new daemon that consumes task results from the RabbitMQ fanout exchange and sends them as Telegram messages to a hardcoded recipient.

**Architecture:** New `@local-agent/telegram-result-daemon` package mirroring `lark-result-daemon` 1:1. Polls the API for results from a `telegram-messages` queue, formats MarkdownV2, sends via Telegram Bot API HTTP calls, ACKs. Queue topology is owned by the API service.

**Tech Stack:** TypeScript, Node.js native `fetch`, Telegram Bot API (direct HTTP), Vitest, Rush/pnpm monorepo, Docker.

**Design Doc:** `docs/development/design/2026-03-29-telegram-result-daemon-design.md`

---

## File Map

### New files (packages/telegram-result-daemon/)

| File | Responsibility |
|------|---------------|
| `package.json` | Package manifest, scripts, dependencies |
| `tsconfig.json` | TypeScript config extending `../../tsconfig.base.json` |
| `src/constants.ts` | `DEFAULT_TELEGRAM_MAX_RETRIES = 3`, `MAX_MESSAGE_CHARS = 3500` |
| `src/config.ts` | `TelegramDaemonConfig` interface + `loadTelegramDaemonConfig()` |
| `src/adapters/telegram-notifier.ts` | `TelegramNotifier` class: `validate()` (getMe), `notify(result)` (sendMessage + retry) |
| `src/telegram-poller.ts` | `TelegramPoller` class: poll, format MarkdownV2, delegate to notifier, ACK |
| `src/index.ts` | Entry point: load config, validate, create notifier+poller, start, shutdown handlers |
| `src/__tests__/config.test.ts` | Config loader tests |
| `src/__tests__/telegram-notifier.test.ts` | Notifier unit tests (mock fetch) |
| `src/__tests__/telegram-poller.test.ts` | Poller integration tests (mock notifier + fetch) |
| `Dockerfile` | Multi-stage build matching lark-result-daemon pattern |

### Modified files

| File | Change |
|------|--------|
| `packages/shared/src/constants.ts` | Add `DEFAULT_TELEGRAM_QUEUE_NAME` |
| `packages/shared/src/index.ts` | Re-export `DEFAULT_TELEGRAM_QUEUE_NAME` |
| `packages/api/src/services/rabbitmq.ts` | Assert + bind telegram-messages queue |
| `rush.json` | Register new package |
| `docker-compose.yml` | Add telegram-result-daemon service |
| `.env.example` | Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |

---

## Task 1: Scaffold package and register in monorepo

**Files:**
- Create: `packages/telegram-result-daemon/package.json`
- Create: `packages/telegram-result-daemon/tsconfig.json`
- Modify: `rush.json:9-35` (projects array)

- [ ] **Step 1: Create package.json**

Create `packages/telegram-result-daemon/package.json`:

```json
{
  "name": "@local-agent/telegram-result-daemon",
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

Create `packages/telegram-result-daemon/tsconfig.json`:

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

- [ ] **Step 3: Register in rush.json**

Add to the `projects` array in `rush.json` (after the lark-result-daemon entry):

```json
{
  "packageName": "@local-agent/telegram-result-daemon",
  "projectFolder": "packages/telegram-result-daemon"
}
```

- [ ] **Step 4: Run rush update**

Run: `rush update`
Expected: Succeeds, creates node_modules symlinks for the new package.

- [ ] **Step 5: Verify build**

Create a placeholder `packages/telegram-result-daemon/src/index.ts`:

```typescript
console.log('telegram-result-daemon placeholder');
```

Run: `cd packages/telegram-result-daemon && npx tsc`
Expected: Compiles successfully, creates `dist/index.js`.

- [ ] **Step 6: Commit**

```bash
git add packages/telegram-result-daemon/package.json packages/telegram-result-daemon/tsconfig.json packages/telegram-result-daemon/src/index.ts rush.json
git commit -m "feat(telegram-result-daemon): scaffold package and register in rush monorepo"
```

---

## Task 2: Add shared constant and queue binding

**Files:**
- Modify: `packages/shared/src/constants.ts:9`
- Modify: `packages/shared/src/index.ts:33`
- Modify: `packages/api/src/services/rabbitmq.ts:1-2,37-39`

- [ ] **Step 1: Add constant to shared/constants.ts**

Add after `DEFAULT_LARK_QUEUE_NAME` (line 8) in `packages/shared/src/constants.ts`:

```typescript
export const DEFAULT_TELEGRAM_QUEUE_NAME = 'telegram-messages';
```

- [ ] **Step 2: Re-export from shared/index.ts**

Add `DEFAULT_TELEGRAM_QUEUE_NAME` to the constants re-export block in `packages/shared/src/index.ts`:

```typescript
export {
  DEFAULT_QUEUE_NAME,
  DEFAULT_PORT,
  DEFAULT_RABBITMQ_URL,
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_RESULTS_EXCHANGE_NAME,
  DEFAULT_LARK_QUEUE_NAME,
  DEFAULT_JOBS_QUEUE_NAME,
  DEFAULT_TELEGRAM_QUEUE_NAME,
} from './constants';
```

- [ ] **Step 3: Add queue assertion and binding in rabbitmq.ts**

In `packages/api/src/services/rabbitmq.ts`:

Add `DEFAULT_TELEGRAM_QUEUE_NAME` to the import on line 2:

```typescript
import { Task, Job, TaskResult, createLogger, DEFAULT_RESULTS_EXCHANGE_NAME, DEFAULT_LARK_QUEUE_NAME, DEFAULT_JOBS_QUEUE_NAME, DEFAULT_TELEGRAM_QUEUE_NAME } from '@local-agent/shared';
```

Add after the lark queue bind (line 39) in the `connect()` method:

```typescript
await ch.assertQueue(DEFAULT_TELEGRAM_QUEUE_NAME, { durable: true });
await ch.bindQueue(DEFAULT_TELEGRAM_QUEUE_NAME, DEFAULT_RESULTS_EXCHANGE_NAME, '');
```

- [ ] **Step 4: Build shared and API to verify**

Run: `cd packages/shared && npx tsc && cd ../api && npx tsc`
Expected: Both compile successfully.

- [ ] **Step 5: Run existing API tests**

Run: `cd packages/api && npm test`
Expected: All existing tests pass. The rabbitmq tests should still pass since queue assertion is additive.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/index.ts packages/api/src/services/rabbitmq.ts
git commit -m "feat(shared,api): add telegram-messages queue constant and binding"
```

---

## Task 3: Config module with tests

**Files:**
- Create: `packages/telegram-result-daemon/src/config.ts`
- Create: `packages/telegram-result-daemon/src/__tests__/config.test.ts`

- [ ] **Step 1: Write config test**

Create `packages/telegram-result-daemon/src/__tests__/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadTelegramDaemonConfig } from '../config';

describe('loadTelegramDaemonConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadTelegramDaemonConfig({});
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
    expect(config.telegramBotToken).toBe('');
    expect(config.telegramChatId).toBe('');
  });

  it('reads from env vars', () => {
    const config = loadTelegramDaemonConfig({
      API_URL: 'http://other:4000',
      POLL_INTERVAL_MS: '2000',
      LOG_LEVEL: 'debug',
      TELEGRAM_BOT_TOKEN: 'bot123:ABC',
      TELEGRAM_CHAT_ID: '456789',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.logLevel).toBe('debug');
    expect(config.telegramBotToken).toBe('bot123:ABC');
    expect(config.telegramChatId).toBe('456789');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/telegram-result-daemon && npx vitest run src/__tests__/config.test.ts`
Expected: FAIL — `Cannot find module '../config'`

- [ ] **Step 3: Write config implementation**

Create `packages/telegram-result-daemon/src/config.ts`:

```typescript
import dotenv from 'dotenv';
import {
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
} from '@local-agent/shared';

dotenv.config();

export interface TelegramDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  telegramBotToken: string;
  telegramChatId: string;
}

export function loadTelegramDaemonConfig(env: Record<string, string | undefined> = process.env): TelegramDaemonConfig {
  return {
    apiUrl: env.API_URL ?? DEFAULT_API_URL,
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: env.TELEGRAM_CHAT_ID ?? '',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/telegram-result-daemon && npx vitest run src/__tests__/config.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/telegram-result-daemon/src/config.ts packages/telegram-result-daemon/src/__tests__/config.test.ts
git commit -m "feat(telegram-result-daemon): add config module with tests"
```

---

## Task 4: Constants module

**Files:**
- Create: `packages/telegram-result-daemon/src/constants.ts`

- [ ] **Step 1: Create constants**

Create `packages/telegram-result-daemon/src/constants.ts`:

```typescript
export const DEFAULT_TELEGRAM_MAX_RETRIES = 3;
export const MAX_MESSAGE_CHARS = 3500;
```

- [ ] **Step 2: Verify compilation**

Run: `cd packages/telegram-result-daemon && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/telegram-result-daemon/src/constants.ts
git commit -m "feat(telegram-result-daemon): add constants module"
```

---

## Task 5: TelegramNotifier adapter with tests

**Files:**
- Create: `packages/telegram-result-daemon/src/adapters/telegram-notifier.ts`
- Create: `packages/telegram-result-daemon/src/__tests__/telegram-notifier.test.ts`

- [ ] **Step 1: Write notifier tests**

Create `packages/telegram-result-daemon/src/__tests__/telegram-notifier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskResult } from '@local-agent/shared';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TelegramNotifier } from '../adapters/telegram-notifier';

function createResult(overrides?: Partial<TaskResult>): TaskResult {
  return {
    result_id: 'res-1',
    job_id: 'job-456',
    task_id: 'task-123',
    status: 'success',
    exit_code: 0,
    stdout: 'Task completed successfully',
    stderr: '',
    completed_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('TelegramNotifier', () => {
  let notifier: TelegramNotifier;

  beforeEach(() => {
    vi.clearAllMocks();
    notifier = new TelegramNotifier('bot123:ABC', '456789');
  });

  describe('validate', () => {
    it('calls getMe and returns bot username on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { username: 'test_bot' } }),
      });

      const username = await notifier.validate();

      expect(username).toBe('test_bot');
      expect(mockFetch).toHaveBeenCalledWith('https://api.telegram.org/botbot123:ABC/getMe');
    });

    it('throws when getMe returns ok: false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: false, description: 'Unauthorized' }),
      });

      await expect(notifier.validate()).rejects.toThrow('Telegram bot validation failed: Unauthorized');
    });

    it('throws when fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(notifier.validate()).rejects.toThrow('Network error');
    });
  });

  describe('notify', () => {
    it('sends message via sendMessage endpoint on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      await notifier.notify(createResult());

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/botbot123:ABC/sendMessage',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe('456789');
      expect(body.parse_mode).toBe('MarkdownV2');
      expect(body.text).toContain('job-456');
      expect(body.text).toContain('task-123');
      expect(body.text).toContain('success');
    });

    it('truncates long stdout to MAX_MESSAGE_CHARS', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      await notifier.notify(createResult({ stdout: 'x'.repeat(5000) }));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text.length).toBeLessThan(4096);
      expect(body.text).toContain('truncated');
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
          json: () => Promise.resolve({ ok: true }),
        });

      await notifier.notify(createResult());
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws on sendMessage ok: false and retries', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: false, description: 'Bad Request' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: false, description: 'Bad Request' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: false, description: 'Bad Request' }),
        });

      await expect(notifier.notify(createResult())).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('handles result with no output', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      await notifier.notify(createResult({ stdout: '', stderr: '' }));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('No output');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/telegram-result-daemon && npx vitest run src/__tests__/telegram-notifier.test.ts`
Expected: FAIL — `Cannot find module '../adapters/telegram-notifier'`

- [ ] **Step 3: Write notifier implementation**

Create `packages/telegram-result-daemon/src/adapters/telegram-notifier.ts`:

```typescript
import { TaskResult, createLogger } from '@local-agent/shared';
import { DEFAULT_TELEGRAM_MAX_RETRIES, MAX_MESSAGE_CHARS } from '../constants';

const logger = createLogger('telegram-daemon:notifier');

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const MAX_RETRIES = DEFAULT_TELEGRAM_MAX_RETRIES;

// MarkdownV2 special chars that must be escaped outside code blocks
const MARKDOWNV2_ESCAPE_REGEX = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWNV2_ESCAPE_REGEX, '\\$1');
}

export class TelegramNotifier {
  private readonly apiBase: string;

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {
    this.apiBase = `${TELEGRAM_API_BASE}${botToken}`;
  }

  async validate(): Promise<string> {
    const res = await fetch(`${this.apiBase}/getMe`);
    const data = await res.json() as { ok: boolean; result?: { username: string }; description?: string };

    if (!data.ok) {
      throw new Error(`Telegram bot validation failed: ${data.description ?? 'unknown error'}`);
    }

    return data.result!.username;
  }

  async notify(result: TaskResult): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.sendMessage(result);
        return;
      } catch (err) {
        logger.warn(
          { result_id: result.result_id, attempt, err },
          'Telegram notification attempt failed',
        );
        if (attempt === MAX_RETRIES) {
          logger.error(
            { result_id: result.result_id },
            `Telegram notification failed after ${MAX_RETRIES} attempts — giving up`,
          );
        }
      }
    }
  }

  private async sendMessage(result: TaskResult): Promise<void> {
    const text = this.formatMessage(result);

    const res = await fetch(`${this.apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'MarkdownV2',
      }),
    });

    const data = await res.json() as { ok: boolean; description?: string };

    if (!data.ok) {
      throw new Error(`Telegram sendMessage failed: ${data.description ?? 'unknown error'}`);
    }
  }

  private formatMessage(result: TaskResult): string {
    // Only escape text outside code spans/blocks — inline code renders literally
    const status = escapeMarkdownV2(result.status);
    const exitCode = result.exit_code?.toString() ?? 'N/A';

    let outputSection: string;
    if (!result.stdout && !result.stderr) {
      outputSection = '_No output_';
    } else {
      let snippet = result.stdout || result.stderr;
      let truncated = false;
      if (snippet.length > MAX_MESSAGE_CHARS) {
        snippet = snippet.substring(0, MAX_MESSAGE_CHARS);
        truncated = true;
      }
      // Code blocks don't need escaping in MarkdownV2
      outputSection = '```\n' + snippet + (truncated ? '\n[truncated]' : '') + '\n```';
    }

    return [
      `*Job* \`${result.job_id}\` \\(Task \`${result.task_id}\`\\) — *${status}*`,
      `*Exit code:* \`${exitCode}\``,
      `*Output:*`,
      outputSection,
    ].join('\n');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/telegram-result-daemon && npx vitest run src/__tests__/telegram-notifier.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/telegram-result-daemon/src/adapters/telegram-notifier.ts packages/telegram-result-daemon/src/__tests__/telegram-notifier.test.ts
git commit -m "feat(telegram-result-daemon): add TelegramNotifier adapter with tests"
```

---

## Task 6: TelegramPoller with tests

**Files:**
- Create: `packages/telegram-result-daemon/src/telegram-poller.ts`
- Create: `packages/telegram-result-daemon/src/__tests__/telegram-poller.test.ts`

- [ ] **Step 1: Write poller tests**

Create `packages/telegram-result-daemon/src/__tests__/telegram-poller.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskResult } from '@local-agent/shared';

const mockNotify = vi.fn().mockResolvedValue(undefined);

vi.mock('../adapters/telegram-notifier', () => ({
  TelegramNotifier: vi.fn().mockImplementation(() => ({
    notify: mockNotify,
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TelegramPoller } from '../telegram-poller';
import { TelegramNotifier } from '../adapters/telegram-notifier';

const sampleResult: TaskResult = {
  result_id: 'res-1',
  job_id: 'job-456',
  task_id: 'task-123',
  status: 'success',
  exit_code: 0,
  stdout: 'output',
  stderr: '',
  completed_at: '2026-03-29T00:00:00.000Z',
};

describe('TelegramPoller', () => {
  let poller: TelegramPoller;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotify.mockResolvedValue(undefined);
    const notifier = new TelegramNotifier('bot123:ABC', '456789');
    poller = new TelegramPoller('http://localhost:3000', 'telegram-messages', notifier);
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

      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/results/next/telegram-messages');
      expect(mockNotify).toHaveBeenCalledWith(sampleResult);
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results/telegram-messages/res-1/ack', {
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/telegram-result-daemon && npx vitest run src/__tests__/telegram-poller.test.ts`
Expected: FAIL — `Cannot find module '../telegram-poller'`

- [ ] **Step 3: Write poller implementation**

Create `packages/telegram-result-daemon/src/telegram-poller.ts`:

```typescript
import { TaskResult, createLogger } from '@local-agent/shared';
import { TelegramNotifier } from './adapters/telegram-notifier';

const logger = createLogger('telegram-daemon:poller');

export class TelegramPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly apiUrl: string,
    private readonly queueName: string,
    private readonly notifier: TelegramNotifier,
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
      logger.info({ result_id: result.result_id, job_id: result.job_id, task_id: result.task_id }, 'Received result');

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
      logger.error({ err }, 'Telegram poll error');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs, queueName: this.queueName }, 'Starting telegram poller');
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
      logger.info('Telegram poller stopped');
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/telegram-result-daemon && npx vitest run src/__tests__/telegram-poller.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/telegram-result-daemon/src/telegram-poller.ts packages/telegram-result-daemon/src/__tests__/telegram-poller.test.ts
git commit -m "feat(telegram-result-daemon): add TelegramPoller with tests"
```

---

## Task 7: Entry point (index.ts)

**Files:**
- Modify: `packages/telegram-result-daemon/src/index.ts` (replace placeholder)

- [ ] **Step 1: Write entry point**

Replace `packages/telegram-result-daemon/src/index.ts` with:

```typescript
import { loadTelegramDaemonConfig } from './config';
import { createLogger, DEFAULT_TELEGRAM_QUEUE_NAME } from '@local-agent/shared';
import { TelegramPoller } from './telegram-poller';
import { TelegramNotifier } from './adapters/telegram-notifier';

async function main() {
  const config = loadTelegramDaemonConfig();
  const logger = createLogger('telegram-daemon', config.logLevel);

  if (!config.telegramBotToken?.trim() || !config.telegramChatId?.trim()) {
    logger.fatal('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set and non-empty');
    process.exit(1);
  }

  const notifier = new TelegramNotifier(config.telegramBotToken, config.telegramChatId);

  logger.info('Validating Telegram bot token...');
  try {
    const botUsername = await notifier.validate();
    logger.info({ botUsername }, 'Telegram bot validated');
  } catch (err) {
    logger.fatal({ err }, 'Telegram bot validation failed');
    process.exit(1);
  }

  logger.info(
    { apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs, queueName: DEFAULT_TELEGRAM_QUEUE_NAME },
    'Starting telegram-daemon',
  );

  const poller = new TelegramPoller(config.apiUrl, DEFAULT_TELEGRAM_QUEUE_NAME, notifier);
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down telegram-daemon...');
    poller.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('telegram-daemon');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
```

- [ ] **Step 2: Verify compilation**

Run: `cd packages/telegram-result-daemon && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Run all package tests**

Run: `cd packages/telegram-result-daemon && npx vitest run`
Expected: All tests pass (config: 2, notifier: 8, poller: 3 = 13 total).

- [ ] **Step 4: Commit**

```bash
git add packages/telegram-result-daemon/src/index.ts
git commit -m "feat(telegram-result-daemon): add entry point with startup validation"
```

---

## Task 8: Dockerfile

**Files:**
- Create: `packages/telegram-result-daemon/Dockerfile`

- [ ] **Step 1: Create Dockerfile**

Create `packages/telegram-result-daemon/Dockerfile`:

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/telegram-result-daemon/package.json packages/telegram-result-daemon/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/task-daemon/package.json packages/task-daemon/package.json
COPY packages/lark-result-daemon/package.json packages/lark-result-daemon/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/task-enrichment-daemon/package.json packages/task-enrichment-daemon/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/telegram-result-daemon

COPY packages/shared/ packages/shared/
COPY packages/telegram-result-daemon/ packages/telegram-result-daemon/

RUN cd packages/shared && npx tsc
RUN cd packages/telegram-result-daemon && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/telegram-result-daemon/package.json packages/telegram-result-daemon/package.json
COPY --from=builder /app/packages/telegram-result-daemon/dist/ packages/telegram-result-daemon/dist/
COPY --from=builder /app/packages/telegram-result-daemon/node_modules/ packages/telegram-result-daemon/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/telegram-result-daemon

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Verify Docker build (optional — requires Docker)**

Run: `docker build -f packages/telegram-result-daemon/Dockerfile -t telegram-result-daemon .`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/telegram-result-daemon/Dockerfile
git commit -m "feat(telegram-result-daemon): add Dockerfile"
```

---

## Task 9: Docker Compose and env config

**Files:**
- Modify: `docker-compose.yml:70-87`
- Modify: `.env.example:12-15`

- [ ] **Step 1: Add service to docker-compose.yml**

Add after the `task-enrichment-daemon` service block (after line 87) in `docker-compose.yml`:

```yaml
  telegram-result-daemon:
    build:
      context: .
      dockerfile: packages/telegram-result-daemon/Dockerfile
    environment:
      API_URL: http://api:3000
      POLL_INTERVAL_MS: "5000"
      LOG_LEVEL: info
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID}
    depends_on:
      rabbitmq:
        condition: service_healthy
      api:
        condition: service_started
    profiles:
      - telegram-result-daemon
      - full
```

- [ ] **Step 2: Add env vars to .env.example**

Append to `.env.example`:

```
# Telegram Result Daemon Configuration
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
```

- [ ] **Step 3: Verify docker-compose config**

Run: `docker compose config --profiles telegram-result-daemon 2>&1 | head -5`
Expected: No YAML errors — should print service configuration.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "feat(telegram-result-daemon): add docker-compose service and env config"
```

---

## Task 10: Final verification

- [ ] **Step 1: Build all packages**

Run: `rush build`
Expected: All packages build successfully.

- [ ] **Step 2: Run all tests across the monorepo**

Run: `rush test`
Expected: All tests pass, including the 13 new telegram-result-daemon tests and all existing tests.

- [ ] **Step 3: Verify no regressions in API rabbitmq tests**

Run: `cd packages/api && npm test`
Expected: All tests pass, queue topology changes don't break existing tests.

- [ ] **Step 4: Review git log**

Run: `git log --oneline -10`
Expected: ~9 clean commits following the plan, all prefixed with `feat(telegram-result-daemon)` or `feat(shared,api)`.
