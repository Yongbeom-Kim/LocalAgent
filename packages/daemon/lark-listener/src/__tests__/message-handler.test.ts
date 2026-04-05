import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageHandler } from '../message-handler';
import type { TaskSubmitter } from '../adapters/task-submitter';
import type { LarkReactor } from '../adapters/lark-reactor';
import type { LarkReplier } from '../adapters/lark-replier';
import type { DedupMap } from '../services/dedup';
import { isValidLarkInboundEnvelope, LARK_INBOUND_SCHEMA_VERSION_V1 } from '@local-agent/shared';
import type { LarkMessageMetadataResolver } from '../message-handler';

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
      content: JSON.stringify({ text: 'fix the CI pipeline' }),
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

  beforeEach(() => {
    submitter = { submit: vi.fn().mockResolvedValue('task-abc') };
    reactor = { react: vi.fn().mockResolvedValue(undefined) };
    replier = { reply: vi.fn().mockResolvedValue(null), replyEnqueueFailure: vi.fn().mockResolvedValue(null) };
    dedup = { has: vi.fn().mockReturnValue(false), add: vi.fn() };
    metadataResolver = {
      resolve: vi.fn().mockResolvedValue({ rootMessageId: 'om_msg1', threadId: null }),
    };
    handler = new MessageHandler(
      submitter as unknown as TaskSubmitter,
      reactor as unknown as LarkReactor,
      replier as unknown as LarkReplier,
      dedup as unknown as DedupMap,
      metadataResolver as unknown as LarkMessageMetadataResolver,
    );
  });

  it('submits inbound messages as lark_inbound envelope and reacts on success', async () => {
    await handler.handle(makeEvent());

    expect(submitter.submit).toHaveBeenCalledTimes(1);
    expect(submitter.submit.mock.calls[0][0]).toBe('lark_inbound');
    expect(submitter.submit.mock.calls[0][2]).toEqual({ source: 'lark', message_id: 'om_msg1' });

    const envelope = JSON.parse(submitter.submit.mock.calls[0][1]);
    expect(isValidLarkInboundEnvelope(envelope)).toBe(true);
    expect(envelope).toEqual(
      expect.objectContaining({
        platform: 'lark',
        schema_version: LARK_INBOUND_SCHEMA_VERSION_V1,
        message_id: 'om_msg1',
        root_message_id: 'om_msg1',
        thread_id: null,
        chat_type: 'p2p',
        sender_open_id: 'ou_sender1',
        sender_type: 'user',
        message_type: 'text',
        raw_content: JSON.stringify({ text: 'fix the CI pipeline' }),
        occurred_at_ms: 1700000001000,
        is_normalizable: true,
        normalized_text: 'fix the CI pipeline',
      }),
    );

    expect(replier.replyEnqueueFailure).not.toHaveBeenCalled();
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
  });

  it('skips duplicate messages', async () => {
    dedup.has.mockReturnValue(true);

    await handler.handle(makeEvent());

    expect(submitter.submit).not.toHaveBeenCalled();
    expect(reactor.react).not.toHaveBeenCalled();
  });

  it('submits non-normalizable message types with is_normalizable=false and no normalized_text', async () => {
    await handler.handle(
      makeEvent({
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_abc' }),
      }),
    );

    const envelope = JSON.parse(submitter.submit.mock.calls[0][1]);
    expect(envelope).toEqual(
      expect.objectContaining({
        message_type: 'image',
        is_normalizable: false,
      }),
    );
    expect('normalized_text' in envelope).toBe(false);
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
  });

  it('replies with generic message and does not react when enqueue fails', async () => {
    submitter.submit.mockResolvedValue(null);

    await handler.handle(
      makeEvent({
        content: JSON.stringify({
          text: '/task code_review cursor gpt-5.4-medium-fast review the failing tests',
        }),
      }),
    );

    expect(dedup.add).toHaveBeenCalledWith('om_msg1');
    expect(replier.replyEnqueueFailure).toHaveBeenCalledWith('om_msg1');
    expect(reactor.react).not.toHaveBeenCalled();
  });

  it('enqueues malformed command shapes (no local validation)', async () => {
    await handler.handle(
      makeEvent({
        content: JSON.stringify({ text: '/task code_review' }),
      }),
    );

    const envelope = JSON.parse(submitter.submit.mock.calls[0][1]);
    expect(envelope).toEqual(
      expect.objectContaining({
        is_normalizable: true,
        normalized_text: '/task code_review',
      }),
    );
  });

  it('uses identity resolution fallback when resolver fails', async () => {
    metadataResolver.resolve.mockResolvedValueOnce({ rootMessageId: 'om_msg1', threadId: null });
    await handler.handle(makeEvent());

    const envelope = JSON.parse(submitter.submit.mock.calls[0][1]);
    expect(envelope.root_message_id).toBe('om_msg1');
    expect(envelope.thread_id).toBe(null);
  });

  it('normalizes mentions into open_id list', async () => {
    await handler.handle(
      makeEvent({
        mentions: [
          { key: '@_user_1', name: 'Alice', id: { open_id: 'ou_alice' } },
          { key: '@_user_2', name: 'Bob', id: { open_id: 'ou_bob' } },
        ],
      }),
    );

    const envelope = JSON.parse(submitter.submit.mock.calls[0][1]);
    expect(envelope.mentions).toEqual([
      { key: '@_user_1', name: 'Alice', open_id: 'ou_alice' },
      { key: '@_user_2', name: 'Bob', open_id: 'ou_bob' },
    ]);
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
