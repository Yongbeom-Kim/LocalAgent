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
    // 3 retries x 1 fetch per retry attempt (token fetch fails each time)
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

  it('returns null when token request returns non-OK HTTP status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    });

    const result = await fetcher.fetchThreadContext('om_msg1');
    expect(result).toBeNull();
  });
});
