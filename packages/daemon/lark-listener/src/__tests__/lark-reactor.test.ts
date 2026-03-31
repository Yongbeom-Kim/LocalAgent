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
