import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskResult } from '@local-agent/shared';
import { TelegramNotifier } from '../adapters/telegram-notifier';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createResult(overrides?: Partial<TaskResult>): TaskResult {
  return {
    result_id: 'res-1',
    job_id: 'job-1',
    task_id: 'task-1',
    task_type: 'generic',
    status: 'success',
    exit_code: 0,
    stdout: 'done',
    stderr: '',
    completed_at: '2026-04-10T00:00:00.000Z',
    session_id: 'session-1',
    ...overrides,
  };
}

describe('TelegramNotifier', () => {
  let telegramHistoryRepository: any;
  let sessionRepository: any;
  let sessionPlatformLinkRepository: any;
  let topicManager: { createForumTopic: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();

    telegramHistoryRepository = {
      getTelegramThreadByTopic: vi.fn().mockResolvedValue(null),
      recordOutboundTelegramMessage: vi.fn().mockResolvedValue(undefined),
      upsertTelegramThreadState: vi.fn().mockResolvedValue(undefined),
      deleteTelegramRowsBySessionId: vi.fn().mockResolvedValue(undefined),
      deleteTelegramRowsBySessionIds: vi.fn().mockResolvedValue(undefined),
    };

    sessionRepository = {
      getSessionById: vi.fn().mockResolvedValue(null),
      markSessionEnded: vi.fn().mockResolvedValue(undefined),
      deleteSessionById: vi.fn().mockResolvedValue(undefined),
      listDescendantSessionIds: vi.fn().mockResolvedValue([]),
      deleteSessionsByIds: vi.fn().mockResolvedValue(undefined),
    };

    sessionPlatformLinkRepository = {
      getActiveLinkBySessionAndPlatform: vi.fn().mockResolvedValue(null),
      claimPendingLink: vi.fn(),
      activateClaimedLink: vi.fn().mockResolvedValue(true),
      releaseExpiredOrFailedClaim: vi.fn().mockResolvedValue(true),
      deleteLinksBySessionId: vi.fn().mockResolvedValue(undefined),
      getLinkBySessionIdAndPlatform: vi.fn().mockResolvedValue(null),
      deleteLinksBySessionIds: vi.fn().mockResolvedValue(undefined),
    };

    topicManager = {
      createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 42, name: 'Seed topic' }),
    };
  });

  function createNotifier(): TelegramNotifier {
    return new TelegramNotifier(
      'bot123:ABC',
      '-100456789',
      telegramHistoryRepository,
      sessionRepository,
      sessionPlatformLinkRepository,
      topicManager,
    );
  }

  it('validates the bot token through getMe', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: { username: 'test_bot' } }),
    });

    await expect(createNotifier().validate()).resolves.toBe('test_bot');
    expect(mockFetch).toHaveBeenCalledWith('https://api.telegram.org/botbot123:ABC/getMe');
  });

  it('sends through an existing session link', async () => {
    sessionRepository.getSessionById.mockResolvedValue({
      sessionId: 'session-1',
      taskType: 'generic',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      createdAtMs: 1,
      updatedAtMs: 1,
      fallbackSeedText: null,
      fallbackOrigin: null,
      fallbackTitleHint: null,
    });
    sessionPlatformLinkRepository.getActiveLinkBySessionAndPlatform.mockResolvedValue({
      sessionId: 'session-1',
      platform: 'telegram',
      externalThreadKey: '-100456789:42',
      claimToken: null,
      claimExpiresAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    telegramHistoryRepository.getTelegramThreadByTopic.mockResolvedValue({
      chatId: '-100456789',
      topicId: '42',
      rootSessionId: 'session-1',
      sessionId: 'session-1',
      source: 'telegram',
      taskType: 'generic',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      seedMessageId: '100',
      statusMessageId: null,
      metadataJson: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 501 } }) });

    await createNotifier().notify(createResult());

    expect(topicManager.createForumTopic).not.toHaveBeenCalled();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe('-100456789');
    expect(body.message_thread_id).toBe(42);
    expect(telegramHistoryRepository.recordOutboundTelegramMessage).toHaveBeenCalledWith(expect.objectContaining({
      topicId: '42',
      sessionId: 'session-1',
    }));
  });

  it('lazily creates a fallback topic from session metadata', async () => {
    sessionRepository.getSessionById.mockResolvedValue({
      sessionId: 'session-1',
      taskType: 'generic',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      createdAtMs: 1,
      updatedAtMs: 1,
      fallbackSeedText: 'Seed text',
      fallbackOrigin: 'scheduler',
      fallbackTitleHint: 'Morning review',
    });
    sessionPlatformLinkRepository.claimPendingLink.mockImplementation(async (params: any) => ({
      sessionId: params.sessionId,
      platform: params.platform,
      externalThreadKey: null,
      claimToken: params.claimToken,
      claimExpiresAtMs: params.claimExpiresAtMs,
      createdAtMs: params.nowMs,
      updatedAtMs: params.nowMs,
    }));
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 500 } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 501 } }) });

    await createNotifier().notify(createResult());

    expect(topicManager.createForumTopic).toHaveBeenCalledWith('-100456789', 'Morning review');
    expect(sessionPlatformLinkRepository.activateClaimedLink).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      platform: 'telegram',
      externalThreadKey: '-100456789:42',
    }));
    expect(telegramHistoryRepository.upsertTelegramThreadState).toHaveBeenCalledWith(expect.objectContaining({
      chatId: '-100456789',
      topicId: '42',
      source: 'scheduler',
    }));
    expect(telegramHistoryRepository.recordOutboundTelegramMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: '500',
      metadataJson: expect.stringContaining('fallback_seed'),
    }));
  });

  it('routes status messages by session_id only', async () => {
    sessionRepository.getSessionById.mockResolvedValue({
      sessionId: 'session-1',
      taskType: 'generic',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      createdAtMs: 1,
      updatedAtMs: 1,
      fallbackSeedText: null,
      fallbackOrigin: null,
      fallbackTitleHint: null,
    });
    sessionPlatformLinkRepository.getActiveLinkBySessionAndPlatform.mockResolvedValue({
      sessionId: 'session-1',
      platform: 'telegram',
      externalThreadKey: '-100456789:42',
      claimToken: null,
      claimExpiresAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    telegramHistoryRepository.getTelegramThreadByTopic.mockResolvedValue({
      chatId: '-100456789',
      topicId: '42',
      rootSessionId: 'session-1',
      sessionId: 'session-1',
      source: 'telegram',
      taskType: 'generic',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      seedMessageId: '100',
      statusMessageId: null,
      metadataJson: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 601 } }) });

    await createNotifier().notifyStatus({ sessionId: 'session-1', text: '*Status:* queued' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe('-100456789');
    expect(body.message_thread_id).toBe(42);
    expect(telegramHistoryRepository.recordOutboundTelegramMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: '601',
      metadataJson: expect.stringContaining('phase_status'),
    }));
  });

  it('routes direct telegram status messages without persisted session state', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 611 } }) });

    await createNotifier().notifyStatus({
      chatId: '-100456789',
      topicId: '42',
      sessionId: 'telegram-reject:-100456789:42',
      text: '*Status:* completed',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe('-100456789');
    expect(body.message_thread_id).toBe(42);
    expect(sessionRepository.getSessionById).not.toHaveBeenCalled();
    expect(telegramHistoryRepository.recordOutboundTelegramMessage).not.toHaveBeenCalled();
  });

  it('routes direct telegram results without persisted session state', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 612 } }) });

    await createNotifier().notifyResult({
      chatId: '-100456789',
      topicId: '42',
      result: createResult({
        session_id: 'telegram-reject:-100456789:42',
        task_source: { source: 'telegram', chat_id: '-100456789', topic_id: '42', message_id: '10' },
      }),
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.chat_id).toBe('-100456789');
    expect(body.message_thread_id).toBe(42);
    expect(sessionRepository.getSessionById).not.toHaveBeenCalled();
    expect(telegramHistoryRepository.recordOutboundTelegramMessage).not.toHaveBeenCalled();
  });

  it('does not create destinations for missing or inactive sessions', async () => {
    sessionRepository.getSessionById.mockResolvedValueOnce(null).mockResolvedValueOnce({
      sessionId: 'session-1',
      taskType: 'generic',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'ended',
      createdAtMs: 1,
      updatedAtMs: 1,
      fallbackSeedText: 'Seed text',
      fallbackOrigin: 'scheduler',
      fallbackTitleHint: null,
    });

    const notifier = createNotifier();
    await notifier.notify(createResult());
    await notifier.notifyStatus({ sessionId: 'session-1', text: 'x' });

    expect(topicManager.createForumTopic).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('hard-deletes root and descendant rows after cleanup delivery', async () => {
    sessionRepository.getSessionById.mockResolvedValue({
      sessionId: 'child-session',
      taskType: 'cleanup',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      createdAtMs: 1,
      updatedAtMs: 1,
      fallbackSeedText: null,
      fallbackOrigin: null,
      fallbackTitleHint: null,
    });
    sessionPlatformLinkRepository.getActiveLinkBySessionAndPlatform.mockResolvedValue({
      sessionId: 'child-session',
      platform: 'telegram',
      externalThreadKey: '-100456789:42',
      claimToken: null,
      claimExpiresAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    telegramHistoryRepository.getTelegramThreadByTopic.mockResolvedValue({
      chatId: '-100456789',
      topicId: '42',
      rootSessionId: 'root-session',
      sessionId: 'root-session',
      source: 'telegram',
      taskType: 'cleanup',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      seedMessageId: '100',
      statusMessageId: null,
      metadataJson: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    sessionRepository.listDescendantSessionIds.mockResolvedValue(['child-session']);
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 701 } }) });

    await createNotifier().notify(createResult({ session_id: 'child-session', task_type: 'cleanup' }));

    expect(sessionRepository.markSessionEnded).toHaveBeenCalledWith('root-session', expect.any(Number));
    expect(sessionRepository.markSessionEnded).toHaveBeenCalledWith('child-session', expect.any(Number));
    expect(telegramHistoryRepository.deleteTelegramRowsBySessionIds).toHaveBeenCalledWith(['root-session', 'child-session']);
    expect(sessionPlatformLinkRepository.deleteLinksBySessionIds).toHaveBeenCalledWith(['root-session', 'child-session']);
    expect(sessionRepository.deleteSessionsByIds).toHaveBeenCalledWith(['root-session', 'child-session']);
  });
});
