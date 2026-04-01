import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageHandler } from '../message-handler';
import type { TaskSubmitter } from '../adapters/task-submitter';
import type { LarkReactor } from '../adapters/lark-reactor';
import type { LarkReplier } from '../adapters/lark-replier';
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
  let replier: { reply: ReturnType<typeof vi.fn> };
  let dedup: { has: ReturnType<typeof vi.fn>; add: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    submitter = { submit: vi.fn().mockResolvedValue('task-abc') };
    reactor = { react: vi.fn().mockResolvedValue(undefined) };
    replier = { reply: vi.fn().mockResolvedValue(undefined) };
    dedup = { has: vi.fn().mockReturnValue(false), add: vi.fn() };
    handler = new MessageHandler(
      submitter as unknown as TaskSubmitter,
      reactor as unknown as LarkReactor,
      replier as unknown as LarkReplier,
      dedup as unknown as DedupMap,
    );
  });

  it('submits text message as plain string payload with task_source', async () => {
    await handler.handle(makeEvent());

    expect(submitter.submit).toHaveBeenCalledWith(
      'generic',
      'fix the CI pipeline',
      { source: 'lark', message_id: 'om_msg1' },
    );
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    expect(dedup.add).toHaveBeenCalledWith('om_msg1');
  });

  it('skips duplicate messages', async () => {
    dedup.has.mockReturnValue(true);

    await handler.handle(makeEvent());

    expect(submitter.submit).not.toHaveBeenCalled();
    expect(reactor.react).not.toHaveBeenCalled();
  });

  it('submits image message with task_source', async () => {
    await handler.handle(
      makeEvent({
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_abc' }),
      }),
    );

    const taskType = submitter.submit.mock.calls[0][0];
    const payload = submitter.submit.mock.calls[0][1];
    const taskSource = submitter.submit.mock.calls[0][2];
    const parsed = JSON.parse(payload);
    expect(taskType).toBe('generic');
    expect(parsed.type).toBe('image');
    expect(parsed.key).toBe('img_v3_abc');
    expect(taskSource).toEqual({ source: 'lark', message_id: 'om_msg1' });
  });

  it('submits file message as JSON payload', async () => {
    await handler.handle(
      makeEvent({
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_v3_xyz', file_name: 'report.pdf' }),
      }),
    );

    const taskType = submitter.submit.mock.calls[0][0];
    const payload = submitter.submit.mock.calls[0][1];
    const parsed = JSON.parse(payload);
    expect(taskType).toBe('generic');
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

    const taskType = submitter.submit.mock.calls[0][0];
    const payload = submitter.submit.mock.calls[0][1];
    const parsed = JSON.parse(payload);
    expect(taskType).toBe('generic');
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

    const taskType = submitter.submit.mock.calls[0][0];
    const payload = submitter.submit.mock.calls[0][1];
    const parsed = JSON.parse(payload);
    expect(taskType).toBe('generic');
    expect(parsed.type).toBe('sticker');
  });

  it('still reacts even if submit returns null (failure)', async () => {
    submitter.submit.mockResolvedValue(null);

    await handler.handle(makeEvent());

    // React is still called even though task submission failed
    expect(dedup.add).toHaveBeenCalledWith('om_msg1');
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
  });

  it('handles malformed content JSON gracefully', async () => {
    await handler.handle(
      makeEvent({ content: 'not json' }),
    );

    // Should still attempt to submit with fallback
    expect(submitter.submit).toHaveBeenCalled();
    const taskType = submitter.submit.mock.calls[0][0];
    const payload = submitter.submit.mock.calls[0][1];
    expect(taskType).toBe('generic');
    expect(payload).toBe('not json');
  });

  describe('/task command parsing', () => {
    it('parses /task <type> <payload> and submits with correct task_type', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/task code_review fix the login bug' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'code_review',
        'fix the login bug',
        { source: 'lark', message_id: 'om_msg1' },
      );
      expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    });

    it('parses /task <type> with no payload (empty payload)', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/task code_review' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'code_review',
        '',
        { source: 'lark', message_id: 'om_msg1' },
      );
    });

    it('preserves multiline payload', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/task review fix this\nand that too' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'review',
        'fix this\nand that too',
        { source: 'lark', message_id: 'om_msg1' },
      );
    });

    it('replies with usage hint for bare /task and does not submit', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/task' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(reactor.react).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalledWith(
        'om_msg1',
        'Usage: /task <type> <payload> or /end (in a thread)',
      );
    });

    it('replies with usage hint for /task with only whitespace after', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/task   ' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalledWith(
        'om_msg1',
        'Usage: /task <type> <payload> or /end (in a thread)',
      );
    });

    it('submits bare /gc as gc with empty payload', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/gc' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'gc',
        '',
        { source: 'lark', message_id: 'om_msg1' },
      );
      expect(replier.reply).not.toHaveBeenCalled();
      expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    });

    it('does not treat /gc with args as a gc command', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/gc foo' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'generic',
        '/gc foo',
        { source: 'lark', message_id: 'om_msg1' },
      );
      expect(replier.reply).not.toHaveBeenCalled();
    });

    it('does not treat /gcollect as a gc command', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/gcollect' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'generic',
        '/gcollect',
        { source: 'lark', message_id: 'om_msg1' },
      );
      expect(replier.reply).not.toHaveBeenCalled();
    });

    it('submits bare /end as cleanup with empty payload', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/end' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'cleanup',
        '',
        { source: 'lark', message_id: 'om_msg1' },
      );
      expect(replier.reply).not.toHaveBeenCalled();
      expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    });

    it('replies with usage hint for /end with args and does not submit', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/end now' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(reactor.react).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalledWith(
        'om_msg1',
        'Usage: /task <type> <payload> or /end (in a thread)',
      );
    });

    it('does not treat /ending as an /end command', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/ending cleanup soon' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'generic',
        '/ending cleanup soon',
        { source: 'lark', message_id: 'om_msg1' },
      );
      expect(replier.reply).not.toHaveBeenCalled();
    });

    it('submits plain messages as task_type generic (no /task prefix)', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: 'just a regular message' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'generic',
        'just a regular message',
        { source: 'lark', message_id: 'om_msg1' },
      );
    });

    it('does not treat /taskforce as a /task command (must have word boundary)', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/taskforce deploy' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'generic',
        '/taskforce deploy',
        { source: 'lark', message_id: 'om_msg1' },
      );
      expect(replier.reply).not.toHaveBeenCalled();
    });
  });
});
