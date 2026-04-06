import { describe, expect, it } from 'vitest';
import { formatLarkPromptHistory, formatTelegramPromptHistory } from '../../db/history-format';

describe('formatLarkPromptHistory', () => {
  it('maps inbound user rows and outbound bot rows to user/assistant history lines', () => {
    const history = formatLarkPromptHistory([
      {
        messageId: 'om_1',
        source: 'lark',
        rootMessageId: 'om_root_1',
        sessionId: 'session_1',
        threadId: null,
        direction: 'inbound',
        senderType: 'user',
        messageType: 'text',
        rawContent: '{"text":"raw user"}',
        normalizedText: 'please review this',
        metadataJson: null,
        createdAtMs: 100,
      },
      {
        messageId: 'om_2',
        source: 'lark',
        rootMessageId: 'om_root_1',
        sessionId: 'session_1',
        threadId: null,
        direction: 'outbound',
        senderType: 'bot',
        messageType: 'text',
        rawContent: '{"text":"raw bot"}',
        normalizedText: 'Looks good',
        metadataJson: null,
        createdAtMs: 110,
      },
    ]);

    expect(history).toBe('user: please review this\nassistant: Looks good');
  });

  it('strips visible metadata lines from outbound normalized text', () => {
    const history = formatLarkPromptHistory([
      {
        messageId: 'om_3',
        source: 'lark',
        rootMessageId: 'om_root_1',
        sessionId: 'session_1',
        threadId: null,
        direction: 'outbound',
        senderType: 'bot',
        messageType: 'text',
        rawContent: '{"text":"raw bot"}',
        normalizedText:
          'task_type: code_review\nsession_id: 018f6b7e-1234-7abc-8def-1234567890ab\nexecutor: claude\nmodel: sonnet\nRun completed',
        metadataJson: null,
        createdAtMs: 120,
      },
    ]);

    expect(history).toBe('assistant: Run completed');
  });

  it('falls back to raw content when normalized text is missing', () => {
    const history = formatLarkPromptHistory([
      {
        messageId: 'om_4',
        source: 'lark',
        rootMessageId: 'om_root_1',
        sessionId: 'session_1',
        threadId: null,
        direction: 'inbound',
        senderType: 'user',
        messageType: 'text',
        rawContent: '{"text":"fallback raw"}',
        normalizedText: null,
        metadataJson: null,
        createdAtMs: 130,
      },
    ]);

    expect(history).toContain('user: ');
    expect(history).toContain('fallback raw');
  });

  it('skips rows with unsupported direction/sender combinations', () => {
    const history = formatLarkPromptHistory([
      {
        messageId: 'om_5',
        source: 'lark',
        rootMessageId: 'om_root_1',
        sessionId: 'session_1',
        threadId: null,
        direction: 'outbound',
        senderType: 'user',
        messageType: 'text',
        rawContent: '{"text":"ignore"}',
        normalizedText: 'ignore',
        metadataJson: null,
        createdAtMs: 140,
      },
      {
        messageId: 'om_6',
        source: 'lark',
        rootMessageId: 'om_root_1',
        sessionId: 'session_1',
        threadId: null,
        direction: 'inbound',
        senderType: 'user',
        messageType: 'text',
        rawContent: '{"text":"keep"}',
        normalizedText: 'keep',
        metadataJson: null,
        createdAtMs: 150,
      },
    ]);

    expect(history).toBe('user: keep');
  });

  it('formats telegram rows into prompt history', () => {
    const history = formatTelegramPromptHistory([
      {
        chatId: '-100123',
        messageId: '10',
        topicId: '42',
        sessionId: 'session-1',
        direction: 'inbound',
        senderType: 'user',
        messageType: 'text',
        rawContent: 'telegram raw user',
        normalizedText: 'telegram user',
        metadataJson: null,
        createdAtMs: 100,
      },
      {
        chatId: '-100123',
        messageId: '11',
        topicId: '42',
        sessionId: 'session-1',
        direction: 'outbound',
        senderType: 'bot',
        messageType: 'text',
        rawContent: 'telegram raw bot',
        normalizedText: 'task_type: coding\nsession_id: session-1\nexecutor: claude\nmodel: sonnet\ntelegram bot',
        metadataJson: null,
        createdAtMs: 101,
      },
    ]);

    expect(history).toBe('user: telegram user\nassistant: telegram bot');
  });
});
