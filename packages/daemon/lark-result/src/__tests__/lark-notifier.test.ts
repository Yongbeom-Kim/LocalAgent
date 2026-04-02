import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskResult } from '@local-agent/shared';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { LarkNotifier } from '../adapters/lark-notifier';

function createResult(overrides?: Partial<TaskResult>): TaskResult {
  return {
    result_id: 'res-1',
    job_id: 'job-456',
    task_id: 'task-123',
    task_type: 'generic',
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

  it('includes job_id, task_id, status, and stdout in message', async () => {
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
    expect(content.text).toContain('job-456');
    expect(content.text).toContain('task-123');
    expect(content.text).toContain('success');
    expect(content.text).toContain('Output:\n');
  });

  it('includes task_type prefix line in reply text', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult({ task_type: 'deploy' }));

    const sendCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    const content = JSON.parse(body.content);
    expect(content.text).toContain('task_type: deploy');
  });

  it('prepends executor and model lines when both are present', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(
      createResult({
        executor: 'cursor_agent',
        executor_model: 'gpt-5.4-medium-fast',
      }),
    );

    const sendCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    const content = JSON.parse(body.content);
    expect(content.text).toContain('executor: cursor_agent');
    expect(content.text).toContain('model: gpt-5.4-medium-fast');
  });

  it('omits executor and model lines when executor metadata is absent', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult({ executor: undefined, executor_model: undefined }));

    const sendCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    const content = JSON.parse(body.content);
    expect(content.text).not.toContain('executor:');
    expect(content.text).not.toContain('model:');
  });

  it('includes session_id line when session_id is present', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult({ session_id: '0195f2d6-5d6d-7b8d-9f8d-123456789abc' }));

    const sendCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    const content = JSON.parse(body.content);
    expect(content.text).toContain('session_id: 0195f2d6-5d6d-7b8d-9f8d-123456789abc');
  });

  it('omits session_id line when session_id is absent', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult({ session_id: undefined }));

    const sendCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    const content = JSON.parse(body.content);
    expect(content.text).not.toContain('session_id:');
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

  it('replies in thread when task_source is lark', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { items: [] } }),
      });

    const result = createResult({
      task_source: { source: 'lark', message_id: 'om_original_msg' },
    });
    await notifier.notify(result);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Should call reply API, not send API
    expect(mockFetch).toHaveBeenNthCalledWith(2,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_original_msg/reply',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer token-abc',
        },
      }),
    );
    // Verify reply_in_thread is set
    const sendCall = mockFetch.mock.calls[1];
    const body = JSON.parse(sendCall[1].body);
    expect(body.reply_in_thread).toBe(true);
    expect(body.msg_type).toBe('text');
  });

  it('sends DM when task_source is not present (fallback)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult()); // no task_source

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Should call send API (existing DM behavior)
    expect(mockFetch).toHaveBeenNthCalledWith(2,
      'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  describe('reaction cleanup', () => {
    it('removes all reactions after successful thread reply', async () => {
      mockFetch
        // 1. Token fetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
        })
        // 2. Thread reply
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        // 3. List reactions
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            code: 0,
            data: {
              items: [
                { reaction_id: 'react-1' },
                { reaction_id: 'react-2' },
              ],
            },
          }),
        })
        // 4. Delete reaction 1
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        // 5. Delete reaction 2
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      await notifier.notify(result);

      expect(mockFetch).toHaveBeenCalledTimes(5);
      // Verify list reactions call
      expect(mockFetch).toHaveBeenNthCalledWith(3,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions?user_id_type=open_id',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer token-abc',
          }),
        }),
      );
      // Verify delete calls
      expect(mockFetch).toHaveBeenNthCalledWith(4,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions/react-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(5,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions/react-2',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('does not attempt reaction cleanup on DM fallback', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      await notifier.notify(createResult()); // no task_source
      expect(mockFetch).toHaveBeenCalledTimes(2); // only token + DM send
    });

    it('skips deletion when reaction list is empty', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0, data: { items: [] } }),
        });

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      await notifier.notify(result);

      expect(mockFetch).toHaveBeenCalledTimes(3); // token + reply + list reactions (no deletes)
    });

    it('continues notification when reaction list API fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        .mockRejectedValueOnce(new Error('Network error'));

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      // Should not throw — reaction cleanup is best-effort
      await expect(notifier.notify(result)).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('continues deleting remaining reactions when one DELETE fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            code: 0,
            data: {
              items: [
                { reaction_id: 'react-1' },
                { reaction_id: 'react-2' },
              ],
            },
          }),
        })
        // Delete react-1 fails
        .mockRejectedValueOnce(new Error('Network error'))
        // Delete react-2 succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      await expect(notifier.notify(result)).resolves.toBeUndefined();

      // Should still attempt to delete react-2 after react-1 fails
      expect(mockFetch).toHaveBeenCalledTimes(5);
      expect(mockFetch).toHaveBeenNthCalledWith(5,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions/react-2',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });
});
