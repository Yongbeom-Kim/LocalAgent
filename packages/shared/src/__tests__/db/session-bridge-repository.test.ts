import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteClient } from '../../db/client';
import { SessionBridgeRepository } from '../../db/session-bridge-repository';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe('SessionBridgeRepository', () => {
  it('upserts and resolves a session bridge by session_id and telegram topic id', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-bridge-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapBridgeTables(client.connection);
      const repository = new SessionBridgeRepository(client.db);

      await repository.upsertSessionBridge({
        sessionId: 'session-1',
        larkRootMessageId: 'om_root_1',
        telegramChatId: '-100123',
        telegramTopicId: '42',
        createdAtMs: 100,
        updatedAtMs: 100,
      });

      expect(await repository.getBridgeBySessionId('session-1')).toEqual(
        expect.objectContaining({ telegramChatId: '-100123', telegramTopicId: '42' }),
      );
      expect(await repository.getBridgeByLarkRootMessageId('om_root_1')).toEqual(
        expect.objectContaining({ sessionId: 'session-1' }),
      );
      expect(await repository.getBridgeByTelegramTopic('-100123', '42')).toEqual(
        expect.objectContaining({ larkRootMessageId: 'om_root_1' }),
      );
    } finally {
      client.close();
    }
  });

  it('deletes bridge rows by session_id', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-bridge-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapBridgeTables(client.connection);
      const repository = new SessionBridgeRepository(client.db);

      await repository.upsertSessionBridge({
        sessionId: 'session-2',
        larkRootMessageId: 'om_root_2',
        telegramChatId: '-100123',
        telegramTopicId: '99',
        createdAtMs: 100,
        updatedAtMs: 100,
      });
      await repository.deleteBridgeBySessionId('session-2');

      expect(await repository.getBridgeBySessionId('session-2')).toBeNull();
    } finally {
      client.close();
    }
  });
});

async function bootstrapBridgeTables(connection: Awaited<ReturnType<typeof createSqliteClient>>['connection']): Promise<void> {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS lark_threads (
      root_message_id TEXT PRIMARY KEY,
      thread_id TEXT UNIQUE,
      session_id TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL,
      chat_type TEXT,
      task_type TEXT NOT NULL,
      executor TEXT NOT NULL,
      executor_model TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS telegram_threads (
      chat_id TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
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
    INSERT INTO lark_threads (
      root_message_id,
      thread_id,
      session_id,
      source,
      chat_type,
      task_type,
      executor,
      executor_model,
      status,
      created_at_ms,
      updated_at_ms,
      ended_at_ms
    ) VALUES ('om_root_1', NULL, 'session-1', 'lark', 'p2p', 'coding', 'claude', 'sonnet', 'active', 100, 100, NULL)
    ON CONFLICT(root_message_id) DO NOTHING
  `);

  await connection.execute(`
    INSERT INTO lark_threads (
      root_message_id,
      thread_id,
      session_id,
      source,
      chat_type,
      task_type,
      executor,
      executor_model,
      status,
      created_at_ms,
      updated_at_ms,
      ended_at_ms
    ) VALUES ('om_root_2', NULL, 'session-2', 'lark', 'p2p', 'coding', 'claude', 'sonnet', 'active', 100, 100, NULL)
    ON CONFLICT(root_message_id) DO NOTHING
  `);

  await connection.execute(`
    INSERT INTO telegram_threads (
      chat_id,
      topic_id,
      session_id,
      source,
      task_type,
      executor,
      executor_model,
      status,
      created_at_ms,
      updated_at_ms
    ) VALUES ('-100123', '42', 'session-1', 'telegram', 'coding', 'claude', 'sonnet', 'active', 100, 100)
    ON CONFLICT(chat_id, topic_id) DO NOTHING
  `);

  await connection.execute(`
    INSERT INTO telegram_threads (
      chat_id,
      topic_id,
      session_id,
      source,
      task_type,
      executor,
      executor_model,
      status,
      created_at_ms,
      updated_at_ms
    ) VALUES ('-100123', '99', 'session-2', 'telegram', 'coding', 'claude', 'sonnet', 'active', 100, 100)
    ON CONFLICT(chat_id, topic_id) DO NOTHING
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS session_bridges (
      session_id TEXT PRIMARY KEY,
      lark_root_message_id TEXT NOT NULL UNIQUE,
      telegram_chat_id TEXT NOT NULL,
      telegram_topic_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER,
      UNIQUE (telegram_chat_id, telegram_topic_id),
      FOREIGN KEY (lark_root_message_id) REFERENCES lark_threads(root_message_id),
      FOREIGN KEY (telegram_chat_id, telegram_topic_id) REFERENCES telegram_threads(chat_id, topic_id)
    )
  `);
}
