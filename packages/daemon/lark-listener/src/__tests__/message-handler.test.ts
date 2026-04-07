import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHandler } from '../message-handler';
import type { TaskSubmitter } from '../adapters/task-submitter';
import type { LarkReactor } from '../adapters/lark-reactor';
import type { LarkReplier } from '../adapters/lark-replier';
import type { DedupMap } from '../services/dedup';
import type { LarkMessageMetadataResolver } from '../message-handler';
import type { LarkSessionResolver } from '../adapters/lark-session-resolver';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    sender: {
      sender_id: { open_id: 'ou_sender1' },
      sender_type: 'user',
    },
    event_time: '1700000001',
    message: {
      message_id: 'om_msg1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '/task code_review claude sonnet fix the CI pipeline' }),
      mentions: [],
      ...overrides,
    },
  };
}

describe('MessageHandler', () => {
  let handler: MessageHandler;
  let submitter: { submit: ReturnType<typeof vi.fn> };
  let reactor: { react: ReturnType<typeof vi.fn> };
  let replier: { reply: ReturnType<typeof vi.fn>; replyEnqueueFailure: ReturnType<typeof vi.fn> };
  let dedup: { has: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> };
  let metadataResolver: { resolve: ReturnType<typeof vi.fn> };
  let sessionResolver: { resolve: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    submitter = { submit: vi.fn().mockResolvedValue('task-abc') };
    reactor = { react: vi.fn().mockResolvedValue(undefined) };
    replier = { reply: vi.fn().mockResolvedValue(null), replyEnqueueFailure: vi.fn().mockResolvedValue(null) };
    dedup = { has: vi.fn().mockReturnValue(false), add: vi.fn() };
    metadataResolver = {
      resolve: vi.fn().mockResolvedValue({ rootMessageId: 'om_msg1', threadId: null }),
    };
    sessionResolver = {
      resolve: vi.fn().mockResolvedValue({
        kind: 'accepted',
        task: {
          taskType: 'code_review',
          payload: 'fix the CI pipeline',
          taskSource: { source: 'lark', message_id: 'om_msg1' },
          sessionId: 'sess-1',
          contextRef: { platform: 'lark', root_key: 'om_msg1' },
          executor: 'claude',
          executorModel: 'sonnet',
        },
      }),
    };
    handler = new MessageHandler(
      submitter as unknown as TaskSubmitter,
      reactor as unknown as LarkReactor,
      replier as unknown as LarkReplier,
      dedup as unknown as DedupMap,
      metadataResolver as unknown as LarkMessageMetadataResolver,
      sessionResolver as unknown as LarkSessionResolver,
    );
  });

  it('publishes a root /task message as a canonical task with session_id', async () => {
    await handler.handle(makeEvent());

    expect(submitter.submit).toHaveBeenCalledWith(
      'code_review',
      'fix the CI pipeline',
      { source: 'lark', message_id: 'om_msg1' },
      'claude',
      'sonnet',
      { sessionId: 'sess-1', contextRef: { platform: 'lark', root_key: 'om_msg1' } },
    );
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    expect(replier.replyEnqueueFailure).not.toHaveBeenCalled();
  });

  it('reuses the mapped session_id for thread follow-up messages', async () => {
    metadataResolver.resolve.mockResolvedValueOnce({ rootMessageId: 'om_root1', threadId: 'omt_1' });
    sessionResolver.resolve.mockResolvedValueOnce({
      kind: 'accepted',
      task: {
        taskType: 'thread_reply',
        payload: 'follow up',
        taskSource: { source: 'lark', message_id: 'om_msg1' },
        sessionId: 'sess-existing',
        contextRef: { platform: 'lark', root_key: 'om_root1' },
      },
    });

    await handler.handle(makeEvent({ content: JSON.stringify({ text: 'follow up' }) }));

    expect(submitter.submit).toHaveBeenCalledWith(
      'thread_reply',
      'follow up',
      { source: 'lark', message_id: 'om_msg1' },
      undefined,
      undefined,
      { sessionId: 'sess-existing', contextRef: { platform: 'lark', root_key: 'om_root1' } },
    );
  });

  it('skips duplicate messages', async () => {
    dedup.has.mockReturnValue(true);
    await handler.handle(makeEvent());
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(reactor.react).not.toHaveBeenCalled();
  });

  it('replies with generic message and does not react when enqueue fails', async () => {
    submitter.submit.mockResolvedValue(null);
    await handler.handle(makeEvent());
    expect(dedup.add).toHaveBeenCalledWith('om_msg1');
    expect(replier.replyEnqueueFailure).toHaveBeenCalledWith('om_msg1');
    expect(reactor.react).not.toHaveBeenCalled();
  });

  it('does not enqueue when resolver rejects the message', async () => {
    sessionResolver.resolve.mockResolvedValueOnce({ kind: 'rejected', reason: 'bad command' });
    await handler.handle(makeEvent({ content: JSON.stringify({ text: '/task code_review' }) }));
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(replier.replyEnqueueFailure).toHaveBeenCalledWith('om_msg1');
  });

  it('does not enqueue when message_id is missing; best-effort does not reply', async () => {
    await handler.handle(makeEvent({ message_id: undefined }));
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(replier.replyEnqueueFailure).not.toHaveBeenCalled();
  });

  it('does not enqueue when content is missing; best-effort replies if message_id exists', async () => {
    await handler.handle(makeEvent({ content: undefined }));
    expect(submitter.submit).not.toHaveBeenCalled();
    expect(replier.replyEnqueueFailure).toHaveBeenCalledWith('om_msg1');
  });
});
