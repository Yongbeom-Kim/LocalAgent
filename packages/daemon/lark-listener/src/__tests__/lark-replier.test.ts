import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { LarkReplier } from '../adapters/lark-replier';

describe('LarkReplier', () => {
  let replier: LarkReplier;

  beforeEach(() => {
    vi.clearAllMocks();
    replier = new LarkReplier('app-id', 'app-secret');
  });

  it('fetches tenant token and replies in thread', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await replier.reply('om_msg123', 'Usage: /task <type> <payload>');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_msg123/reply',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer token-abc',
        }),
        body: JSON.stringify({
          msg_type: 'text',
          content: JSON.stringify({ text: 'Usage: /task <type> <payload>' }),
          reply_in_thread: true,
        }),
      }),
    );
  });

  it('does not throw on token fetch failure (best-effort)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    await expect(replier.reply('om_msg123', 'hello')).resolves.toBeUndefined();
  });

  it('does not throw on reply API failure (best-effort)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 99 }),
      });

    await expect(replier.reply('om_msg123', 'hello')).resolves.toBeUndefined();
  });
});
