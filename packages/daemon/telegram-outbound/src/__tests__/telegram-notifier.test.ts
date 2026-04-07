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

  beforeEach(() => {
    vi.clearAllMocks();
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
    notifier = new TelegramNotifier(
      'bot123:ABC',
      '-100456789',
      telegramHistoryRepository as any,
      sessionBridgeRepository as any,
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

      if (mockFetch.mock.calls.length === 0) {
        await notifier.notifyLegacy(createResult());
      }

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe('-100456789');
      expect(body.parse_mode).toBe('MarkdownV2');
      expect(body.text).toContain('job-456');
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
      expect(telegramHistoryRepository.markTelegramThreadEnded).toHaveBeenCalledWith('session-end-1', expect.any(Number));
      expect(telegramHistoryRepository.deleteTelegramRowsBySessionId).toHaveBeenCalledWith('session-end-1');
      expect(sessionBridgeRepository.getBridgeBySessionId).toHaveBeenCalledWith('session-end-1');
      expect(sessionBridgeRepository.markBridgeEnded).toHaveBeenCalledWith('session-end-1', expect.any(Number));
      expect(sessionBridgeRepository.deleteBridgeBySessionId).toHaveBeenCalledWith('session-end-1');
    });

    it('deletes telegram rows without bridge operations when no bridge exists', async () => {
      sessionBridgeRepository.getBridgeBySessionId.mockResolvedValue(null);
      mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true, result: { message_id: 68 } }) });

      await notifier.notifyResult({
        chatId: '-100123',
        topicId: '42',
        result: createResult({
          task_type: 'cleanup',
          session_id: 'session-end-2',
        }),
      });

      expect(telegramHistoryRepository.markTelegramThreadEnded).toHaveBeenCalledWith('session-end-2', expect.any(Number));
      expect(telegramHistoryRepository.deleteTelegramRowsBySessionId).toHaveBeenCalledWith('session-end-2');
      expect(sessionBridgeRepository.getBridgeBySessionId).toHaveBeenCalledWith('session-end-2');
      expect(sessionBridgeRepository.markBridgeEnded).not.toHaveBeenCalled();
      expect(sessionBridgeRepository.deleteBridgeBySessionId).not.toHaveBeenCalled();
    });
  });
});
