import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LarkSessionResolver } from '../adapters/lark-session-resolver';

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

describe('LarkSessionResolver', () => {
  let larkHistoryRepository: any;
  let sessionRepository: any;
  let sessionPlatformLinkRepository: any;
  let resolver: LarkSessionResolver;

  beforeEach(() => {
    mockGenerateSessionId.mockReset().mockReturnValue('sess-new');
    larkHistoryRepository = {
      recordInboundAuditMessage: vi.fn().mockResolvedValue(true),
      getLarkThreadByRootMessageId: vi.fn().mockResolvedValue(null),
      upsertLarkThreadState: vi.fn().mockResolvedValue(undefined),
    };
    sessionRepository = { upsertSession: vi.fn().mockResolvedValue(undefined) };
    sessionPlatformLinkRepository = {
      listLinksByPlatformAndExternalThreadKey: vi.fn().mockResolvedValue([]),
      upsertLink: vi.fn().mockResolvedValue(undefined),
    };
    resolver = new LarkSessionResolver(larkHistoryRepository, sessionRepository, sessionPlatformLinkRepository);
  });

  it('creates a new canonical session for root entrypoints', async () => {
    const result = await resolver.resolve({
      envelope: {
        platform: 'lark',
        schema_version: 1,
        message_id: 'om_root1',
        root_message_id: 'om_root1',
        thread_id: null,
        chat_type: 'p2p',
        sender_open_id: 'ou_1',
        sender_type: 'user',
        message_type: 'text',
        raw_content: '{"text":"/task code_review claude sonnet review this"}',
        normalized_text: '/task code_review claude sonnet review this',
        mentions: [],
        is_normalizable: true,
        occurred_at_ms: 1,
      },
      classification: {
        kind: 'accepted',
        shouldMaterializeRootState: true,
        envelope: undefined as any,
        task: {
          task_id: 'lark:om_root1',
          task_type: 'code_review',
          payload: 'review this',
          submitted_at: new Date(1).toISOString(),
          executor: 'claude',
          executor_model: 'sonnet',
          task_source: { source: 'lark', message_id: 'om_root1' },
        },
      },
    });

    expect(result).toEqual({
      kind: 'accepted',
      task: {
        taskType: 'code_review',
        payload: 'review this',
        taskSource: { source: 'lark', message_id: 'om_root1' },
        sessionId: 'sess-new',
        contextRef: { platform: 'lark', root_key: 'om_root1' },
        executor: 'claude',
        executorModel: 'sonnet',
      },
    });
    expect(sessionRepository.upsertSession).toHaveBeenCalled();
    expect(sessionPlatformLinkRepository.upsertLink).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-new',
      platform: 'lark',
      externalThreadKey: 'om_root1',
    }));
  });

  it('reuses the mapped session for thread follow-up messages', async () => {
    sessionPlatformLinkRepository.listLinksByPlatformAndExternalThreadKey.mockResolvedValueOnce([{
      sessionId: 'sess-existing',
      platform: 'lark',
      externalThreadKey: 'om_root1',
      createdAtMs: 1,
      updatedAtMs: 1,
      endedAtMs: null,
    }]);
    larkHistoryRepository.getLarkThreadByRootMessageId.mockResolvedValueOnce({
      rootMessageId: 'om_root1',
      threadId: 'omt_1',
      sessionId: 'sess-existing',
      source: 'lark',
      chatType: 'p2p',
      taskType: 'code_review',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      createdAtMs: 1,
      updatedAtMs: 1,
      endedAtMs: null,
    });

    const result = await resolver.resolve({
      envelope: {
        platform: 'lark',
        schema_version: 1,
        message_id: 'om_reply1',
        root_message_id: 'om_root1',
        thread_id: 'omt_1',
        chat_type: 'p2p',
        sender_open_id: 'ou_1',
        sender_type: 'user',
        message_type: 'text',
        raw_content: '{"text":"follow up"}',
        normalized_text: 'follow up',
        mentions: [],
        is_normalizable: true,
        occurred_at_ms: 2,
      },
      classification: {
        kind: 'accepted',
        shouldMaterializeRootState: false,
        envelope: undefined as any,
        task: {
          task_id: 'lark:om_reply1',
          task_type: 'thread_reply',
          payload: 'follow up',
          submitted_at: new Date(2).toISOString(),
          task_source: { source: 'lark', message_id: 'om_reply1' },
        },
      },
    });

    expect(result).toEqual({
      kind: 'accepted',
      task: {
        taskType: 'thread_reply',
        payload: 'follow up',
        taskSource: { source: 'lark', message_id: 'om_reply1' },
        sessionId: 'sess-existing',
        contextRef: { platform: 'lark', root_key: 'om_root1' },
      },
    });
  });

  it('rejects thread follow-up messages when the root session does not exist yet', async () => {
    const result = await resolver.resolve({
      envelope: {
        platform: 'lark',
        schema_version: 1,
        message_id: 'om_reply1',
        root_message_id: 'om_root1',
        thread_id: 'omt_1',
        chat_type: 'p2p',
        sender_open_id: 'ou_1',
        sender_type: 'user',
        message_type: 'text',
        raw_content: '{"text":"follow up"}',
        normalized_text: 'follow up',
        mentions: [],
        is_normalizable: true,
        occurred_at_ms: 2,
      },
      classification: {
        kind: 'accepted',
        shouldMaterializeRootState: false,
        envelope: undefined as any,
        task: {
          task_id: 'lark:om_reply1',
          task_type: 'thread_reply',
          payload: 'follow up',
          submitted_at: new Date(2).toISOString(),
          task_source: { source: 'lark', message_id: 'om_reply1' },
        },
      },
    });

    expect(result).toEqual({
      kind: 'rejected',
      reason: 'Thread session is not ready yet. Retry after the root message is processed.',
    });
  });
});
