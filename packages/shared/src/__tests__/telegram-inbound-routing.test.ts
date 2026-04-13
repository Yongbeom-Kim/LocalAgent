import { describe, expect, it } from 'vitest';
import {
  classifyTelegramInboundEnvelope,
  formatThreadOnlyCommandMessage,
  formatThreadTaskCommandRejectedMessage,
  TELEGRAM_INBOUND_SCHEMA_VERSION_V1,
  type Task,
  type TelegramInboundEnvelope,
} from '../index';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'task-123',
    task_type: 'telegram_inbound',
    payload: '{}',
    submitted_at: '2026-04-06T00:00:00.000Z',
    session_id: 'pending:telegram:-100123:42',
    ...overrides,
  };
}

function createEnvelope(overrides: Partial<TelegramInboundEnvelope> = {}): TelegramInboundEnvelope {
  const base: TelegramInboundEnvelope = {
    platform: 'telegram',
    schema_version: TELEGRAM_INBOUND_SCHEMA_VERSION_V1,
    chat_id: '-100123',
    topic_id: '42',
    message_id: '99',
    sender_id: '12345',
    sender_is_bot: false,
    message_type: 'text',
    raw_content: '/task deploy claude sonnet ship it',
    normalized_text: '/task deploy claude sonnet ship it',
    is_normalizable: true,
    occurred_at_ms: 1710000000000,
  };

  return {
    ...base,
    ...overrides,
  } as TelegramInboundEnvelope;
}

describe('classifyTelegramInboundEnvelope', () => {
  it('accepts a root /task command in an unmapped topic', () => {
    const result = classifyTelegramInboundEnvelope(createTask(), createEnvelope(), false);

    expect(result).toEqual({
      kind: 'accepted',
      task: expect.objectContaining({
        task_type: 'deploy',
        payload: 'ship it',
        executor: 'claude',
        executor_model: 'sonnet',
        task_source: { source: 'telegram', chat_id: '-100123', topic_id: '42', message_id: '99' },
      }),
      envelope: createEnvelope(),
      shouldMaterializeRootState: true,
    });
  });

  it('rejects /task inside an existing topic continuation', () => {
    const result = classifyTelegramInboundEnvelope(createTask(), createEnvelope(), true);

    expect(result).toEqual({
      kind: 'rejected',
      task: expect.objectContaining({
        task_type: 'deploy',
        task_source: { source: 'telegram', chat_id: '-100123', topic_id: '42', message_id: '99' },
      }),
      reason: formatThreadTaskCommandRejectedMessage(),
    });
  });

  it('accepts /status, /new, and /end only for mapped topic continuations', () => {
    expect(classifyTelegramInboundEnvelope(
      createTask(),
      createEnvelope({ normalized_text: '/status', raw_content: '/status' }),
      true,
    )).toEqual(expect.objectContaining({
      kind: 'accepted',
      task: expect.objectContaining({ task_type: 'status' }),
    }));

    expect(classifyTelegramInboundEnvelope(
      createTask(),
      createEnvelope({ normalized_text: '/new cursor auto', raw_content: '/new cursor auto' }),
      true,
    )).toEqual(expect.objectContaining({
      kind: 'accepted',
      task: expect.objectContaining({ task_type: 'new_instance', executor: 'cursor', executor_model: 'auto' }),
    }));

    expect(classifyTelegramInboundEnvelope(
      createTask(),
      createEnvelope({ normalized_text: '/end', raw_content: '/end' }),
      true,
    )).toEqual(expect.objectContaining({
      kind: 'accepted',
      task: expect.objectContaining({ task_type: 'cleanup' }),
    }));

    expect(classifyTelegramInboundEnvelope(
      createTask(),
      createEnvelope({ normalized_text: '/status', raw_content: '/status' }),
      false,
    )).toEqual({
      kind: 'rejected',
      task: expect.objectContaining({ task_type: 'status' }),
      reason: formatThreadOnlyCommandMessage('/status'),
    });
  });
});
