import { describe, expect, it } from 'vitest';
import {
  classifyLarkInboundEnvelope,
  formatGcCommandUsageMessage,
  formatThreadOnlyCommandMessage,
  formatThreadReplyHelpMessage,
  formatThreadTaskCommandRejectedMessage,
  GC_THREAD_REJECTION_REASON,
  ROOT_TASK_USAGE_HINT,
  type LarkInboundEnvelope,
  type Task,
} from '../index';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'task-123',
    task_type: 'lark_inbound',
    payload: '{}',
    submitted_at: '2026-04-05T00:00:00.000Z',
    ...overrides,
  };
}

function createEnvelope(overrides: Partial<LarkInboundEnvelope> = {}): LarkInboundEnvelope {
  const base: LarkInboundEnvelope = {
    platform: 'lark',
    schema_version: 1,
    message_id: 'om_root',
    root_message_id: 'om_root',
    thread_id: null,
    chat_type: 'p2p',
    sender_open_id: 'ou_sender',
    sender_type: 'user',
    message_type: 'text',
    raw_content: '{"text":"/task deploy claude sonnet ship it"}',
    normalized_text: '/task deploy claude sonnet ship it',
    mentions: [],
    is_normalizable: true,
    occurred_at_ms: 1710000000000,
  };

  return {
    ...base,
    ...overrides,
  } as LarkInboundEnvelope;
}

describe('classifyLarkInboundEnvelope', () => {
  it('accepts root /task commands and preserves routing fields', () => {
    const result = classifyLarkInboundEnvelope(createTask(), createEnvelope());

    expect(result).toEqual({
      kind: 'accepted',
      task: expect.objectContaining({
        task_type: 'deploy',
        payload: 'ship it',
        executor: 'claude',
        executor_model: 'sonnet',
        task_source: { source: 'lark', message_id: 'om_root' },
      }),
      envelope: createEnvelope(),
      shouldMaterializeRootState: true,
    });
  });

  it('rejects malformed root /task commands with the root usage hint', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({ normalized_text: '/task deploy', raw_content: '{"text":"/task deploy"}' }),
    );

    expect(result).toEqual({
      kind: 'rejected',
      task: expect.objectContaining({
        task_type: 'deploy',
        task_source: { source: 'lark', message_id: 'om_root' },
      }),
      reason: ROOT_TASK_USAGE_HINT,
    });
  });

  it('rejects threaded /task commands', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({
        message_id: 'om_reply',
        root_message_id: 'om_root',
        thread_id: 'omt_1',
        normalized_text: '/task deploy claude sonnet nope',
      }),
    );

    expect(result).toEqual({
      kind: 'rejected',
      task: expect.objectContaining({
        task_type: 'deploy',
        task_source: { source: 'lark', message_id: 'om_reply' },
      }),
      reason: formatThreadTaskCommandRejectedMessage(),
    });
  });

  it('accepts threaded natural-language replies as thread_reply', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({
        message_id: 'om_reply',
        root_message_id: 'om_root',
        thread_id: 'omt_1',
        normalized_text: 'please continue',
        raw_content: '{"text":"please continue"}',
      }),
    );

    expect(result).toEqual({
      kind: 'accepted',
      task: expect.objectContaining({
        task_type: 'thread_reply',
        payload: 'please continue',
        executor: undefined,
        executor_model: undefined,
        task_source: { source: 'lark', message_id: 'om_reply' },
      }),
      envelope: expect.objectContaining({ message_id: 'om_reply' }),
      shouldMaterializeRootState: false,
    });
  });

  it('accepts threaded /new overrides', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({
        message_id: 'om_reply',
        root_message_id: 'om_root',
        thread_id: 'omt_1',
        normalized_text: '/new cursor auto',
        raw_content: '{"text":"/new cursor auto"}',
      }),
    );

    expect(result).toEqual({
      kind: 'accepted',
      task: expect.objectContaining({
        task_type: 'new_instance',
        payload: '',
        executor: 'cursor',
        executor_model: 'auto',
      }),
      envelope: expect.objectContaining({ message_id: 'om_reply' }),
      shouldMaterializeRootState: false,
    });
  });

  it('rejects root /new commands as thread-only', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({ normalized_text: '/new', raw_content: '{"text":"/new"}' }),
    );

    expect(result).toEqual({
      kind: 'rejected',
      task: expect.objectContaining({ task_type: 'new_instance' }),
      reason: formatThreadOnlyCommandMessage('/new'),
    });
  });

  it('rejects threaded /gc commands', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({
        message_id: 'om_reply',
        root_message_id: 'om_root',
        thread_id: 'omt_1',
        normalized_text: '/gc',
        raw_content: '{"text":"/gc"}',
      }),
    );

    expect(result).toEqual({
      kind: 'rejected',
      task: expect.objectContaining({ task_type: 'gc' }),
      reason: GC_THREAD_REJECTION_REASON,
    });
  });

  it('accepts root /gc commands with an age parameter', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({ normalized_text: '/gc 24h', raw_content: '{"text":"/gc 24h"}' }),
    );

    expect(result).toEqual({
      kind: 'accepted',
      task: expect.objectContaining({
        task_type: 'gc',
        payload: '24h',
        executor: undefined,
        executor_model: undefined,
        task_source: { source: 'lark', message_id: 'om_root' },
      }),
      envelope: expect.objectContaining({ normalized_text: '/gc 24h' }),
      shouldMaterializeRootState: true,
    });
  });

  it('rejects invalid root /gc arguments with usage help', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({ normalized_text: '/gc later', raw_content: '{"text":"/gc later"}' }),
    );

    expect(result).toEqual({
      kind: 'rejected',
      task: expect.objectContaining({
        task_type: 'gc',
        task_source: { source: 'lark', message_id: 'om_root' },
      }),
      reason: formatGcCommandUsageMessage(),
    });
  });

  it('accepts threaded /shell commands as a control task', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({
        message_id: 'om_reply',
        root_message_id: 'om_root',
        thread_id: 'omt_1',
        normalized_text: '/shell ls -la',
        raw_content: '{"text":"/shell ls -la"}',
      }),
    );

    expect(result).toEqual({
      kind: 'accepted',
      task: expect.objectContaining({
        task_type: 'shell_command',
        payload: 'ls -la',
        executor: undefined,
        executor_model: undefined,
        task_source: { source: 'lark', message_id: 'om_reply' },
      }),
      envelope: expect.objectContaining({ message_id: 'om_reply' }),
      shouldMaterializeRootState: false,
    });
  });

  it('rejects root /shell commands as thread-only', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({ normalized_text: '/shell ls', raw_content: '{"text":"/shell ls"}' }),
    );

    expect(result).toEqual({
      kind: 'rejected',
      task: expect.objectContaining({ task_type: 'shell_command' }),
      reason: formatThreadOnlyCommandMessage('/shell'),
    });
  });

  it('rejects bare threaded /shell commands', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({
        message_id: 'om_reply',
        root_message_id: 'om_root',
        thread_id: 'omt_1',
        normalized_text: '/shell',
        raw_content: '{"text":"/shell"}',
      }),
    );

    expect(result).toEqual({
      kind: 'rejected',
      task: expect.objectContaining({ task_type: 'shell_command' }),
      reason: 'Usage: /shell <command>',
    });
  });

  it('rejects threaded /shell commands with trailing newline content', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({
        message_id: 'om_reply',
        root_message_id: 'om_root',
        thread_id: 'omt_1',
        normalized_text: '/shell ls\nnext',
        raw_content: '{"text":"/shell ls\\nnext"}',
      }),
    );

    expect(result).toEqual({
      kind: 'rejected',
      task: expect.objectContaining({ task_type: 'shell_command' }),
      reason: 'Usage: /shell <command>',
    });
  });

  it('rejects non-normalizable threaded input with thread help', () => {
    const result = classifyLarkInboundEnvelope(
      createTask(),
      createEnvelope({
        message_id: 'om_reply',
        root_message_id: 'om_root',
        thread_id: 'omt_1',
        message_type: 'image',
        raw_content: '{"image_key":"img_1"}',
        is_normalizable: false,
        normalized_text: undefined,
      } as unknown as Partial<LarkInboundEnvelope>),
    );

    expect(result).toEqual({
      kind: 'rejected',
      task: expect.objectContaining({ task_type: 'thread_reply' }),
      reason: formatThreadReplyHelpMessage(),
    });
  });
});
