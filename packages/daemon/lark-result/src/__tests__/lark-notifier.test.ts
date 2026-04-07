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
  let tokenProvider: { getTenantAccessToken: ReturnType<typeof vi.fn> };
  let sessionBridgeRepository: {
    getBridgeBySessionId: ReturnType<typeof vi.fn>;
    markBridgeEnded: ReturnType<typeof vi.fn>;
    deleteBridgeBySessionId: ReturnType<typeof vi.fn>;
  };
  let sessionRepository: {
    markSessionEnded: ReturnType<typeof vi.fn>;
    deleteSessionById: ReturnType<typeof vi.fn>;
  };
  let sessionPlatformLinkRepository: {
    markLinksEnded: ReturnType<typeof vi.fn>;
    deleteLinksBySessionId: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tokenProvider = {
      getTenantAccessToken: vi.fn().mockResolvedValue('token-abc'),
    };
    sessionBridgeRepository = {
      getBridgeBySessionId: vi.fn().mockResolvedValue(null),
      markBridgeEnded: vi.fn().mockResolvedValue(undefined),
      deleteBridgeBySessionId: vi.fn().mockResolvedValue(undefined),
    };
    sessionRepository = {
      markSessionEnded: vi.fn().mockResolvedValue(undefined),
      deleteSessionById: vi.fn().mockResolvedValue(undefined),
    };
    sessionPlatformLinkRepository = {
      markLinksEnded: vi.fn().mockResolvedValue(undefined),
      deleteLinksBySessionId: vi.fn().mockResolvedValue(undefined),
    };
    notifier = new LarkNotifier('app-id', 'app-secret', 'user-123', undefined, tokenProvider);
  });

  function createRepositoryMocks() {
    return {
      recordOutboundLarkMessage: vi.fn().mockResolvedValue(undefined),
      markLarkThreadNewInstance: vi.fn().mockResolvedValue(undefined),
      getLarkMessageByMessageId: vi.fn().mockResolvedValue(null),
      getLarkThreadByRootMessageId: vi.fn().mockResolvedValue(null),
      upsertLarkThreadState: vi.fn().mockResolvedValue(undefined),
      deleteLarkRowsBySessionId: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('persists outbound lark replies after successful send', async () => {
    const repository = createRepositoryMocks();
    const dbNotifier = new LarkNotifier(
      'app-id',
      'app-secret',
      'user-123',
      repository,
      tokenProvider,
      sessionBridgeRepository,
      sessionRepository,
      sessionPlatformLinkRepository,
    );

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { items: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { message_id: 'om_reply_1' } }),
      });

    await dbNotifier.notify(createResult({
      task_type: 'code_review',
      session_id: 'session_1',
      executor: 'cursor',
      executor_model: 'gpt-5.4-medium-fast',
      task_source: { source: 'lark', message_id: 'om_root_1' },
    }));

    expect(repository.recordOutboundLarkMessage).toHaveBeenCalledTimes(1);
    expect(repository.upsertLarkThreadState).toHaveBeenCalledWith(expect.objectContaining({
      rootMessageId: 'om_root_1',
      sessionId: 'session_1',
      taskType: 'code_review',
    }));
    expect(repository.recordOutboundLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_reply_1',
      source: 'lark',
      rootMessageId: 'om_root_1',
      sessionId: 'session_1',
      messageType: 'text',
    }));
  });

  it('updates thread executor/model on /new while preserving session_id', async () => {
    const repository = createRepositoryMocks();
    const dbNotifier = new LarkNotifier(
      'app-id',
      'app-secret',
      'user-123',
      repository,
      tokenProvider,
      sessionBridgeRepository,
      sessionRepository,
      sessionPlatformLinkRepository,
    );

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { items: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { message_id: 'om_reply_2' } }),
      });

    await dbNotifier.notify(createResult({
      task_type: 'new_instance',
      session_id: 'session_existing',
      executor: 'ttcodex',
      executor_model: 'gpt-5.4',
      task_source: { source: 'lark', message_id: 'om_root_2' },
    }));

    expect(repository.recordOutboundLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session_existing',
      metadataJson: expect.stringContaining('"event_kind":"new_instance_reply"'),
    }));
    expect(repository.markLarkThreadNewInstance).toHaveBeenCalledTimes(1);
    expect(repository.markLarkThreadNewInstance).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session_existing',
      executor: 'ttcodex',
      executorModel: 'gpt-5.4',
    }));
  });

  it('does not create a new session on /end replies', async () => {
    const repository = createRepositoryMocks();
    const dbNotifier = new LarkNotifier(
      'app-id',
      'app-secret',
      'user-123',
      repository,
      tokenProvider,
      sessionBridgeRepository,
      sessionRepository,
      sessionPlatformLinkRepository,
    );

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { items: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { message_id: 'om_reply_3' } }),
      });

    await dbNotifier.notify(createResult({
      task_type: 'cleanup',
      session_id: 'session_3',
      task_source: { source: 'lark', message_id: 'om_root_3' },
    }));

    expect(repository.recordOutboundLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session_3',
    }));
    expect(sessionRepository.markSessionEnded).toHaveBeenCalledWith('session_3', expect.any(Number));
    expect(sessionPlatformLinkRepository.markLinksEnded).toHaveBeenCalledWith('session_3', expect.any(Number));
    expect(repository.deleteLarkRowsBySessionId).toHaveBeenCalledWith('session_3');
    expect(sessionPlatformLinkRepository.deleteLinksBySessionId).toHaveBeenCalledWith('session_3');
    expect(sessionRepository.deleteSessionById).toHaveBeenCalledWith('session_3');
    expect(repository.markLarkThreadNewInstance).not.toHaveBeenCalled();
    expect(sessionBridgeRepository.getBridgeBySessionId).toHaveBeenCalledWith('session_3');
    expect(sessionBridgeRepository.markBridgeEnded).not.toHaveBeenCalled();
    expect(sessionBridgeRepository.deleteBridgeBySessionId).not.toHaveBeenCalled();
  });

  it('deletes shared bridge rows for /end replies when a bridge exists', async () => {
    const repository = createRepositoryMocks();
    sessionBridgeRepository.getBridgeBySessionId.mockResolvedValue({
      sessionId: 'session_3b',
      larkRootMessageId: 'om_root_3b',
      telegramChatId: '-100123',
      telegramTopicId: '77',
      createdAtMs: 10,
      updatedAtMs: 10,
      endedAtMs: null,
    });
    const dbNotifier = new LarkNotifier(
      'app-id',
      'app-secret',
      'user-123',
      repository,
      tokenProvider,
      sessionBridgeRepository,
      sessionRepository,
      sessionPlatformLinkRepository,
    );

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { items: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { message_id: 'om_reply_3b' } }),
      });

    await dbNotifier.notify(createResult({
      task_type: 'cleanup',
      session_id: 'session_3b',
      task_source: { source: 'lark', message_id: 'om_root_3b' },
    }));

    expect(sessionRepository.markSessionEnded).toHaveBeenCalledWith('session_3b', expect.any(Number));
    expect(sessionPlatformLinkRepository.markLinksEnded).toHaveBeenCalledWith('session_3b', expect.any(Number));
    expect(repository.deleteLarkRowsBySessionId).toHaveBeenCalledWith('session_3b');
    expect(sessionBridgeRepository.getBridgeBySessionId).toHaveBeenCalledWith('session_3b');
    expect(sessionBridgeRepository.markBridgeEnded).toHaveBeenCalledWith('session_3b', expect.any(Number));
    expect(sessionBridgeRepository.deleteBridgeBySessionId).toHaveBeenCalledWith('session_3b');
    expect(sessionPlatformLinkRepository.deleteLinksBySessionId).toHaveBeenCalledWith('session_3b');
    expect(sessionRepository.deleteSessionById).toHaveBeenCalledWith('session_3b');
  });

  it('still deletes lark rows for /end replies when session bridge repository is not provided', async () => {
    const repository = createRepositoryMocks();
    const dbNotifier = new LarkNotifier(
      'app-id',
      'app-secret',
      'user-123',
      repository,
      tokenProvider,
      undefined,
      sessionRepository,
      sessionPlatformLinkRepository,
    );

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { items: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { message_id: 'om_reply_3c' } }),
      });

    await dbNotifier.notify(createResult({
      task_type: 'cleanup',
      session_id: 'session_3c',
      task_source: { source: 'lark', message_id: 'om_root_3c' },
    }));

    expect(sessionRepository.markSessionEnded).toHaveBeenCalledWith('session_3c', expect.any(Number));
    expect(sessionPlatformLinkRepository.markLinksEnded).toHaveBeenCalledWith('session_3c', expect.any(Number));
    expect(repository.deleteLarkRowsBySessionId).toHaveBeenCalledWith('session_3c');
    expect(sessionPlatformLinkRepository.deleteLinksBySessionId).toHaveBeenCalledWith('session_3c');
    expect(sessionRepository.deleteSessionById).toHaveBeenCalledWith('session_3c');
  });

  it('promotes placeholder root thread rows to the real session_id on first successful reply', async () => {
    const repository = createRepositoryMocks();
    repository.getLarkMessageByMessageId.mockResolvedValue({
      messageId: 'om_root_4',
      source: 'lark',
      rootMessageId: 'om_root_4',
      sessionId: 'om_root_4',
      threadId: null,
      direction: 'inbound',
      senderType: 'user',
      messageType: 'text',
      rawContent: '{"text":"start"}',
      normalizedText: 'start',
      metadataJson: null,
      createdAtMs: 100,
    });
    repository.getLarkThreadByRootMessageId.mockResolvedValue({
      rootMessageId: 'om_root_4',
      threadId: null,
      sessionId: 'om_root_4',
      source: 'lark',
      chatType: 'p2p',
      taskType: 'thread_reply',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      createdAtMs: 100,
      updatedAtMs: 100,
      endedAtMs: null,
    });

    const dbNotifier = new LarkNotifier(
      'app-id',
      'app-secret',
      'user-123',
      repository,
      tokenProvider,
      sessionBridgeRepository,
      sessionRepository,
      sessionPlatformLinkRepository,
    );

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { items: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { message_id: 'om_reply_4' } }),
      });

    await dbNotifier.notify(createResult({
      task_type: 'deploy',
      session_id: 'session_real_4',
      executor: 'cursor',
      executor_model: 'gpt-5.4-medium-fast',
      task_source: { source: 'lark', message_id: 'om_root_4' },
    }));

    expect(repository.upsertLarkThreadState).toHaveBeenCalledWith(expect.objectContaining({
      rootMessageId: 'om_root_4',
      sessionId: 'session_real_4',
      executor: 'cursor',
      executorModel: 'gpt-5.4-medium-fast',
      taskType: 'deploy',
    }));
    expect(repository.recordOutboundLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      rootMessageId: 'om_root_4',
      sessionId: 'session_real_4',
    }));
  });

  it('fetches tenant access token and sends message on success', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult());

    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenNthCalledWith(1,
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
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult({ stdout: 'x'.repeat(3000) }));

    const sendCall = mockFetch.mock.calls[0];
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
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult({ task_type: 'deploy' }));

    const sendCall = mockFetch.mock.calls[0];
    const body = JSON.parse(sendCall[1].body);
    const content = JSON.parse(body.content);
    expect(content.text).toContain('task_type: deploy');
  });

  it('prepends executor and model lines when both are present', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(
      createResult({
        executor: 'cursor',
        executor_model: 'gpt-5.4-medium-fast',
      }),
    );

    const sendCall = mockFetch.mock.calls[0];
    const body = JSON.parse(sendCall[1].body);
    const content = JSON.parse(body.content);
    expect(content.text).toContain('executor: cursor');
    expect(content.text).toContain('model: gpt-5.4-medium-fast');
  });

  it('omits executor and model lines when executor metadata is absent', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult({ executor: undefined, executor_model: undefined }));

    const sendCall = mockFetch.mock.calls[0];
    const body = JSON.parse(sendCall[1].body);
    const content = JSON.parse(body.content);
    expect(content.text).not.toContain('executor:');
    expect(content.text).not.toContain('model:');
  });

  it('includes session_id line when session_id is present', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult({ session_id: '0195f2d6-5d6d-7b8d-9f8d-123456789abc' }));

    const sendCall = mockFetch.mock.calls[0];
    const body = JSON.parse(sendCall[1].body);
    const content = JSON.parse(body.content);
    expect(content.text).toContain('session_id: 0195f2d6-5d6d-7b8d-9f8d-123456789abc');
  });

  it('omits session_id line when session_id is absent', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult({ session_id: undefined }));

    const sendCall = mockFetch.mock.calls[0];
    const body = JSON.parse(sendCall[1].body);
    const content = JSON.parse(body.content);
    expect(content.text).not.toContain('session_id:');
  });

  it('retries up to 3 times on fetch failure then resolves', async () => {
    tokenProvider.getTenantAccessToken
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'));

    await expect(notifier.notify(createResult())).resolves.toBeUndefined();
    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  it('succeeds on retry after initial failure', async () => {
    tokenProvider.getTenantAccessToken
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce('token-abc');
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult());
    expect(tokenProvider.getTenantAccessToken).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('replies in thread when task_source is lark', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          code: 0,
          data: {
            open_id: 'ou_bot',
            items: [
              {
                reaction_id: 'react-1',
                reaction_type: { emoji_type: 'OK' },
                operator: { open_id: 'ou_bot' },
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    const result = createResult({
      task_source: { source: 'lark', message_id: 'om_original_msg' },
    });
    await notifier.notify(result);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(1,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_original_msg/reactions?user_id_type=open_id',
      expect.objectContaining({ method: 'GET' }),
    );
    // Should call reply API, not send API
    expect(mockFetch).toHaveBeenNthCalledWith(3,
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
    const sendCall = mockFetch.mock.calls[2];
    const body = JSON.parse(sendCall[1].body);
    expect(body.reply_in_thread).toBe(true);
    expect(body.msg_type).toBe('text');
  });

  it('sends DM when task_source is not present (fallback)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult()); // no task_source

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Should call send API (existing DM behavior)
    expect(mockFetch).toHaveBeenNthCalledWith(1,
      'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  describe('reaction cleanup', () => {
    it('clears bot-owned phase reactions before sending the final reply', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            code: 0,
            data: {
              open_id: 'ou_bot',
              items: [
                {
                  reaction_id: 'react-1',
                  reaction_type: { emoji_type: 'OK' },
                  operator: { open_id: 'ou_bot' },
                },
              ],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      await notifier.notify(result);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      // Verify list reactions call
      expect(mockFetch).toHaveBeenNthCalledWith(1,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions?user_id_type=open_id',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer token-abc',
          }),
        }),
      );
      // Verify delete calls
      expect(mockFetch).toHaveBeenNthCalledWith(2,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions/react-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(3,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reply',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('does not remove user reactions or non-phase reactions during cleanup', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            code: 0,
            data: {
              open_id: 'ou_bot',
              items: [
                {
                  reaction_id: 'react-phase-user',
                  reaction_type: { emoji_type: 'OK' },
                  operator: { open_id: 'ou_user' },
                },
                {
                  reaction_id: 'react-non-phase-bot',
                  reaction_type: { emoji_type: 'ThumbsUp' },
                  operator: { open_id: 'ou_bot' },
                },
                {
                  reaction_id: 'react-phase-bot',
                  reaction_type: { emoji_type: 'OnIt' },
                  operator: { open_id: 'ou_bot' },
                },
              ],
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      await notifier.notify(createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }));

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenNthCalledWith(2,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions/react-phase-bot',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(mockFetch).not.toHaveBeenCalledWith(
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions/react-phase-user',
        expect.anything(),
      );
      expect(mockFetch).not.toHaveBeenCalledWith(
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions/react-non-phase-bot',
        expect.anything(),
      );
    });

    it('does not attempt reaction cleanup on DM fallback', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      await notifier.notify(createResult()); // no task_source
      expect(mockFetch).toHaveBeenCalledTimes(1); // only DM send
    });

    it('skips deletion when reaction list is empty', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0, data: { items: [] } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      await notifier.notify(result);

      expect(mockFetch).toHaveBeenCalledTimes(2); // list reactions + reply
    });

    it('continues notification when reaction list API fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 99, msg: 'bad' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      // Should not throw — reaction cleanup is best-effort
      await expect(notifier.notify(result)).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('continues deleting remaining reactions when one DELETE fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            code: 0,
            data: {
              open_id: 'ou_bot',
              items: [
                {
                  reaction_id: 'react-1',
                  reaction_type: { emoji_type: 'OK' },
                  operator: { open_id: 'ou_bot' },
                },
                {
                  reaction_id: 'react-2',
                  reaction_type: { emoji_type: 'OnIt' },
                  operator: { open_id: 'ou_bot' },
                },
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
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      await expect(notifier.notify(result)).resolves.toBeUndefined();

      // Should still attempt to delete react-2 after react-1 fails
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(mockFetch).toHaveBeenNthCalledWith(3,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions/react-2',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });
});
