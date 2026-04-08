import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type MirrorTaskEvent, TaskResult } from '@local-agent/shared';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TelegramNotifier } from '../adapters/telegram-notifier';

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
    completed_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

function createMirror(overrides?: Partial<MirrorTaskEvent>): MirrorTaskEvent {
  return {
    event_kind: 'mirror',
    task_id: 'task-123',
    session_id: 'session-123',
    task_type: 'generic',
    task_source: { source: 'lark', message_id: 'om_1' },
    mirror_id: 'mirror-1',
    author_type: 'user',
    text: 'mirror text',
    origin_message_id: 'om_1',
    emitted_at: '2026-04-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('TelegramNotifier', () => {
  let notifier: TelegramNotifier;
  let telegramHistoryRepository: {
    getTelegramThreadBySessionId: ReturnType<typeof vi.fn>;
    getTelegramThreadByTopic: ReturnType<typeof vi.fn>;
    listTelegramMessagesForTopic: ReturnType<typeof vi.fn>;
    recordOutboundTelegramMessage: ReturnType<typeof vi.fn>;
    upsertTelegramThreadState: ReturnType<typeof vi.fn>;
    markTelegramThreadEnded: ReturnType<typeof vi.fn>;
    deleteTelegramRowsBySessionId: ReturnType<typeof vi.fn>;
  };
  let sessionBridgeRepository: {
    getBridgeBySessionId: ReturnType<typeof vi.fn>;
    getBridgeByTelegramTopic: ReturnType<typeof vi.fn>;
    markBridgeEnded: ReturnType<typeof vi.fn>;
    deleteBridgeBySessionId: ReturnType<typeof vi.fn>;
  };
  let sessionRepository: {
    getSessionById: ReturnType<typeof vi.fn>;
    markSessionEnded: ReturnType<typeof vi.fn>;
    deleteSessionById: ReturnType<typeof vi.fn>;
    listDescendantSessionIds: ReturnType<typeof vi.fn>;
  };
  let sessionPlatformLinkRepository: {
    getActiveLinkBySessionAndPlatform: ReturnType<typeof vi.fn>;
    claimPendingLink: ReturnType<typeof vi.fn>;
    activateClaimedLink: ReturnType<typeof vi.fn>;
    releaseExpiredOrFailedClaim: ReturnType<typeof vi.fn>;
    markLinksEnded: ReturnType<typeof vi.fn>;
    deleteLinksBySessionId: ReturnType<typeof vi.fn>;
    getLinkBySessionIdAndPlatform: ReturnType<typeof vi.fn>;
  };
  let topicManager: {
    createForumTopic: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    telegramHistoryRepository = {
      getTelegramThreadBySessionId: vi.fn().mockResolvedValue(null),
      getTelegramThreadByTopic: vi.fn().mockResolvedValue(null),
      listTelegramMessagesForTopic: vi.fn().mockResolvedValue([]),
      recordOutboundTelegramMessage: vi.fn().mockResolvedValue(undefined),
      upsertTelegramThreadState: vi.fn().mockResolvedValue(undefined),
      markTelegramThreadEnded: vi.fn().mockResolvedValue(undefined),
      deleteTelegramRowsBySessionId: vi.fn().mockResolvedValue(undefined),
    };
    sessionBridgeRepository = {
      getBridgeBySessionId: vi.fn().mockResolvedValue(null),
      getBridgeByTelegramTopic: vi.fn().mockResolvedValue(null),
      markBridgeEnded: vi.fn().mockResolvedValue(undefined),
      deleteBridgeBySessionId: vi.fn().mockResolvedValue(undefined),
    };
    sessionRepository = {
      getSessionById: vi.fn().mockResolvedValue(null),
      markSessionEnded: vi.fn().mockResolvedValue(undefined),
      deleteSessionById: vi.fn().mockResolvedValue(undefined),
      listDescendantSessionIds: vi.fn().mockResolvedValue([]),
    };
    sessionPlatformLinkRepository = {
      getActiveLinkBySessionAndPlatform: vi.fn().mockResolvedValue(null),
      claimPendingLink: vi.fn().mockResolvedValue({
        sessionId: 'session-123',
        platform: 'telegram',
        externalThreadKey: null,
        linkStatus: 'pending',
        claimToken: 'claim-token',
        claimExpiresAtMs: 1000,
        createdAtMs: 10,
        updatedAtMs: 10,
        endedAtMs: null,
      }),
      activateClaimedLink: vi.fn().mockResolvedValue(true),
      releaseExpiredOrFailedClaim: vi.fn().mockResolvedValue(true),
      markLinksEnded: vi.fn().mockResolvedValue(undefined),
      deleteLinksBySessionId: vi.fn().mockResolvedValue(undefined),
      getLinkBySessionIdAndPlatform: vi.fn().mockResolvedValue(null),
    };
    topicManager = {
      createForumTopic: vi.fn().mockResolvedValue({ message_thread_id: 42, name: 'Seed topic' }),
    };
    notifier = new TelegramNotifier(
      'bot123:ABC',
      '-100456789',
      telegramHistoryRepository as any,
      sessionBridgeRepository as any,
      sessionRepository as any,
      sessionPlatformLinkRepository as any,
      topicManager as any,
    );
  });

  describe('validate', () => {
    it('calls getMe and returns bot username on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { username: 'test_bot' } }),
      });

      const username = await notifier.validate();

      expect(username).toBe('test_bot');
      expect(mockFetch).toHaveBeenCalledWith('https://api.telegram.org/botbot123:ABC/getMe');
    });
  });

  describe('notify', () => {
    it('sends message via sendMessage endpoint on success', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });

      await notifier.notify(createResult());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe('-100456789');
      expect(body.parse_mode).toBe('MarkdownV2');
      expect(body.text).toContain('job-456');
    });

    it('creates and reuses a fallback topic for non-explicit session delivery', async () => {
      sessionPlatformLinkRepository.claimPendingLink.mockImplementation(async (params) => ({
        sessionId: params.sessionId,
        platform: params.platform,
        externalThreadKey: null,
        linkStatus: 'pending',
        claimToken: params.claimToken,
        claimExpiresAtMs: params.claimExpiresAtMs,
        createdAtMs: params.nowMs,
        updatedAtMs: params.nowMs,
        endedAtMs: null,
      }));
      sessionRepository.getSessionById.mockResolvedValue({
        sessionId: 'session-123',
        taskType: 'generic',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        createdAtMs: 10,
        updatedAtMs: 10,
        endedAtMs: null,
        fallbackSeedText: 'Seed text',
        fallbackOrigin: 'scheduler',
        fallbackTitleHint: 'Morning review',
      });
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 501 } }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 502 } }) });

      await notifier.notifyResult({
        result: createResult({
          session_id: 'session-123',
          task_source: { source: 'lark', message_id: 'om_1' },
        }),
      });

      expect(topicManager.createForumTopic).toHaveBeenCalledWith('-100456789', 'Morning review');
      expect(sessionPlatformLinkRepository.claimPendingLink).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-123',
        platform: 'telegram',
      }));
      expect(sessionPlatformLinkRepository.activateClaimedLink).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-123',
        platform: 'telegram',
        externalThreadKey: '-100456789:42',
      }));
      expect(telegramHistoryRepository.recordOutboundTelegramMessage).toHaveBeenCalledWith(expect.objectContaining({
        topicId: '42',
        messageId: '501',
        metadataJson: expect.stringContaining('fallback_seed'),
      }));
      expect(telegramHistoryRepository.recordOutboundTelegramMessage).toHaveBeenCalledWith(expect.objectContaining({
        topicId: '42',
        messageId: '502',
        metadataJson: expect.stringContaining('"event_kind":"result"'),
      }));

      vi.clearAllMocks();
      sessionPlatformLinkRepository.getActiveLinkBySessionAndPlatform.mockResolvedValue({
        sessionId: 'session-123',
        platform: 'telegram',
        externalThreadKey: '-100456789:42',
        linkStatus: 'active',
        claimToken: null,
        claimExpiresAtMs: null,
        createdAtMs: 10,
        updatedAtMs: 10,
        endedAtMs: null,
      });
      telegramHistoryRepository.getTelegramThreadByTopic.mockResolvedValue({
        chatId: '-100456789',
        topicId: '42',
        sessionId: 'session-123',
        source: 'scheduler',
        taskType: 'generic',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        seedMessageId: '501',
        statusMessageId: null,
        metadataJson: null,
        createdAtMs: 10,
        updatedAtMs: 10,
        endedAtMs: null,
      });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 503 } }) });

      await notifier.notifyResult({
        result: createResult({
          session_id: 'session-123',
          task_source: { source: 'lark', message_id: 'om_1' },
        }),
      });

      expect(topicManager.createForumTopic).not.toHaveBeenCalled();
      const reusedBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(reusedBody.message_thread_id).toBe(42);
    });

    it('creates a fallback topic for phase status delivery', async () => {
      sessionPlatformLinkRepository.claimPendingLink.mockImplementation(async (params) => ({
        sessionId: params.sessionId,
        platform: params.platform,
        externalThreadKey: null,
        linkStatus: 'pending',
        claimToken: params.claimToken,
        claimExpiresAtMs: params.claimExpiresAtMs,
        createdAtMs: params.nowMs,
        updatedAtMs: params.nowMs,
        endedAtMs: null,
      }));
      sessionRepository.getSessionById.mockResolvedValue({
        sessionId: 'session-phase',
        taskType: 'generic',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        createdAtMs: 10,
        updatedAtMs: 10,
        endedAtMs: null,
        fallbackSeedText: 'Seed phase',
        fallbackOrigin: 'scheduler',
        fallbackTitleHint: null,
      });
      topicManager.createForumTopic.mockResolvedValue({ message_thread_id: 84, name: 'Seed phase' });
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 601 } }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 602 } }) });

      await notifier.notifyStatus({
        sessionId: 'session-phase',
        text: '*Status:* queued',
      });

      expect(topicManager.createForumTopic).toHaveBeenCalledWith('-100456789', 'Seed phase');
      expect(telegramHistoryRepository.recordOutboundTelegramMessage).toHaveBeenCalledWith(expect.objectContaining({
        topicId: '84',
        messageId: '602',
        metadataJson: expect.stringContaining('phase_status'),
      }));
    });

    it('sends mirror text without markdown mode', async () => {
      sessionBridgeRepository.getBridgeBySessionId.mockResolvedValue({
        sessionId: 'session-123',
        larkRootMessageId: 'om_root',
        telegramChatId: '-100456789',
        telegramTopicId: '42',
      });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 77 } }) });

      await notifier.notifyMirror(createMirror());

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe('-100456789');
      expect(body.message_thread_id).toBe(42);
      expect(body.text).toBe('mirror text');
      expect(body.parse_mode).toBeUndefined();
      expect(telegramHistoryRepository.recordOutboundTelegramMessage).toHaveBeenCalledWith(expect.objectContaining({
        topicId: '42',
        sessionId: 'session-123',
        metadataJson: expect.stringContaining('"mirror_id":"mirror-1"'),
      }));
    });

    it('sends topic-aware result replies when requested', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 55 } }) });

      await notifier.notifyResult({
        chatId: '-100123',
        topicId: '42',
        result: createResult(),
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe('-100123');
      expect(body.message_thread_id).toBe(42);
      expect(body.parse_mode).toBe('MarkdownV2');
    });

    it('resolves bridged sessions for bot results when task_source is not telegram', async () => {
      sessionBridgeRepository.getBridgeBySessionId.mockResolvedValue({
        sessionId: 'session-123',
        larkRootMessageId: 'om_root',
        telegramChatId: '-100999',
        telegramTopicId: '88',
      });
      telegramHistoryRepository.getTelegramThreadByTopic.mockResolvedValue({
        chatId: '-100999',
        topicId: '88',
        sessionId: 'session-123',
        source: 'telegram',
        taskType: 'generic',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        seedMessageId: '111',
        statusMessageId: null,
        metadataJson: null,
        createdAtMs: 10,
        updatedAtMs: 10,
        endedAtMs: null,
      });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 66 } }) });

      await notifier.notifyResult({
        result: createResult({
          session_id: 'session-123',
          task_source: { source: 'lark', message_id: 'om_1' },
        }),
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe('-100999');
      expect(body.message_thread_id).toBe(88);
      expect(telegramHistoryRepository.recordOutboundTelegramMessage).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-123',
        topicId: '88',
      }));
    });

    it('deletes telegram and shared bridge rows for /end replies when a bridge exists', async () => {
      sessionBridgeRepository.getBridgeBySessionId.mockResolvedValue({
        sessionId: 'session-end-1',
        larkRootMessageId: 'om_end_1',
        telegramChatId: '-100999',
        telegramTopicId: '88',
      });
      telegramHistoryRepository.getTelegramThreadByTopic.mockResolvedValue({
        chatId: '-100999',
        topicId: '88',
        sessionId: 'session-end-1',
        source: 'telegram',
        taskType: 'cleanup',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        seedMessageId: '111',
        statusMessageId: null,
        metadataJson: null,
        createdAtMs: 10,
        updatedAtMs: 10,
        endedAtMs: null,
      });
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 67 } }) });

      await notifier.notifyResult({
        result: createResult({
          task_type: 'cleanup',
          session_id: 'session-end-1',
          task_source: { source: 'lark', message_id: 'om_1' },
        }),
      });

      expect(telegramHistoryRepository.recordOutboundTelegramMessage).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-end-1',
        topicId: '88',
      }));
      expect(sessionRepository.markSessionEnded).toHaveBeenCalledWith('session-end-1', expect.any(Number));
      expect(sessionPlatformLinkRepository.markLinksEnded).toHaveBeenCalledWith('session-end-1', expect.any(Number));
      expect(telegramHistoryRepository.markTelegramThreadEnded).toHaveBeenCalledWith('session-end-1', expect.any(Number));
      expect(sessionBridgeRepository.getBridgeBySessionId).toHaveBeenCalledWith('session-end-1');
      expect(sessionBridgeRepository.markBridgeEnded).toHaveBeenCalledWith('session-end-1', expect.any(Number));
      expect(sessionBridgeRepository.deleteBridgeBySessionId).toHaveBeenCalledWith('session-end-1');
      expect(telegramHistoryRepository.deleteTelegramRowsBySessionId).toHaveBeenCalledWith('session-end-1');
      expect(sessionPlatformLinkRepository.deleteLinksBySessionId).toHaveBeenCalledWith('session-end-1');
      expect(sessionRepository.deleteSessionById).toHaveBeenCalledWith('session-end-1');
    });

    it('deletes telegram rows without bridge operations when no bridge exists', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 68 } }) });

      await notifier.notifyResult({
        chatId: '-100123',
        topicId: '42',
        result: createResult({
          task_type: 'cleanup',
          session_id: 'session-end-2',
        }),
      });

      expect(sessionRepository.markSessionEnded).toHaveBeenCalledWith('session-end-2', expect.any(Number));
      expect(sessionPlatformLinkRepository.markLinksEnded).toHaveBeenCalledWith('session-end-2', expect.any(Number));
      expect(telegramHistoryRepository.markTelegramThreadEnded).toHaveBeenCalledWith('session-end-2', expect.any(Number));
      expect(sessionBridgeRepository.getBridgeBySessionId).toHaveBeenCalledWith('session-end-2');
      expect(sessionBridgeRepository.markBridgeEnded).not.toHaveBeenCalled();
      expect(sessionBridgeRepository.deleteBridgeBySessionId).not.toHaveBeenCalled();
      expect(telegramHistoryRepository.deleteTelegramRowsBySessionId).toHaveBeenCalledWith('session-end-2');
      expect(sessionPlatformLinkRepository.deleteLinksBySessionId).toHaveBeenCalledWith('session-end-2');
      expect(sessionRepository.deleteSessionById).toHaveBeenCalledWith('session-end-2');
    });
  });
});
