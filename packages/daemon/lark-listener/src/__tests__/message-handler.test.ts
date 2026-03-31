import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageHandler } from '../message-handler';
import type { TaskSubmitter } from '../adapters/task-submitter';
import type { LarkReactor } from '../adapters/lark-reactor';
import type { DedupMap } from '../services/dedup';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    sender: {
      sender_id: { open_id: 'ou_sender1' },
      sender_type: 'user',
    },
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
  let dedup: { has: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    submitter = { submit: vi.fn().mockResolvedValue('task-abc') };
    reactor = { react: vi.fn().mockResolvedValue(undefined) };
    dedup = { has: vi.fn().mockReturnValue(false), add: vi.fn() };
    handler = new MessageHandler(
      submitter as unknown as TaskSubmitter,
      reactor as unknown as LarkReactor,
      dedup as unknown as DedupMap,
    );
  });

  it('submits text message as plain string payload', async () => {
    await handler.handle(makeEvent());

    expect(submitter.submit).toHaveBeenCalledWith('fix the CI pipeline');
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    expect(dedup.add).toHaveBeenCalledWith('om_msg1');
  });

  it('skips duplicate messages', async () => {
    dedup.has.mockReturnValue(true);

    await handler.handle(makeEvent());

    expect(submitter.submit).not.toHaveBeenCalled();
    expect(reactor.react).not.toHaveBeenCalled();
  });

  it('submits image message as JSON payload', async () => {
    await handler.handle(
      makeEvent({
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_abc' }),
      }),
    );

    const payload = submitter.submit.mock.calls[0][0];
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe('image');
    expect(parsed.key).toBe('img_v3_abc');
  });

  it('submits file message as JSON payload', async () => {
    await handler.handle(
      makeEvent({
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_v3_xyz', file_name: 'report.pdf' }),
      }),
    );

    const payload = submitter.submit.mock.calls[0][0];
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe('file');
    expect(parsed.key).toBe('file_v3_xyz');
    expect(parsed.name).toBe('report.pdf');
  });

  it('submits post (rich text) message as JSON payload', async () => {
    const postContent = { title: 'Title', content: [[{ tag: 'text', text: 'hello' }]] };
    await handler.handle(
      makeEvent({
        message_type: 'post',
        content: JSON.stringify(postContent),
      }),
    );

    const payload = submitter.submit.mock.calls[0][0];
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe('post');
    expect(parsed.content).toEqual(postContent);
  });

  it('submits unknown message type as JSON with raw content', async () => {
    await handler.handle(
      makeEvent({
        message_type: 'sticker',
        content: JSON.stringify({ sticker_id: 'sticker_abc' }),
      }),
    );

    const payload = submitter.submit.mock.calls[0][0];
    const parsed = JSON.parse(payload);
    expect(parsed.type).toBe('sticker');
  });

  it('still reacts even if submit returns null (failure)', async () => {
    submitter.submit.mockResolvedValue(null);

    await handler.handle(makeEvent());

    // React is still called (we tried, task submission just failed)
    expect(dedup.add).toHaveBeenCalledWith('om_msg1');
  });

  it('handles malformed content JSON gracefully', async () => {
    await handler.handle(
      makeEvent({ content: 'not json' }),
    );

    // Should still attempt to submit with fallback
    expect(submitter.submit).toHaveBeenCalled();
    const payload = submitter.submit.mock.calls[0][0];
    expect(payload).toBe('not json');
  });
});
