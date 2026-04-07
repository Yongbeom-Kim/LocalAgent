import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramSessionResolver } from '../adapters/telegram-session-resolver';

const { mockGenerateSessionId } = vi.hoisted(() => ({
  mockGenerateSessionId: vi.fn(),
}));

vi.mock('@local-agent/shared', async () => {
  const actual = await vi.importActual<typeof import('@local-agent/shared')>('@local-agent/shared');
  return {
    ...actual,
    generateSessionId: mockGenerateSessionId,
  };
});

describe('TelegramSessionResolver', () => {
  let telegramHistoryRepository: any;
  let sessionRepository: any;
  let sessionPlatformLinkRepository: any;
  let resolver: TelegramSessionResolver;

  beforeEach(() => {
    mockGenerateSessionId.mockReset().mockReturnValue('sess-new');
    telegramHistoryRepository = {
      getTelegramThreadByTopic: vi.fn().mockResolvedValue(null),
      getTelegramMessageByChatAndMessageId: vi.fn().mockResolvedValue(null),
      recordInboundTelegramMessage: vi.fn().mockResolvedValue(undefined),
      upsertTelegramThreadState: vi.fn().mockResolvedValue(undefined),
    };
    sessionRepository = { upsertSession: vi.fn().mockResolvedValue(undefined) };
    sessionPlatformLinkRepository = {
      getLinkByPlatformThread: vi.fn().mockResolvedValue(null),
      upsertLink: vi.fn().mockResolvedValue(undefined),
    };
    resolver = new TelegramSessionResolver(
      telegramHistoryRepository,
      sessionRepository,
      sessionPlatformLinkRepository,
    );
  });

  it('creates canonical session metadata for root telegram commands', async () => {
    const result = await resolver.resolve({
      platform: 'telegram',
      schema_version: 1,
      chat_id: '-100456789',
      topic_id: '42',
      message_id: '10',
      sender_id: '7',
      sender_is_bot: false,
      message_type: 'text',
      raw_content: '/task deploy claude sonnet ship it',
      normalized_text: '/task deploy claude sonnet ship it',
      is_normalizable: true,
      occurred_at_ms: 1,
    });

    expect(result).toEqual({
      kind: 'accepted',
      task: {
        taskType: 'deploy',
        payload: 'ship it',
        taskSource: { source: 'telegram', chat_id: '-100456789', topic_id: '42', message_id: '10' },
        sessionId: 'sess-new',
        contextRef: { platform: 'telegram', root_key: '-100456789:42' },
        executor: 'claude',
        executorModel: 'sonnet',
      },
    });
    expect(sessionRepository.upsertSession).toHaveBeenCalled();
    expect(sessionPlatformLinkRepository.upsertLink).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-new',
      platform: 'telegram',
      externalThreadKey: '-100456789:42',
    }));
  });

  it('reuses the mapped session_id for topic follow-up messages', async () => {
    sessionPlatformLinkRepository.getLinkByPlatformThread.mockResolvedValue({
      sessionId: 'sess-1',
      platform: 'telegram',
      externalThreadKey: '-100456789:42',
      createdAtMs: 1,
      updatedAtMs: 1,
      endedAtMs: null,
    });
    telegramHistoryRepository.getTelegramThreadByTopic.mockResolvedValue({
      chatId: '-100456789',
      topicId: '42',
      sessionId: 'sess-1',
      source: 'telegram',
      taskType: 'deploy',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      seedMessageId: '9',
      statusMessageId: null,
      metadataJson: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      endedAtMs: null,
    });

    const result = await resolver.resolve({
      platform: 'telegram',
      schema_version: 1,
      chat_id: '-100456789',
      topic_id: '42',
      message_id: '11',
      sender_id: '7',
      sender_is_bot: false,
      message_type: 'text',
      raw_content: 'follow up',
      normalized_text: 'follow up',
      is_normalizable: true,
      occurred_at_ms: 2,
    });

    expect(result).toEqual({
      kind: 'accepted',
      task: {
        taskType: 'thread_reply',
        payload: 'follow up',
        taskSource: { source: 'telegram', chat_id: '-100456789', topic_id: '42', message_id: '11' },
        sessionId: 'sess-1',
        contextRef: { platform: 'telegram', root_key: '-100456789:42' },
      },
    });
  });
});
