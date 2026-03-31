# Thread Context Enrichment Implementation Plan

**Goal:** During enrichment, detect Lark thread replies and prepend the full thread history to the task payload so executors have conversational context.

**Architecture:** A new `ThreadContextFetcher` class in the enrichment daemon calls the Lark Open API to (1) check if a message has a `root_id` (is in a thread), and (2) fetch all thread messages. Messages are formatted as a chat-like transcript (`user: ...` / `assistant: ...`) and prepended to the payload. The `EnrichmentPoller` calls the fetcher before passing the task to `EnrichmentService`. A shared `extractLarkMessageContent` utility handles content extraction for both `ThreadContextFetcher` and `MessageHandler`.

**Tech Stack:** TypeScript, Vitest, Lark Open API (REST)

**Design Doc:** `docs/development/design/2026-03-31-thread-context-enrichment-design.md`

---

### Task 1: Add shared extractLarkMessageContent utility

**Files:**
- Create: `packages/shared/src/lark-content.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create test file `packages/shared/src/__tests__/lark-content.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractLarkMessageContent } from '../lark-content';

describe('extractLarkMessageContent', () => {
  it('extracts text from text message', () => {
    const content = JSON.stringify({ text: 'hello world' });
    expect(extractLarkMessageContent('text', content)).toBe('hello world');
  });

  it('returns raw content when text message has invalid JSON', () => {
    expect(extractLarkMessageContent('text', 'not json')).toBe('not json');
  });

  it('returns image placeholder for image message', () => {
    const content = JSON.stringify({ image_key: 'img_v3_abc' });
    expect(extractLarkMessageContent('image', content)).toBe('[Image: img_v3_abc]');
  });

  it('returns file placeholder for file message', () => {
    const content = JSON.stringify({ file_key: 'file_v3_xyz', file_name: 'report.pdf' });
    expect(extractLarkMessageContent('file', content)).toBe('[File: report.pdf]');
  });

  it('returns audio placeholder for audio message', () => {
    const content = JSON.stringify({ file_key: 'file_v3_audio' });
    expect(extractLarkMessageContent('audio', content)).toBe('[Audio message]');
  });

  it('extracts text from post (rich text) message', () => {
    const content = JSON.stringify({
      title: 'My Post',
      content: [
        [{ tag: 'text', text: 'Hello ' }, { tag: 'text', text: 'world' }],
        [{ tag: 'text', text: 'Second paragraph' }, { tag: 'a', text: 'link', href: 'https://example.com' }],
      ],
    });
    expect(extractLarkMessageContent('post', content)).toBe('Hello world\nSecond paragraph link');
  });

  it('returns empty string for post with no text elements', () => {
    const content = JSON.stringify({ title: 'Empty', content: [[{ tag: 'img', image_key: 'abc' }]] });
    expect(extractLarkMessageContent('post', content)).toBe('');
  });

  it('returns generic placeholder for unknown message type', () => {
    const content = JSON.stringify({ sticker_id: 'abc' });
    expect(extractLarkMessageContent('sticker', content)).toBe('[sticker message]');
  });

  it('handles malformed JSON for non-text types gracefully', () => {
    expect(extractLarkMessageContent('image', 'not json')).toBe('[image message]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/__tests__/lark-content.test.ts`
Expected: FAIL — `extractLarkMessageContent` is not found

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/lark-content.ts`:

```typescript
/**
 * Extracts a human-readable string from a Lark message based on its type.
 * Used by ThreadContextFetcher (all types) and MessageHandler (text type only).
 */
export function extractLarkMessageContent(msgType: string, content: string): string {
  if (msgType === 'text') {
    return extractText(content);
  }

  try {
    const parsed = JSON.parse(content);
    switch (msgType) {
      case 'image':
        return `[Image: ${parsed.image_key}]`;
      case 'file':
        return `[File: ${parsed.file_name}]`;
      case 'audio':
        return '[Audio message]';
      case 'post':
        return extractPostText(parsed);
      default:
        return `[${msgType} message]`;
    }
  } catch {
    return `[${msgType} message]`;
  }
}

function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return parsed.text ?? content;
  } catch {
    return content;
  }
}

function extractPostText(parsed: Record<string, unknown>): string {
  const contentArray = parsed.content;
  if (!Array.isArray(contentArray)) return '';

  return contentArray
    .map((paragraph: unknown[]) => {
      if (!Array.isArray(paragraph)) return '';
      return paragraph
        .filter((el: any) => typeof el.text === 'string')
        .map((el: any) => el.text)
        .join('');
    })
    .filter(Boolean)
    .join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/__tests__/lark-content.test.ts`
Expected: PASS — all 9 tests pass

- [ ] **Step 5: Export from shared index**

Add to `packages/shared/src/index.ts`:

```typescript
export { extractLarkMessageContent } from './lark-content';
```

- [ ] **Step 6: Verify shared package builds**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/lark-content.ts packages/shared/src/__tests__/lark-content.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add extractLarkMessageContent utility for human-readable Lark message extraction"
```

---

### Task 2: Refactor MessageHandler.extractText to use shared utility

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts:59-80`
- Modify: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`

- [ ] **Step 1: Run existing tests to verify they pass before refactor**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: PASS — all 8 tests pass (baseline)

- [ ] **Step 2: Refactor MessageHandler to use shared utility for text extraction**

In `packages/daemon/lark-listener/src/message-handler.ts`, add import:

```typescript
import { createLogger, type TaskSource, extractLarkMessageContent } from '@local-agent/shared';
```

Replace the `extractText` method (lines 73-80):

```typescript
  private extractText(content: string): string {
    return extractLarkMessageContent('text', content);
  }
```

- [ ] **Step 3: Run tests to verify they still pass**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: PASS — all 8 tests pass (no behavioral change)

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts
git commit -m "refactor(lark-listener): use shared extractLarkMessageContent for text extraction"
```

---

### Task 3: Add Lark credentials to enrichment daemon config

**Files:**
- Modify: `packages/daemon/task-enrichment/src/config.ts:11-27`

- [ ] **Step 1: Update config interface and loader**

In `packages/daemon/task-enrichment/src/config.ts`, update the interface:

```typescript
export interface EnrichmentDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  enrichmentConfigPath: string;
  larkAppId?: string;
  larkAppSecret?: string;
}
```

Update the `loadEnrichmentDaemonConfig` return:

```typescript
  return {
    apiUrl: env.API_URL ?? DEFAULT_API_URL,
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    enrichmentConfigPath: env.ENRICHMENT_CONFIG_PATH ?? DEFAULT_ENRICHMENT_CONFIG_PATH,
    larkAppId: env.LARK_APP_ID,
    larkAppSecret: env.LARK_APP_SECRET,
  };
```

- [ ] **Step 2: Verify build**

Run: `cd packages/daemon/task-enrichment && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/task-enrichment/src/config.ts
git commit -m "feat(enrichment): add optional larkAppId/larkAppSecret to config"
```

---

### Task 4: Implement ThreadContextFetcher

**Files:**
- Create: `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`

- [ ] **Step 1: Write the failing test**

Create test file `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { ThreadContextFetcher } from '../adapters/thread-context-fetcher';

const APP_ID = 'cli_test_app';
const APP_SECRET = 'test_secret';

function mockTokenResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
  };
}

function mockMessageResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        code: 0,
        data: {
          items: [
            {
              message_id: 'om_new_msg',
              root_id: 'om_root_msg',
              parent_id: 'om_root_msg',
              sender: { sender_type: 'user' },
              msg_type: 'text',
              body: { content: JSON.stringify({ text: 'follow up' }) },
              ...overrides,
            },
          ],
        },
      }),
  };
}

function mockThreadMessagesResponse(
  items: Array<Record<string, unknown>>,
  hasMore = false,
  pageToken?: string,
) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        code: 0,
        data: {
          items,
          has_more: hasMore,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
  };
}

describe('ThreadContextFetcher', () => {
  let fetcher: ThreadContextFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new ThreadContextFetcher(APP_ID, APP_SECRET);
  });

  it('returns null when message has no root_id (not a thread reply)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            code: 0,
            data: {
              items: [
                {
                  message_id: 'om_msg1',
                  sender: { sender_type: 'user' },
                  msg_type: 'text',
                  body: { content: JSON.stringify({ text: 'hello' }) },
                },
              ],
            },
          }),
      });

    const result = await fetcher.fetchThreadContext('om_msg1');
    expect(result).toBeNull();
  });

  it('returns null when root_id equals message_id (message is the thread root)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            code: 0,
            data: {
              items: [
                {
                  message_id: 'om_msg1',
                  root_id: 'om_msg1',
                  sender: { sender_type: 'user' },
                  msg_type: 'text',
                  body: { content: JSON.stringify({ text: 'hello' }) },
                },
              ],
            },
          }),
      });

    const result = await fetcher.fetchThreadContext('om_msg1');
    expect(result).toBeNull();
  });

  it('fetches thread messages and formats as chat context', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse()) // token for getMessage
      .mockResolvedValueOnce(mockMessageResponse()) // getMessage — has root_id
      .mockResolvedValueOnce(mockTokenResponse()) // token for listMessages
      .mockResolvedValueOnce(
        mockThreadMessagesResponse([
          {
            message_id: 'om_root_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'fix the CI pipeline' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'Job abc — success' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'now fix the tests' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');
    expect(result).toBe('user: fix the CI pipeline\nassistant: Job abc — success');
  });

  it('excludes the current message from thread context', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockMessageResponse())
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(
        mockThreadMessagesResponse([
          {
            message_id: 'om_root_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'original question' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');
    expect(result).toBe('user: original question');
    expect(result).not.toContain('follow up');
  });

  it('labels non-user senders as assistant', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockMessageResponse())
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(
        mockThreadMessagesResponse([
          {
            message_id: 'om_root_msg',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'bot message' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');
    expect(result).toBe('assistant: bot message');
  });

  it('handles pagination (multiple pages)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockMessageResponse())
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(
        mockThreadMessagesResponse(
          [
            {
              message_id: 'om_root_msg',
              sender: { sender_type: 'user' },
              msg_type: 'text',
              body: { content: JSON.stringify({ text: 'page 1 message' }) },
            },
          ],
          true, // has_more
          'page_token_2',
        ),
      )
      .mockResolvedValueOnce(
        mockThreadMessagesResponse([
          {
            message_id: 'om_msg2',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'page 2 message' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');
    expect(result).toBe('user: page 1 message\nassistant: page 2 message');
  });

  it('handles non-text message types in thread', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockMessageResponse())
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(
        mockThreadMessagesResponse([
          {
            message_id: 'om_root_msg',
            sender: { sender_type: 'user' },
            msg_type: 'image',
            body: { content: JSON.stringify({ image_key: 'img_v3_abc' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');
    expect(result).toBe('user: [Image: img_v3_abc]');
  });

  it('returns null on API failure after retries', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await fetcher.fetchThreadContext('om_msg1');
    expect(result).toBeNull();
    // 3 retries × 1 fetch per retry attempt (token fetch fails each time)
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('returns null when token request returns non-zero code', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 99, msg: 'invalid credentials' }),
    });

    const result = await fetcher.fetchThreadContext('om_msg1');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts`
Expected: FAIL — `ThreadContextFetcher` is not found

- [ ] **Step 3: Write the implementation**

Create `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`:

```typescript
import { createLogger, extractLarkMessageContent } from '@local-agent/shared';

const logger = createLogger('enrichment-daemon:thread-context');

const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
const LARK_MESSAGE_URL = (messageId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}`;
const LARK_LIST_MESSAGES_URL = 'https://open.larksuite.com/open-apis/im/v1/messages';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

interface LarkMessage {
  message_id: string;
  sender: { sender_type: string };
  msg_type: string;
  body: { content: string };
}

export class ThreadContextFetcher {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  async fetchThreadContext(messageId: string): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.doFetch(messageId);
      } catch (err) {
        logger.warn({ messageId, attempt, err }, 'Thread context fetch attempt failed');
        if (attempt < MAX_RETRIES) {
          await this.sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1));
        }
      }
    }
    logger.warn({ messageId }, `Thread context fetch failed after ${MAX_RETRIES} retries — proceeding without context`);
    return null;
  }

  private async doFetch(messageId: string): Promise<string | null> {
    // Step 1: Get token and check if message is in a thread
    const token = await this.getToken();
    const rootId = await this.getRootId(messageId, token);

    if (!rootId) {
      return null;
    }

    // Step 2: Get fresh token and fetch thread messages
    const token2 = await this.getToken();
    const messages = await this.fetchAllThreadMessages(rootId, token2);

    // Step 3: Format, excluding the current message
    const filtered = messages.filter((m) => m.message_id !== messageId);

    if (filtered.length === 0) {
      return null;
    }

    return filtered
      .map((m) => {
        const role = m.sender.sender_type === 'user' ? 'user' : 'assistant';
        const content = extractLarkMessageContent(m.msg_type, m.body.content);
        return `${role}: ${content}`;
      })
      .join('\n');
  }

  private async getToken(): Promise<string> {
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

  private async getRootId(messageId: string, token: string): Promise<string | null> {
    const res = await fetch(LARK_MESSAGE_URL(messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as {
      code: number;
      data: { items: Array<{ message_id: string; root_id?: string }> };
    };
    if (data.code !== 0) {
      throw new Error(`Lark getMessage failed with code ${data.code}`);
    }
    const msg = data.data.items[0];
    if (!msg?.root_id || msg.root_id === messageId) {
      return null;
    }
    return msg.root_id;
  }

  private async fetchAllThreadMessages(rootId: string, token: string): Promise<LarkMessage[]> {
    const allMessages: LarkMessage[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(LARK_LIST_MESSAGES_URL);
      url.searchParams.set('container_id_type', 'thread');
      url.searchParams.set('container_id', rootId);
      url.searchParams.set('sort_type', 'ByCreateTimeAsc');
      if (pageToken) {
        url.searchParams.set('page_token', pageToken);
      }

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as {
        code: number;
        data: { items: LarkMessage[]; has_more?: boolean; page_token?: string };
      };
      if (data.code !== 0) {
        throw new Error(`Lark listMessages failed with code ${data.code}`);
      }

      allMessages.push(...data.data.items);
      pageToken = data.data.has_more ? data.data.page_token : undefined;
    } while (pageToken);

    return allMessages;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts`
Expected: PASS — all 9 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts
git commit -m "feat(enrichment): add ThreadContextFetcher for Lark thread history loading"
```

---

### Task 5: Integrate ThreadContextFetcher into EnrichmentPoller

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts:6-32`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Add tests for thread context integration**

Add to `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`:

Import the fetcher at the top (below existing imports):

```typescript
import { ThreadContextFetcher } from '../adapters/thread-context-fetcher';
```

Add a new describe block after the existing tests:

```typescript
describe('EnrichmentPoller with ThreadContextFetcher', () => {
  let poller: EnrichmentPoller;
  let mockThreadFetcher: { fetchThreadContext: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    const service = new EnrichmentService() as any;
    mockThreadFetcher = { fetchThreadContext: vi.fn() };
    poller = new EnrichmentPoller(
      'http://localhost:3000',
      service,
      mockThreadFetcher as unknown as ThreadContextFetcher,
    );
  });

  afterEach(() => {
    poller.stop();
  });

  it('prepends thread context to payload when task has lark source and thread exists', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'now fix the tests',
    });
    const jobSubmission = createJobSubmission({ payload: '--- Thread Context ---\nuser: fix CI\n--- Current Message ---\nnow fix the tests' });
    mockEnrich.mockReturnValue(jobSubmission);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue('user: fix CI');

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockThreadFetcher.fetchThreadContext).toHaveBeenCalledWith('om_msg1');
    expect(mockEnrich).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: '--- Thread Context ---\nuser: fix CI\n--- Current Message ---\nnow fix the tests',
      }),
    );
  });

  it('does not modify payload when task has no task_source', async () => {
    const task = createTask({ payload: 'hello' });
    const jobSubmission = createJobSubmission({ payload: 'hello' });
    mockEnrich.mockReturnValue(jobSubmission);

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockThreadFetcher.fetchThreadContext).not.toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }));
  });

  it('does not modify payload when fetchThreadContext returns null', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'hello',
    });
    const jobSubmission = createJobSubmission({ payload: 'hello' });
    mockEnrich.mockReturnValue(jobSubmission);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue(null);

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: FAIL — `EnrichmentPoller` constructor doesn't accept a third argument

- [ ] **Step 3: Update EnrichmentPoller**

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`:

Add import:

```typescript
import { Task, createLogger } from '@local-agent/shared';
import { EnrichmentService } from './enrichment-service';
import type { ThreadContextFetcher } from './adapters/thread-context-fetcher';
```

Update the constructor:

```typescript
  constructor(
    private readonly apiUrl: string,
    private readonly enrichmentService: EnrichmentService,
    private readonly threadContextFetcher?: ThreadContextFetcher,
  ) {}
```

In `pollOnce()`, add thread context enrichment between receiving the task and calling `enrich()`. Replace:

```typescript
      const task = (await res.json()) as Task;
      logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Received task for enrichment');

      const jobSubmission = this.enrichmentService.enrich(task);
```

With:

```typescript
      const task = (await res.json()) as Task;
      logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Received task for enrichment');

      if (this.threadContextFetcher && task.task_source?.source === 'lark') {
        const threadContext = await this.threadContextFetcher.fetchThreadContext(task.task_source.message_id);
        if (threadContext) {
          task.payload = `--- Thread Context ---\n${threadContext}\n--- Current Message ---\n${task.payload}`;
          logger.info({ task_id: task.task_id }, 'Prepended thread context to payload');
        }
      }

      const jobSubmission = this.enrichmentService.enrich(task);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: PASS — all tests pass (both existing and new)

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): integrate ThreadContextFetcher into EnrichmentPoller"
```

---

### Task 6: Wire ThreadContextFetcher in enrichment daemon entry point

**Files:**
- Modify: `packages/daemon/task-enrichment/src/index.ts`

- [ ] **Step 1: Update entry point to create ThreadContextFetcher when credentials available**

In `packages/daemon/task-enrichment/src/index.ts`:

Add import:

```typescript
import { ThreadContextFetcher } from './adapters/thread-context-fetcher';
```

Update `main()` to create the fetcher and pass it to the poller. Replace:

```typescript
  const poller = new EnrichmentPoller(config.apiUrl, enrichmentService);
```

With:

```typescript
  let threadContextFetcher: ThreadContextFetcher | undefined;
  if (config.larkAppId && config.larkAppSecret) {
    threadContextFetcher = new ThreadContextFetcher(config.larkAppId, config.larkAppSecret);
    logger.info('Thread context enrichment enabled (Lark credentials found)');
  } else {
    logger.info('Thread context enrichment disabled (LARK_APP_ID or LARK_APP_SECRET not set)');
  }

  const poller = new EnrichmentPoller(config.apiUrl, enrichmentService, threadContextFetcher);
```

- [ ] **Step 2: Verify build**

Run: `cd packages/daemon/task-enrichment && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/task-enrichment/src/index.ts
git commit -m "feat(enrichment): wire ThreadContextFetcher in daemon entry point"
```

---

### Task 7: Run full test suite and verify

- [ ] **Step 1: Run all tests across the project**

Run: `cd /Users/bytedance/.ows/workspaces/personal_productivity/LocalAgent && npx vitest run --reporter=verbose`

Expected: All tests pass, no regressions.

- [ ] **Step 2: Verify TypeScript builds for all affected packages**

Run:

```bash
cd packages/shared && npx tsc --noEmit
cd ../daemon/lark-listener && npx tsc --noEmit
cd ../task-enrichment && npx tsc --noEmit
```

Expected: No errors in any package.

- [ ] **Step 3: Final commit (if any fixes needed)**

Only if previous steps required fixes.
