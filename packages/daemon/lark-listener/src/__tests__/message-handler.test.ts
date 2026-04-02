import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageHandler } from '../message-handler';
import type { TaskSubmitter } from '../adapters/task-submitter';
import type { LarkReactor } from '../adapters/lark-reactor';
import type { LarkReplier } from '../adapters/lark-replier';
import type { DedupMap } from '../services/dedup';

const USAGE_HINT = 'Usage: /task <type> <executor> <model> <payload> or /end (in a thread)';

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

  it('rejects plain text messages with the usage hint', async () => {
    await handler.handle(makeEvent());

    expect(submitter.submit).not.toHaveBeenCalled();
    expect(replier.reply).toHaveBeenCalledWith('om_msg1', USAGE_HINT);
    expect(reactor.react).not.toHaveBeenCalled();
  });

  it('skips duplicate messages', async () => {
    dedup.has.mockReturnValue(true);

    await handler.handle(makeEvent());

    expect(submitter.submit).not.toHaveBeenCalled();
    expect(reactor.react).not.toHaveBeenCalled();
  });

  it('rejects non-text messages with the usage hint', async () => {
    await handler.handle(
      makeEvent({
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_abc' }),
      }),
    );

    expect(submitter.submit).not.toHaveBeenCalled();
    expect(replier.reply).toHaveBeenCalledWith('om_msg1', USAGE_HINT);
  });

  it('still reacts even if submit returns null (failure)', async () => {
    submitter.submit.mockResolvedValue(null);

    await handler.handle(
      makeEvent({
        content: JSON.stringify({
          text: '/task code_review cursor gpt-5.4-medium-fast review the failing tests',
        }),
      }),
    );

    expect(dedup.add).toHaveBeenCalledWith('om_msg1');
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
  });

  describe('/task command parsing', () => {
    it('submits /task <type> <executor> <model> <payload> with explicit routing', async () => {
      await handler.handle(
        makeEvent({
          content: JSON.stringify({
            text: '/task code_review cursor gpt-5.4-medium-fast review this diff',
          }),
        }),
      );

      expect(submitter.submit).toHaveBeenCalledWith(
        'code_review',
        'review this diff',
        { source: 'lark', message_id: 'om_msg1' },
        'cursor',
        'gpt-5.4-medium-fast',
      );
      expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    });

    it('preserves multiline payload after the first line', async () => {
      await handler.handle(
        makeEvent({
          content: JSON.stringify({
            text: '/task code_review claude sonnet review this diff\nand explain the risk',
          }),
        }),
      );

      expect(submitter.submit).toHaveBeenCalledWith(
        'code_review',
        'review this diff\nand explain the risk',
        { source: 'lark', message_id: 'om_msg1' },
        'claude',
        'sonnet',
      );
    });

    it('replies with usage hint for bare /task and does not submit', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/task' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(reactor.react).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalledWith('om_msg1', USAGE_HINT);
    });

    it('rejects /task with only type', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/task code_review' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalledWith('om_msg1', USAGE_HINT);
    });

    it('rejects /task with only type and executor', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/task code_review claude' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalledWith('om_msg1', USAGE_HINT);
    });

    it('rejects /task when payload would start on next line', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/task code_review claude sonnet\nreview this' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalledWith('om_msg1', USAGE_HINT);
    });

    it('does not treat /taskforce as /task', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/taskforce code_review claude sonnet x' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalledWith('om_msg1', USAGE_HINT);
    });

    it('submits bare /gc as gc with empty payload', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/gc' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'gc',
        '',
        { source: 'lark', message_id: 'om_msg1' },
        undefined,
        undefined,
      );
      expect(replier.reply).not.toHaveBeenCalled();
      expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    });

    it('replies with usage hint for /gc with args', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/gc foo' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalledWith('om_msg1', USAGE_HINT);
    });

    it('submits bare /end as cleanup with empty payload', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/end' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'cleanup',
        '',
        { source: 'lark', message_id: 'om_msg1' },
        undefined,
        undefined,
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
      expect(replier.reply).toHaveBeenCalledWith('om_msg1', USAGE_HINT);
    });

    it('submits bare /new as new_instance with empty payload', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/new' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'new_instance',
        '',
        { source: 'lark', message_id: 'om_msg1' },
        undefined,
        undefined,
      );
      expect(replier.reply).not.toHaveBeenCalled();
      expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    });

    it('rejects /new with only one arg', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/new cursor' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalledWith('om_msg1', USAGE_HINT);
    });

    it('rejects /new with more than two args', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/new cursor gpt-5.4-medium-fast extra' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalled();
    });

    it('submits explicit /new using structured executor fields', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/new claude sonnet' }),
      }));

      expect(submitter.submit).toHaveBeenCalledWith(
        'new_instance',
        '',
        { source: 'lark', message_id: 'om_msg1' },
        'claude',
        'sonnet',
      );
      expect(replier.reply).not.toHaveBeenCalled();
      expect(reactor.react).toHaveBeenCalledWith('om_msg1');
    });

    it('does not treat /newfoo as a /new command', async () => {
      await handler.handle(makeEvent({
        content: JSON.stringify({ text: '/newfoo' }),
      }));

      expect(submitter.submit).not.toHaveBeenCalled();
      expect(replier.reply).toHaveBeenCalledWith('om_msg1', USAGE_HINT);
    });
  });
});
