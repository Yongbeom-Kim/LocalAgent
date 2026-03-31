# Lark Listener Daemon Implementation Plan

**Goal:** Build a daemon that listens for incoming Lark messages (DM + @mentions) via WebSocket and enqueues them as `generic` tasks through the existing API.

**Architecture:** A new `packages/daemon/lark-listener` package using `@larksuiteoapi/node-sdk` WSClient for event-driven message reception. Messages are parsed into `TaskSubmission` payloads and POSTed to `POST /tasks`. An "OnIt" emoji reaction acknowledges receipt. In-memory TTL dedup prevents duplicate processing on WebSocket reconnect.

**Tech Stack:** TypeScript, `@larksuiteoapi/node-sdk`, `vitest`, `@local-agent/shared`, Node.js 20

**Design Doc:** `docs/development/design/2026-03-31-lark-listener-daemon-design.md`

---

## File Structure

```
packages/daemon/lark-listener/
  src/
    index.ts                    # Entry point: load config, wire deps, start WSClient
    config.ts                   # LarkListenerConfig interface + loadLarkListenerConfig()
    constants.ts                # MAX_RETRIES, DEDUP_TTL_MS, DEDUP_MAX_SIZE, LARK_API base URLs
    message-handler.ts          # Core: receives event, builds payload, submits task, reacts
    adapters/
      lark-reactor.ts           # Adds "OnIt" reaction via Lark REST API
      task-submitter.ts         # POST /tasks with exponential backoff retry
    services/
      dedup.ts                  # In-memory TTL map for message_id dedup
    __tests__/
      config.test.ts
      message-handler.test.ts
      task-submitter.test.ts
      dedup.test.ts
      lark-reactor.test.ts
  package.json
  tsconfig.json
  Dockerfile
```

---

## Task 1: Scaffold package and config

**Files:**
- Create: `packages/daemon/lark-listener/package.json`
- Create: `packages/daemon/lark-listener/tsconfig.json`
- Create: `packages/daemon/lark-listener/src/constants.ts`
- Create: `packages/daemon/lark-listener/src/config.ts`
- Create: `packages/daemon/lark-listener/src/__tests__/config.test.ts`
- Modify: `rush.json` (add project entry)

### Steps

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@local-agent/lark-listener-daemon",
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
    "@larksuiteoapi/node-sdk": "~0.6.0",
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

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**/*"]
}
```

- [ ] **Step 3: Add project to `rush.json`**

Add to the `projects` array in `rush.json`:

```json
{
  "packageName": "@local-agent/lark-listener-daemon",
  "projectFolder": "packages/daemon/lark-listener"
}
```

- [ ] **Step 4: Create `src/constants.ts`**

```typescript
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_DEDUP_TTL_MS = 300_000; // 5 minutes
export const DEFAULT_DEDUP_MAX_SIZE = 10_000;
export const DEFAULT_DEDUP_CLEANUP_INTERVAL_MS = 60_000; // 1 minute

export const LARK_TOKEN_URL =
  'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
export const LARK_REACTION_URL_PREFIX =
  'https://open.larksuite.com/open-apis/im/v1/messages';
```

- [ ] **Step 5: Create `src/config.ts`**

```typescript
import {
  DEFAULT_API_URL,
  DEFAULT_LOG_LEVEL,
  loadEnvFromRoot,
} from '@local-agent/shared';
import { DEFAULT_DEDUP_TTL_MS } from './constants';

loadEnvFromRoot();

export interface LarkListenerConfig {
  appId: string;
  appSecret: string;
  apiUrl: string;
  logLevel: string;
  dedupTtlMs: number;
}

export function loadLarkListenerConfig(
  env: Record<string, string | undefined> = process.env,
): LarkListenerConfig {
  return {
    appId: env.LARK_APP_ID ?? '',
    appSecret: env.LARK_APP_SECRET ?? '',
    apiUrl: env.API_URL ?? DEFAULT_API_URL,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    dedupTtlMs: env.DEDUP_TTL_MS
      ? parseInt(env.DEDUP_TTL_MS, 10)
      : DEFAULT_DEDUP_TTL_MS,
  };
}
```

- [ ] **Step 6: Write config test**

```typescript
import { describe, it, expect } from 'vitest';
import { loadLarkListenerConfig } from '../config';

describe('loadLarkListenerConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadLarkListenerConfig({});
    expect(config.appId).toBe('');
    expect(config.appSecret).toBe('');
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.logLevel).toBe('info');
    expect(config.dedupTtlMs).toBe(300_000);
  });

  it('reads from env vars', () => {
    const config = loadLarkListenerConfig({
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      API_URL: 'http://other:4000',
      LOG_LEVEL: 'debug',
      DEDUP_TTL_MS: '60000',
    });
    expect(config.appId).toBe('app123');
    expect(config.appSecret).toBe('secret456');
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.logLevel).toBe('debug');
    expect(config.dedupTtlMs).toBe(60_000);
  });
});
```

- [ ] **Step 7: Run `rush update` and verify tests pass**

```bash
cd /Users/bytedance/.ows/workspaces/personal_productivity/LocalAgent
node common/scripts/install-run-rush.js update
cd packages/daemon/lark-listener
npx vitest run
```

Expected: 2 tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/lark-listener/package.json packages/daemon/lark-listener/tsconfig.json packages/daemon/lark-listener/src/constants.ts packages/daemon/lark-listener/src/config.ts packages/daemon/lark-listener/src/__tests__/config.test.ts rush.json common/config/rush/pnpm-lock.yaml
git commit -m "feat(lark-listener): scaffold package with config and constants"
```

---

## Task 2: Dedup service

**Files:**
- Create: `packages/daemon/lark-listener/src/services/dedup.ts`
- Create: `packages/daemon/lark-listener/src/__tests__/dedup.test.ts`

### Steps

- [ ] **Step 1: Write dedup tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DedupMap } from '../services/dedup';

describe('DedupMap', () => {
  let dedup: DedupMap;

  beforeEach(() => {
    vi.useFakeTimers();
    dedup = new DedupMap({ ttlMs: 5000, maxSize: 3, cleanupIntervalMs: 2000 });
  });

  afterEach(() => {
    dedup.destroy();
    vi.useRealTimers();
  });

  it('returns false for unseen id, true for seen id', () => {
    expect(dedup.has('msg-1')).toBe(false);
    dedup.add('msg-1');
    expect(dedup.has('msg-1')).toBe(true);
  });

  it('expires entries after TTL', () => {
    dedup.add('msg-1');
    vi.advanceTimersByTime(2000);
    // trigger cleanup
    vi.advanceTimersByTime(1);
    expect(dedup.has('msg-1')).toBe(true);

    vi.advanceTimersByTime(3000);
    // trigger cleanup
    vi.advanceTimersByTime(1);
    expect(dedup.has('msg-1')).toBe(false);
  });

  it('evicts oldest when exceeding maxSize', () => {
    dedup.add('msg-1');
    vi.advanceTimersByTime(1);
    dedup.add('msg-2');
    vi.advanceTimersByTime(1);
    dedup.add('msg-3');
    vi.advanceTimersByTime(1);
    dedup.add('msg-4'); // should evict msg-1

    expect(dedup.has('msg-1')).toBe(false);
    expect(dedup.has('msg-4')).toBe(true);
  });

  it('destroy stops cleanup timer', () => {
    dedup.destroy();
    // Should not throw when timers advance
    vi.advanceTimersByTime(10_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/dedup.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement DedupMap**

```typescript
import {
  DEFAULT_DEDUP_TTL_MS,
  DEFAULT_DEDUP_MAX_SIZE,
  DEFAULT_DEDUP_CLEANUP_INTERVAL_MS,
} from '../constants';

interface DedupOptions {
  ttlMs?: number;
  maxSize?: number;
  cleanupIntervalMs?: number;
}

export class DedupMap {
  private readonly map = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor(opts: DedupOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_DEDUP_TTL_MS;
    this.maxSize = opts.maxSize ?? DEFAULT_DEDUP_MAX_SIZE;

    const intervalMs = opts.cleanupIntervalMs ?? DEFAULT_DEDUP_CLEANUP_INTERVAL_MS;
    this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  add(id: string): void {
    if (this.map.size >= this.maxSize) {
      // Evict oldest entry
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
    this.map.set(id, Date.now());
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.map.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, ts] of this.map) {
      if (now - ts > this.ttlMs) {
        this.map.delete(id);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/dedup.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/services/dedup.ts packages/daemon/lark-listener/src/__tests__/dedup.test.ts
git commit -m "feat(lark-listener): add DedupMap service with TTL and max-size eviction"
```

---

## Task 3: Task submitter with retry

**Files:**
- Create: `packages/daemon/lark-listener/src/adapters/task-submitter.ts`
- Create: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`

### Steps

- [ ] **Step 1: Write task submitter tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TaskSubmitter } from '../adapters/task-submitter';

describe('TaskSubmitter', () => {
  let submitter: TaskSubmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    submitter = new TaskSubmitter('http://localhost:3000');
  });

  it('posts TaskSubmission and returns task_id on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({ task_id: 'task-abc', task_type: 'generic', payload: 'hello' }),
    });

    const result = await submitter.submit('hello');
    expect(result).toBe('task-abc');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/tasks',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'generic', payload: 'hello' }),
      }),
    );
  });

  it('retries on failure with exponential backoff and returns null after max retries', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'));

    const promise = submitter.submit('hello');

    // Advance through retry delays: 1s, 2s, 4s
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    const result = await promise;
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on second attempt after first failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ task_id: 'task-xyz' }),
      });

    const promise = submitter.submit('retry test');
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe('task-xyz');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns null on non-ok response after retries', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });

    const promise = submitter.submit('fail');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    const result = await promise;

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/task-submitter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement TaskSubmitter**

```typescript
import { createLogger, type TaskSubmission } from '@local-agent/shared';
import { DEFAULT_MAX_RETRIES } from '../constants';

const logger = createLogger('lark-listener:submitter');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TaskSubmitter {
  constructor(private readonly apiUrl: string) {}

  /**
   * Submit a task to the API. Returns the task_id on success, null on failure.
   */
  async submit(payload: string): Promise<string | null> {
    const body: TaskSubmission = { task_type: 'generic', payload };

    for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`${this.apiUrl}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          throw new Error(`API returned status ${res.status}`);
        }

        const data = (await res.json()) as { task_id: string };
        logger.info({ task_id: data.task_id }, 'Task submitted');
        return data.task_id;
      } catch (err) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        logger.warn({ attempt, err, delayMs }, 'Task submission failed, retrying');
        if (attempt < DEFAULT_MAX_RETRIES) {
          await sleep(delayMs);
        }
      }
    }

    logger.error({ payload: payload.substring(0, 100) }, 'Task submission failed after all retries');
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/task-submitter.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/adapters/task-submitter.ts packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts
git commit -m "feat(lark-listener): add TaskSubmitter with exponential backoff retry"
```

---

## Task 4: Lark reactor (emoji reaction)

**Files:**
- Create: `packages/daemon/lark-listener/src/adapters/lark-reactor.ts`
- Create: `packages/daemon/lark-listener/src/__tests__/lark-reactor.test.ts`

### Steps

- [ ] **Step 1: Write lark reactor tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { LarkReactor } from '../adapters/lark-reactor';

describe('LarkReactor', () => {
  let reactor: LarkReactor;

  beforeEach(() => {
    vi.clearAllMocks();
    reactor = new LarkReactor('app-id', 'app-secret');
  });

  it('fetches tenant token and adds OnIt reaction', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await reactor.react('om_msg123');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Token request
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ app_id: 'app-id', app_secret: 'app-secret' }),
      }),
    );
    // Reaction request
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_msg123/reactions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token-abc',
        },
        body: JSON.stringify({ reaction_type: { emoji_type: 'OnIt' } }),
      }),
    );
  });

  it('does not throw on token fetch failure (best-effort)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    await expect(reactor.react('om_msg123')).resolves.toBeUndefined();
  });

  it('does not throw on reaction API failure (best-effort)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 99, msg: 'some error' }),
      });

    await expect(reactor.react('om_msg123')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/lark-reactor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement LarkReactor**

```typescript
import { createLogger } from '@local-agent/shared';
import { LARK_TOKEN_URL, LARK_REACTION_URL_PREFIX } from '../constants';

const logger = createLogger('lark-listener:reactor');

export class LarkReactor {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  /**
   * Add an "OnIt" emoji reaction to a message. Best-effort — errors are logged and swallowed.
   */
  async react(messageId: string): Promise<void> {
    try {
      const token = await this.fetchTenantToken();

      const res = await fetch(`${LARK_REACTION_URL_PREFIX}/${messageId}/reactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reaction_type: { emoji_type: 'OnIt' } }),
      });

      const data = (await res.json()) as { code: number; msg?: string };
      if (data.code !== 0) {
        logger.warn({ messageId, code: data.code, msg: data.msg }, 'Reaction API returned non-zero code');
      }
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to add reaction (best-effort)');
    }
  }

  private async fetchTenantToken(): Promise<string> {
    const res = await fetch(LARK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const data = (await res.json()) as { tenant_access_token: string; code: number };
    if (data.code !== 0) {
      throw new Error(`Lark token request failed with code ${data.code}`);
    }
    return data.tenant_access_token;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/lark-reactor.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/adapters/lark-reactor.ts packages/daemon/lark-listener/src/__tests__/lark-reactor.test.ts
git commit -m "feat(lark-listener): add LarkReactor for OnIt emoji acknowledgment"
```

---

## Task 5: Message handler (core logic)

**Files:**
- Create: `packages/daemon/lark-listener/src/message-handler.ts`
- Create: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`

### Steps

- [ ] **Step 1: Write message handler tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageHandler } from '../message-handler';
import type { TaskSubmitter } from '../adapters/task-submitter';
import type { LarkReactor } from '../adapters/lark-reactor';
import type { DedupMap } from '../services/dedup';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    sender: {
      sender_id: { open_id: 'ou_sender1' },
      sender_type: 'user',
    },
    message: {
      message_id: 'om_msg1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'fix the CI pipeline' }),
      mentions: [],
      ...overrides,
    },
  };
}

describe('MessageHandler', () => {
  let handler: MessageHandler;
  let submitter: { submit: ReturnType<typeof vi.fn> };
  let reactor: { react: ReturnType<typeof vi.fn> };
  let dedup: { has: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    submitter = { submit: vi.fn().mockResolvedValue('task-abc') };
    reactor = { react: vi.fn().mockResolvedValue(undefined) };
    dedup = { has: vi.fn().mockReturnValue(false), add: vi.fn() };
    handler = new MessageHandler(
      submitter as unknown as TaskSubmitter,
      reactor as unknown as LarkReactor,
      dedup as unknown as DedupMap,
    );
  });

  it('submits text message as plain string payload', async () => {
    await handler.handle(makeEvent());

    expect(submitter.submit).toHaveBeenCalledWith('fix the CI pipeline');
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    expect(dedup.add).toHaveBeenCalledWith('om_msg1');
  });

  it('skips duplicate messages', async () => {
    dedup.has.mockReturnValue(true);

    await handler.handle(makeEvent());

    expect(submitter.submit).not.toHaveBeenCalled();
    expect(reactor.react).not.toHaveBeenCalled();
  });

  it('submits image message as JSON payload', async () => {
    await handler.handle(
      makeEvent({
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_abc' }),
      }),
    );

    const payload = submitter.submit.mock.calls[0][0];
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe('image');
    expect(parsed.key).toBe('img_v3_abc');
  });

  it('submits file message as JSON payload', async () => {
    await handler.handle(
      makeEvent({
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_v3_xyz', file_name: 'report.pdf' }),
      }),
    );

    const payload = submitter.submit.mock.calls[0][0];
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe('file');
    expect(parsed.key).toBe('file_v3_xyz');
    expect(parsed.name).toBe('report.pdf');
  });

  it('submits post (rich text) message as JSON payload', async () => {
    const postContent = { title: 'Title', content: [[{ tag: 'text', text: 'hello' }]] };
    await handler.handle(
      makeEvent({
        message_type: 'post',
        content: JSON.stringify(postContent),
      }),
    );

    const payload = submitter.submit.mock.calls[0][0];
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe('post');
    expect(parsed.content).toEqual(postContent);
  });

  it('submits unknown message type as JSON with raw content', async () => {
    await handler.handle(
      makeEvent({
        message_type: 'sticker',
        content: JSON.stringify({ sticker_id: 'sticker_abc' }),
      }),
    );

    const payload = submitter.submit.mock.calls[0][0];
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe('sticker');
  });

  it('still reacts even if submit returns null (failure)', async () => {
    submitter.submit.mockResolvedValue(null);

    await handler.handle(makeEvent());

    // React is still called (we tried, task submission just failed)
    expect(dedup.add).toHaveBeenCalledWith('om_msg1');
  });

  it('handles malformed content JSON gracefully', async () => {
    await handler.handle(
      makeEvent({ content: 'not json' }),
    );

    // Should still attempt to submit with fallback
    expect(submitter.submit).toHaveBeenCalled();
    const payload = submitter.submit.mock.calls[0][0];
    expect(payload).toBe('not json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement MessageHandler**

```typescript
import { createLogger } from '@local-agent/shared';
import type { TaskSubmitter } from './adapters/task-submitter';
import type { LarkReactor } from './adapters/lark-reactor';
import type { DedupMap } from './services/dedup';

const logger = createLogger('lark-listener:handler');

interface LarkMessageEvent {
  sender: {
    sender_id: { open_id: string };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{ key: string; name: string; id: { open_id: string } }>;
  };
}

export class MessageHandler {
  constructor(
    private readonly submitter: TaskSubmitter,
    private readonly reactor: LarkReactor,
    private readonly dedup: DedupMap,
  ) {}

  async handle(event: LarkMessageEvent): Promise<void> {
    const { message } = event;
    const { message_id, message_type } = message;

    if (this.dedup.has(message_id)) {
      logger.debug({ message_id }, 'Duplicate message, skipping');
      return;
    }

    this.dedup.add(message_id);

    const payload = this.buildPayload(message_type, message.content);

    logger.info(
      { message_id, message_type, chat_type: message.chat_type, sender: event.sender.sender_id.open_id },
      'Processing message',
    );

    const taskId = await this.submitter.submit(payload);

    if (taskId) {
      logger.info({ message_id, task_id: taskId }, 'Task enqueued');
    } else {
      logger.error({ message_id }, 'Failed to enqueue task');
    }

    await this.reactor.react(message_id);
  }

  private buildPayload(messageType: string, content: string): string {
    if (messageType === 'text') {
      return this.extractText(content);
    }

    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(this.buildStructuredPayload(messageType, parsed));
    } catch {
      // If content is not valid JSON, return as-is
      return content;
    }
  }

  private extractText(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return parsed.text ?? content;
    } catch {
      return content;
    }
  }

  private buildStructuredPayload(
    messageType: string,
    parsed: Record<string, unknown>,
  ): Record<string, unknown> {
    switch (messageType) {
      case 'image':
        return { type: 'image', key: parsed.image_key };
      case 'file':
        return { type: 'file', key: parsed.file_key, name: parsed.file_name };
      case 'audio':
        return { type: 'audio', key: parsed.file_key };
      case 'post':
        return { type: 'post', content: parsed };
      default:
        return { type: messageType, ...parsed };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts
git commit -m "feat(lark-listener): add MessageHandler with multi-type payload support"
```

---

## Task 6: Entry point and WebSocket wiring

**Files:**
- Create: `packages/daemon/lark-listener/src/index.ts`

### Steps

- [ ] **Step 1: Implement entry point**

```typescript
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@local-agent/shared';
import { loadLarkListenerConfig } from './config';
import { MessageHandler } from './message-handler';
import { TaskSubmitter } from './adapters/task-submitter';
import { LarkReactor } from './adapters/lark-reactor';
import { DedupMap } from './services/dedup';

async function main() {
  const config = loadLarkListenerConfig();
  const logger = createLogger('lark-listener', config.logLevel);

  if (!config.appId?.trim() || !config.appSecret?.trim()) {
    logger.fatal('LARK_APP_ID and LARK_APP_SECRET must be set and non-empty');
    process.exit(1);
  }

  logger.info({ apiUrl: config.apiUrl }, 'Starting lark-listener daemon');

  const submitter = new TaskSubmitter(config.apiUrl);
  const reactor = new LarkReactor(config.appId, config.appSecret);
  const dedup = new DedupMap({ ttlMs: config.dedupTtlMs });
  const handler = new MessageHandler(submitter, reactor, dedup);

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      try {
        await handler.handle(data as Parameters<typeof handler.handle>[0]);
      } catch (err) {
        logger.error({ err }, 'Unhandled error in message handler');
      }
    },
  });

  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  wsClient.start({ eventDispatcher });
  logger.info('WebSocket client started, listening for messages');

  const shutdown = () => {
    logger.info('Shutting down lark-listener daemon...');
    dedup.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('lark-listener');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
```

- [ ] **Step 2: Verify build succeeds**

```bash
cd packages/daemon/lark-listener && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Run all tests**

```bash
cd packages/daemon/lark-listener && npx vitest run
```

Expected: All tests pass (config: 2, dedup: 4, task-submitter: 4, lark-reactor: 3, message-handler: 8 = 21 tests).

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/lark-listener/src/index.ts
git commit -m "feat(lark-listener): add entry point with WSClient wiring and graceful shutdown"
```

---

## Task 7: Dockerfile

**Files:**
- Create: `packages/daemon/lark-listener/Dockerfile`

### Steps

- [ ] **Step 1: Create Dockerfile**

Follow the same multi-stage pattern as `packages/daemon/lark-result/Dockerfile`:

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/daemon/lark-listener/package.json packages/daemon/lark-listener/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/daemon/task/package.json packages/daemon/task/package.json
COPY packages/daemon/lark-result/package.json packages/daemon/lark-result/package.json
COPY packages/daemon/telegram-result/package.json packages/daemon/telegram-result/package.json
COPY packages/daemon/task-enrichment/package.json packages/daemon/task-enrichment/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/lark-listener-daemon

COPY packages/shared/ packages/shared/
COPY packages/daemon/lark-listener/ packages/daemon/lark-listener/

RUN cd packages/shared && npx tsc
RUN cd packages/daemon/lark-listener && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/daemon/lark-listener/package.json packages/daemon/lark-listener/package.json
COPY --from=builder /app/packages/daemon/lark-listener/dist/ packages/daemon/lark-listener/dist/
COPY --from=builder /app/packages/daemon/lark-listener/node_modules/ packages/daemon/lark-listener/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/daemon/lark-listener

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Commit**

```bash
git add packages/daemon/lark-listener/Dockerfile
git commit -m "feat(lark-listener): add Dockerfile"
```

---

## Task 8: Docker Compose and Zellij layout

**Files:**
- Modify: `docker-compose.yml`
- Modify: `zellij-dev-layout.kdl`

### Steps

- [ ] **Step 1: Add service to `docker-compose.yml`**

Add after the `telegram-result-daemon` service block:

```yaml
  lark-listener-daemon:
    build:
      context: .
      dockerfile: packages/daemon/lark-listener/Dockerfile
    environment:
      API_URL: http://api:3000
      LOG_LEVEL: info
      LARK_APP_ID: ${LARK_APP_ID}
      LARK_APP_SECRET: ${LARK_APP_SECRET}
    depends_on:
      api:
        condition: service_started
    profiles:
      - lark-listener-daemon
      - full
    restart: unless-stopped
```

Note: No RabbitMQ dependency needed — this daemon only talks to the API, not directly to RabbitMQ.

- [ ] **Step 2: Update `zellij-dev-layout.kdl`**

Update the bottom row to add a "Lark Listener" pane. Change the bottom row from 3 panes to 4:

```kdl
        // Bottom row: notification daemons + scratch terminal
        pane split_direction="vertical" size="50%" {
            pane name="Lark Result" size="25%" {
                command "npm"
                args "run" "dev" "--prefix" "packages/daemon/lark-result"
            }
            pane name="Lark Listener" size="25%" {
                command "npm"
                args "run" "dev" "--prefix" "packages/daemon/lark-listener"
            }
            pane name="Telegram" size="25%" {
                command "npm"
                args "run" "dev" "--prefix" "packages/daemon/telegram-result"
            }
            pane name="Shell" size="25%" focus=true
        }
```

Note: The existing "Lark" pane is renamed to "Lark Result" for clarity now that there are two Lark daemons.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml zellij-dev-layout.kdl
git commit -m "feat(lark-listener): add to docker-compose and zellij dev layout"
```

---

## Task 9: Final verification

### Steps

- [ ] **Step 1: Run all tests across the monorepo**

```bash
cd /Users/bytedance/.ows/workspaces/personal_productivity/LocalAgent
cd packages/daemon/lark-listener && npx vitest run
```

Expected: All 21 tests pass.

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
cd packages/daemon/lark-listener && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Verify rush build**

```bash
cd /Users/bytedance/.ows/workspaces/personal_productivity/LocalAgent
node common/scripts/install-run-rush.js build
```

Expected: All projects build successfully.
