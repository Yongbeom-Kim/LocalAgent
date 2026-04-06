import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LarkPhaseNotifier,
  clearBotOwnedPhaseReactions,
} from '../adapters/lark-phase-notifier';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('LarkPhaseNotifier', () => {
  const tokenProvider = {
    getTenantAccessToken: vi.fn().mockResolvedValue('token-abc'),
  };

  const repository = {
    appendLarkPhaseReactionAttempt: vi.fn().mockResolvedValue(undefined),
  };

  let notifier: LarkPhaseNotifier;

  beforeEach(() => {
    vi.clearAllMocks();
    tokenProvider.getTenantAccessToken.mockResolvedValue('token-abc');
    repository.appendLarkPhaseReactionAttempt.mockResolvedValue(undefined);
    notifier = new LarkPhaseNotifier(tokenProvider, repository);
  });

  it('adds the mapped reaction for received', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: { open_id: 'ou_bot', items: [] } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify({
      event_id: 'evt-1',
      task_id: 'task-1',
      phase: 'received',
      task_source: { source: 'lark', message_id: 'om_1' },
    });

    expect(mockFetch).toHaveBeenNthCalledWith(2,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_1/reactions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reaction_type: { emoji_type: 'OnIt' } }),
      }),
    );
    expect(repository.appendLarkPhaseReactionAttempt).toHaveBeenCalledWith('om_1', expect.objectContaining({
      phase: 'received',
      action: 'set',
      ok: true,
      event_id: 'evt-1',
    }));
  });

  it('replaces the prior reaction when phase advances', async () => {
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
                reaction_type: { emoji_type: 'OnIt' },
                operator: { open_id: 'ou_bot' },
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0 }) });

    await notifier.notify({
      event_id: 'evt-2',
      task_id: 'task-1',
      phase: 'queued',
      task_source: { source: 'lark', message_id: 'om_1' },
    });

    expect(mockFetch).toHaveBeenNthCalledWith(2,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_1/reactions/react-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(3,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_1/reactions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reaction_type: { emoji_type: 'Hourglass' } }),
      }),
    );
  });

  it('clears bot-owned phase reactions on completed without adding a replacement', async () => {
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
                reaction_type: { emoji_type: 'Runner' },
                operator: { open_id: 'ou_bot' },
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0 }) });

    await notifier.notify({
      event_id: 'evt-3',
      task_id: 'task-1',
      phase: 'completed',
      task_source: { source: 'lark', message_id: 'om_1' },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(2,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_1/reactions/react-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(repository.appendLarkPhaseReactionAttempt).toHaveBeenCalledWith('om_1', expect.objectContaining({
      phase: 'completed',
      action: 'clear',
      ok: true,
      event_id: 'evt-3',
    }));
  });

  it('clears bot-owned phase reactions on cancelled without adding a replacement', async () => {
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
                reaction_type: { emoji_type: 'Runner' },
                operator: { open_id: 'ou_bot' },
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0 }) });

    await notifier.notify({
      event_id: 'evt-cancelled',
      task_id: 'task-1',
      phase: 'cancelled',
      task_source: { source: 'lark', message_id: 'om_1' },
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(2,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_1/reactions/react-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(repository.appendLarkPhaseReactionAttempt).toHaveBeenCalledWith('om_1', expect.objectContaining({
      phase: 'cancelled',
      action: 'clear',
      ok: true,
      event_id: 'evt-cancelled',
    }));
  });

  it('ignores non-lark task sources', async () => {
    await notifier.notify({
      event_id: 'evt-4',
      task_id: 'task-1',
      phase: 'received',
      task_source: { source: 'telegram', message_id: 'tg_1' },
    });

    expect(tokenProvider.getTenantAccessToken).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(repository.appendLarkPhaseReactionAttempt).not.toHaveBeenCalled();
  });

  it('records a failure marker when reaction updates fail', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 99, msg: 'failed' }),
      });

    await notifier.notify({
      event_id: 'evt-5',
      task_id: 'task-1',
      phase: 'executing',
      task_source: { source: 'lark', message_id: 'om_1' },
    });

    expect(repository.appendLarkPhaseReactionAttempt).toHaveBeenCalledWith('om_1', expect.objectContaining({
      phase: 'executing',
      action: 'set',
      ok: false,
      event_id: 'evt-5',
      error: expect.stringContaining('list reactions failed'),
    }));
  });

  it('does not remove or mutate non-phase reactions (user or other emojis)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          code: 0,
          data: {
            open_id: 'ou_bot',
            items: [
              {
                reaction_id: 'react-user-phase',
                reaction_type: { emoji_type: 'OnIt' },
                operator: { open_id: 'ou_user' },
              },
              {
                reaction_id: 'react-bot-non-phase',
                reaction_type: { emoji_type: 'ThumbsUp' },
                operator: { open_id: 'ou_bot' },
              },
              {
                reaction_id: 'react-bot-phase',
                reaction_type: { emoji_type: 'Eye' },
                operator: { open_id: 'ou_bot' },
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0 }) });

    await notifier.notify({
      event_id: 'evt-6',
      task_id: 'task-1',
      phase: 'queued',
      task_source: { source: 'lark', message_id: 'om_1' },
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(2,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_1/reactions/react-bot-phase',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://open.larksuite.com/open-apis/im/v1/messages/om_1/reactions/react-user-phase',
      expect.anything(),
    );
    expect(mockFetch).not.toHaveBeenCalledWith(
      'https://open.larksuite.com/open-apis/im/v1/messages/om_1/reactions/react-bot-non-phase',
      expect.anything(),
    );
  });
});

describe('clearBotOwnedPhaseReactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns deleted count for bot-owned phase reactions only', async () => {
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
                reaction_type: { emoji_type: 'OnIt' },
                operator: { open_id: 'ou_bot' },
              },
              {
                reaction_id: 'react-2',
                reaction_type: { emoji_type: 'OnIt' },
                operator: { open_id: 'ou_user' },
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ code: 0 }) });

    const deleted = await clearBotOwnedPhaseReactions({
      messageId: 'om_1',
      token: 'token-abc',
      expectedReactionTypes: ['OnIt', 'Eye'],
    });

    expect(deleted).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
