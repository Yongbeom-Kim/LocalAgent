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
