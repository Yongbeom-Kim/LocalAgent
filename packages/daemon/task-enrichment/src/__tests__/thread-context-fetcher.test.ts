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
              thread_id: 'omt_root_thread',
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

  it('returns kind not_thread when message has no root_id (not a thread reply)', async () => {
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
    expect(result).toMatchObject({ kind: 'not_thread' });
  });

  it('returns kind not_thread when root_id equals message_id (message is the thread root)', async () => {
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
    expect(result).toMatchObject({ kind: 'not_thread' });
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
    expect(result!.threadContext).toBe('user: fix the CI pipeline\nassistant: Job abc — success');
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
    expect(result!.threadContext).toBe('user: original question');
    expect(result!.threadContext).not.toContain('follow up');
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
    expect(result!.threadContext).toBe('assistant: bot message');
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
    expect(result!.threadContext).toBe('user: page 1 message\nassistant: page 2 message');
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
    expect(result!.threadContext).toBe('user: [Image: img_v3_abc]');
  });

  it('returns kind error on API failure after retries', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await fetcher.fetchThreadContext('om_msg1');
    expect(result).toMatchObject({ kind: 'error' });
    expect(result.reason).toMatch(/failed/i);
    // 3 retries x 1 fetch per retry attempt (token fetch fails each time)
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('returns kind error when token request returns non-zero code', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ code: 99, msg: 'invalid credentials' }),
    });

    const result = await fetcher.fetchThreadContext('om_msg1');
    expect(result).toMatchObject({ kind: 'error' });
  });

  it('returns kind error when token request returns non-OK HTTP status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });

    const result = await fetcher.fetchThreadContext('om_msg1');
    expect(result).toMatchObject({ kind: 'error' });
  });
});

describe('task_type extraction from thread messages', () => {
  let fetcher: ThreadContextFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new ThreadContextFetcher(APP_ID, APP_SECRET);
  });

  it('extracts task_type from first bot message with valid tag', async () => {
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
            body: { content: JSON.stringify({ text: 'deploy the app' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'task_type: deploy\nJob abc — success' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'check status' }) },
          },
        ]),
      );

    const validTypes = new Set(['deploy', 'code_review', 'default']);
    const result = await fetcher.fetchThreadContext('om_new_msg', validTypes);

    expect(result).not.toBeNull();
    expect(result!.inheritedTaskType).toBe('deploy');
  });

  it('skips bot messages with invalid task_type and uses next valid one', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot1',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'task_type: nonexistent\nJob 1 — success' }) },
          },
          {
            message_id: 'om_bot2',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'task_type: deploy\nJob 2 — success' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const validTypes = new Set(['deploy', 'default']);
    const result = await fetcher.fetchThreadContext('om_new_msg', validTypes);

    expect(result).not.toBeNull();
    expect(result!.inheritedTaskType).toBe('deploy');
  });

  it('returns null inheritedTaskType when no bot message has valid tag', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
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
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const validTypes = new Set(['deploy', 'default']);
    const result = await fetcher.fetchThreadContext('om_new_msg', validTypes);

    expect(result).not.toBeNull();
    expect(result!.inheritedTaskType).toBeNull();
    expect(result!.threadContext).toBe('user: hello\nassistant: Job abc — success');
  });

  it('does not extract task_type when validTaskTypes is not provided', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'task_type: deploy\nJob abc — success' }) },
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

    expect(result).not.toBeNull();
    expect(result!.inheritedTaskType).toBeNull();
  });

  it('ignores task_type tags in user messages', async () => {
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
            body: { content: JSON.stringify({ text: 'task_type: deploy' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const validTypes = new Set(['deploy', 'default']);
    const result = await fetcher.fetchThreadContext('om_new_msg', validTypes);

    expect(result).not.toBeNull();
    expect(result!.inheritedTaskType).toBeNull();
  });
});

describe('task_type line stripping from thread context', () => {
  let fetcher: ThreadContextFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new ThreadContextFetcher(APP_ID, APP_SECRET);
  });

  it('strips task_type line from bot message in thread context', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'task_type: deploy\nJob abc — success' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const validTypes = new Set(['deploy']);
    const result = await fetcher.fetchThreadContext('om_new_msg', validTypes);

    expect(result).not.toBeNull();
    expect(result!.threadContext).toBe('user: hello\nassistant: Job abc — success');
    expect(result!.threadContext).not.toContain('task_type:');
  });

  it('strips task_type line even when validTaskTypes is not provided', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'task_type: deploy\nJob abc — success' }) },
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

    expect(result).not.toBeNull();
    expect(result!.threadContext).not.toContain('task_type:');
  });
});

describe('session_id extraction and stripping from thread messages', () => {
  let fetcher: ThreadContextFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new ThreadContextFetcher(APP_ID, APP_SECRET);
  });

  it('extracts session_id from first bot message with valid UUIDv7 tag', async () => {
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
            body: { content: JSON.stringify({ text: 'deploy the app' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'session_id: 018f6b7e-1234-7abc-8def-1234567890ab\nJob abc — success',
              }),
            },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'check status' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');

    expect(result).not.toBeNull();
    expect(result!.inheritedSessionId).toBe('018f6b7e-1234-7abc-8def-1234567890ab');
  });

  it('returns null inheritedSessionId when no bot message has session_id', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
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
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');

    expect(result).not.toBeNull();
    expect(result!.inheritedSessionId).toBeNull();
  });

  it('ignores user messages with session_id tags', async () => {
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
            body: {
              content: JSON.stringify({
                text: 'session_id: 018f6b7e-1234-7abc-8def-1234567890ab\nhello',
              }),
            },
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

    expect(result).not.toBeNull();
    expect(result!.inheritedSessionId).toBeNull();
  });

  it('ignores malformed non-UUIDv7 session_id', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'session_id: 018f6b7e-1234-6abc-8def-1234567890ab\nJob abc — success',
              }),
            },
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

    expect(result).not.toBeNull();
    expect(result!.inheritedSessionId).toBeNull();
  });

  it('strips valid UUIDv7 session_id lines from thread context', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'task_type: deploy\nsession_id: 018f6b7e-1234-7abc-8def-1234567890ab\nJob abc — success',
              }),
            },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const validTypes = new Set(['deploy']);
    const result = await fetcher.fetchThreadContext('om_new_msg', validTypes);

    expect(result).not.toBeNull();
    expect(result!.threadContext).toBe('user: hello\nassistant: Job abc — success');
    expect(result!.threadContext).not.toContain('session_id:');
  });

  it('preserves malformed session_id lines in thread context', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'session_id: 018f6b7e-1234-6abc-8def-1234567890ab\nJob abc — success',
              }),
            },
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

    expect(result).not.toBeNull();
    expect(result!.threadContext).toContain('session_id: 018f6b7e-1234-6abc-8def-1234567890ab');
  });
});

describe('executor/model extraction from thread messages', () => {
  let fetcher: ThreadContextFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new ThreadContextFetcher(APP_ID, APP_SECRET);
  });

  it('extracts the most recent valid executor/model pair from bot replies', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_old',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'executor: claude\nmodel: sonnet\nJob old',
              }),
            },
          },
          {
            message_id: 'om_bot_new',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'executor: cursor\nmodel: gpt-5.4-medium-fast\nJob new',
              }),
            },
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
    expect(result!.inheritedExecutor).toBe('cursor');
    expect(result!.inheritedExecutorModel).toBe('gpt-5.4-medium-fast');
  });

  it('trims executor/model values before validation', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'executor: claude\nmodel:   sonnet  \nJob',
              }),
            },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');
    expect(result!.inheritedExecutor).toBe('claude');
    expect(result!.inheritedExecutorModel).toBe('sonnet');
  });

  it('strips executor/model lines from formatted threadContext', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'executor: claude\nmodel: sonnet\nbody text',
              }),
            },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');
    expect(result!.threadContext).not.toContain('executor:');
    expect(result!.threadContext).not.toContain('model:');
  });

  it('extracts executor/model from the full message list before applying the /new fence', async () => {
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
            body: { content: JSON.stringify({ text: 'start' }) },
          },
          {
            message_id: 'om_bot_pair',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'executor: claude\nmodel: sonnet\nearlier reply',
              }),
            },
          },
          {
            message_id: 'om_user_new',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '/new' }) },
          },
          {
            message_id: 'om_bot_fence',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'New session instance started.',
              }),
            },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'after fence' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');
    expect(result!.inheritedExecutor).toBe('claude');
    expect(result!.inheritedExecutorModel).toBe('sonnet');
    expect(result!.threadContext).toBe('assistant: New session instance started.');
  });
});
