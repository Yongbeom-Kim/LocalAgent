import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramUpdatePoller } from '../telegram-update-poller';

describe('TelegramUpdatePoller', () => {
  const topicManager = {
    getUpdates: vi.fn(),
    getChat: vi.fn(),
  };
  const taskSubmitter = {
    submit: vi.fn(),
  };
  const phasePublisher = {
    publishReceived: vi.fn(),
    publishCompletedSyntheticFailure: vi.fn(),
  };
  const sessionResolver = {
    resolve: vi.fn(),
  };

  let poller: TelegramUpdatePoller;

  beforeEach(() => {
    vi.clearAllMocks();
    poller = new TelegramUpdatePoller(
      '-100456789',
      topicManager,
      taskSubmitter as any,
      phasePublisher as any,
      sessionResolver as any,
    );
  });

  it('rejects updates from chats other than the configured forum group', async () => {
    topicManager.getUpdates.mockResolvedValue([{ update_id: 1, message: { message_id: 10, date: 1, chat: { id: 1 }, text: 'hi' } }]);

    await poller.pollOnce();

    expect(taskSubmitter.submit).not.toHaveBeenCalled();
    expect(phasePublisher.publishCompletedSyntheticFailure).not.toHaveBeenCalled();
  });

  it('publishes a synthetic failure result for messages in the configured forum group that are not in a topic', async () => {
    topicManager.getUpdates.mockResolvedValue([
      { update_id: 1, message: { message_id: 10, date: 1, from: { id: 7, is_bot: false }, chat: { id: -100456789 }, text: 'hi' } },
    ]);
    topicManager.getChat.mockResolvedValue({ id: -100456789, is_forum: true });

    await poller.pollOnce();

    expect(phasePublisher.publishCompletedSyntheticFailure).toHaveBeenCalledWith(expect.objectContaining({
      taskSource: { source: 'telegram', chat_id: '-100456789', message_id: '10' },
      sessionId: 'telegram-reject:-100456789:10',
    }));
  });

  it('publishes canonical telegram task with session_id instead of telegram_inbound envelope', async () => {
    topicManager.getUpdates.mockResolvedValue([
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 1,
          message_thread_id: 42,
          from: { id: 7, is_bot: false },
          chat: { id: -100456789 },
          text: 'follow up',
        },
      },
    ]);
    topicManager.getChat.mockResolvedValue({ id: -100456789, is_forum: true });
    sessionResolver.resolve.mockResolvedValue({
      kind: 'accepted',
      task: {
        taskType: 'thread_reply',
        payload: 'follow up',
        taskSource: { source: 'telegram', chat_id: '-100456789', topic_id: '42', message_id: '10' },
        sessionId: 'sess-1',
        contextRef: { platform: 'telegram', root_key: '-100456789:42' },
      },
    });
    taskSubmitter.submit.mockResolvedValue('task-123');

    await poller.pollOnce();

    expect(taskSubmitter.submit).toHaveBeenCalledWith(
      'thread_reply',
      'follow up',
      { source: 'telegram', chat_id: '-100456789', topic_id: '42', message_id: '10' },
      undefined,
      undefined,
      { sessionId: 'sess-1', contextRef: { platform: 'telegram', root_key: '-100456789:42' } },
    );
    expect(phasePublisher.publishReceived).toHaveBeenCalledWith({
      taskId: 'task-123',
      taskType: 'thread_reply',
      taskSource: { source: 'telegram', chat_id: '-100456789', topic_id: '42', message_id: '10' },
      sessionId: 'sess-1',
    });
  });
});
