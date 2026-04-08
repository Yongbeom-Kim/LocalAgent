import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteClient } from '../../db/client';
import { TelegramHistoryRepository } from '../../db/telegram-history-repository';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe('TelegramHistoryRepository', () => {
  it('upserts telegram thread state and records inbound/outbound messages', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-telegram-history-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapTelegramTables(client.connection);
      const repository = new TelegramHistoryRepository(client.db);

      await repository.upsertTelegramThreadState({
        chatId: '-100123',
        topicId: '42',
        sessionId: 'session-1',
        source: 'telegram',
        taskType: 'coding',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        seedMessageId: '1',
        statusMessageId: '2',
        metadataJson: '{"seed":true}',
        createdAtMs: 100,
        updatedAtMs: 100,
      });

      await repository.recordInboundTelegramMessage({
        chatId: '-100123',
        topicId: '42',
        messageId: '10',
        sessionId: 'session-1',
        direction: 'inbound',
        senderType: 'user',
        messageType: 'text',
        rawContent: 'hello',
        normalizedText: 'hello',
        metadataJson: '{"origin":"telegram"}',
        createdAtMs: 101,
      });

      await repository.recordOutboundTelegramMessage({
        chatId: '-100123',
        topicId: '42',
        messageId: '11',
        sessionId: 'session-1',
        direction: 'outbound',
        senderType: 'bot',
        messageType: 'text',
        rawContent: 'done',
        normalizedText: 'done',
        metadataJson: '{"mirror_id":"mirror-1"}',
        createdAtMs: 102,
      });

      const thread = await repository.getTelegramThreadByTopic('-100123', '42');
      expect(thread).toEqual(
        expect.objectContaining({
          chatId: '-100123',
          topicId: '42',
          sessionId: 'session-1',
          seedMessageId: '1',
          statusMessageId: '2',
        }),
      );

      const messages = await repository.listTelegramMessagesForTopic('-100123', '42');
      expect(messages.map((row) => row.messageId)).toEqual(['10', '11']);
      expect(messages.map((row) => row.direction)).toEqual(['inbound', 'outbound']);
      expect(await repository.getTelegramMessageByChatAndMessageId('-100123', '11')).toEqual(
        expect.objectContaining({ sessionId: 'session-1', senderType: 'bot' }),
      );
    } finally {
      client.close();
    }
  });

  it('deletes telegram rows by session_id', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-telegram-history-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapTelegramTables(client.connection);
      const repository = new TelegramHistoryRepository(client.db);

      await repository.upsertTelegramThreadState({
        chatId: '-100123',
        topicId: '42',
        sessionId: 'session-delete',
        source: 'telegram',
        taskType: 'coding',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'ended',
        createdAtMs: 100,
        updatedAtMs: 100,
      });

      await repository.recordInboundTelegramMessage({
        chatId: '-100123',
        topicId: '42',
        messageId: '10',
        sessionId: 'session-delete',
        direction: 'inbound',
        senderType: 'user',
        messageType: 'text',
        rawContent: 'bye',
        normalizedText: 'bye',
        metadataJson: null,
        createdAtMs: 101,
      });

      await repository.deleteTelegramRowsBySessionId('session-delete');

      expect(await repository.getTelegramThreadBySessionId('session-delete')).toBeNull();
      expect(await repository.listTelegramMessagesForTopic('-100123', '42')).toEqual([]);
    } finally {
      client.close();
    }
  });
});

async function bootstrapTelegramTables(connection: Awaited<ReturnType<typeof createSqliteClient>>['connection']): Promise<void> {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS telegram_threads (
      chat_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      root_session_id TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      task_type TEXT NOT NULL,
      executor TEXT NOT NULL,
      executor_model TEXT NOT NULL,
      status TEXT NOT NULL,
      seed_message_id TEXT,
      status_message_id TEXT,
      metadata_json TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER,
      PRIMARY KEY (chat_id, topic_id)
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS telegram_messages (
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      message_type TEXT NOT NULL,
      raw_content TEXT NOT NULL,
      normalized_text TEXT,
      metadata_json TEXT,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id),
      FOREIGN KEY (chat_id, topic_id) REFERENCES telegram_threads(chat_id, topic_id)
    )
  `);
}
