import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskResult, type TaskPhaseEvent } from '@local-agent/shared';
import { LarkNotifier } from '../adapters/lark-notifier';

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

function createPhase(overrides?: Partial<TaskPhaseEvent>): TaskPhaseEvent {
  return {
    event_kind: 'phase',
    event_id: 'evt-1',
    emitted_at: '2026-04-10T00:00:00.000Z',
    task_id: 'task-1',
    task_type: 'generic',
    phase: 'queued',
    session_id: 'session-1',
    ...overrides,
  };
}

describe('LarkNotifier', () => {
  let tokenProvider: { getTenantAccessToken: ReturnType<typeof vi.fn> };
  let larkHistoryRepository: any;
  let sessionRepository: any;
  let sessionPlatformLinkRepository: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();

    tokenProvider = {
      getTenantAccessToken: vi.fn().mockResolvedValue('token-abc'),
    };

    larkHistoryRepository = {
      recordOutboundLarkMessage: vi.fn().mockResolvedValue(undefined),
      markLarkThreadNewInstance: vi.fn().mockResolvedValue(undefined),
      getLarkThreadByRootMessageId: vi.fn().mockResolvedValue(null),
      upsertLarkThreadState: vi.fn().mockResolvedValue(undefined),
      deleteLarkRowsBySessionId: vi.fn().mockResolvedValue(undefined),
      deleteLarkRowsBySessionIds: vi.fn().mockResolvedValue(undefined),
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
  });

  function createNotifier(): LarkNotifier {
    return new LarkNotifier(
      'app-id',
      'app-secret',
      'user-123',
      larkHistoryRepository,
      tokenProvider,
      sessionRepository,
      sessionPlatformLinkRepository,
    );
  }

  it('replies through an existing session link', async () => {
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
      platform: 'lark',
      externalThreadKey: 'om_root_1',
      claimToken: null,
      claimExpiresAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    larkHistoryRepository.getLarkThreadByRootMessageId.mockResolvedValue({
      rootMessageId: 'om_root_1',
      rootSessionId: 'session-1',
      sessionId: 'session-1',
      threadId: null,
      source: 'lark',
      chatType: 'p2p',
      taskType: 'generic',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0, data: { items: [] } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0, data: { message_id: 'om_reply_1' } }) });

    await createNotifier().notify(createResult());

    expect(sessionPlatformLinkRepository.claimPendingLink).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_root_1/reply',
      expect.any(Object),
    );
    expect(larkHistoryRepository.recordOutboundLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_reply_1',
      rootMessageId: 'om_root_1',
      sessionId: 'session-1',
    }));
  });

  it('lazily creates a fallback thread from session metadata', async () => {
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
      fallbackTitleHint: 'hint',
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
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0, data: { message_id: 'om_seed_1' } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0, data: { items: [] } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0, data: { message_id: 'om_reply_1' } }) });

    await createNotifier().notify(createResult());

    expect(sessionPlatformLinkRepository.claimPendingLink).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      platform: 'lark',
    }));
    expect(sessionPlatformLinkRepository.activateClaimedLink).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      platform: 'lark',
      externalThreadKey: 'om_seed_1',
    }));
    expect(larkHistoryRepository.upsertLarkThreadState).toHaveBeenCalledWith(expect.objectContaining({
      rootMessageId: 'om_seed_1',
      source: 'scheduler',
      sessionId: 'session-1',
    }));
    expect(larkHistoryRepository.recordOutboundLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_seed_1',
      metadataJson: expect.stringContaining('fallback_seed'),
    }));
  });

  it('does not create a destination for missing or inactive sessions', async () => {
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
    await notifier.notify(createResult());

    expect(sessionPlatformLinkRepository.claimPendingLink).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('routes phase events by session_id and lazily creates when needed', async () => {
    sessionRepository.getSessionById.mockResolvedValue({
      sessionId: 'session-1',
      taskType: 'generic',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      createdAtMs: 1,
      updatedAtMs: 1,
      fallbackSeedText: 'Seed phase',
      fallbackOrigin: 'scheduler',
      fallbackTitleHint: null,
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
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0, data: { message_id: 'om_seed_phase' } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0, data: { message_id: 'om_phase_1' } }) });

    await createNotifier().notifyPhase(createPhase());

    expect(larkHistoryRepository.recordOutboundLarkMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_phase_1',
      normalizedText: 'Status: queued',
      metadataJson: expect.stringContaining('"event_kind":"phase"'),
    }));
  });

  it('marks sessions ended and hard-deletes rows for cleanup results', async () => {
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
      platform: 'lark',
      externalThreadKey: 'om_root_shared',
      claimToken: null,
      claimExpiresAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    larkHistoryRepository.getLarkThreadByRootMessageId.mockResolvedValue({
      rootMessageId: 'om_root_shared',
      rootSessionId: 'root-session',
      sessionId: 'root-session',
      threadId: null,
      source: 'lark',
      chatType: 'group',
      taskType: 'cleanup',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    sessionRepository.listDescendantSessionIds.mockResolvedValue(['child-session']);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0, data: { items: [] } }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0, data: { message_id: 'om_cleanup_1' } }) });

    await createNotifier().notify(createResult({ session_id: 'child-session', task_type: 'cleanup' }));

    expect(sessionRepository.markSessionEnded).toHaveBeenCalledWith('root-session', expect.any(Number));
    expect(sessionRepository.markSessionEnded).toHaveBeenCalledWith('child-session', expect.any(Number));
    expect(larkHistoryRepository.deleteLarkRowsBySessionIds).toHaveBeenCalledWith(['root-session', 'child-session']);
    expect(sessionPlatformLinkRepository.deleteLinksBySessionIds).toHaveBeenCalledWith(['root-session', 'child-session']);
    expect(sessionRepository.deleteSessionsByIds).toHaveBeenCalledWith(['root-session', 'child-session']);
  });
});
