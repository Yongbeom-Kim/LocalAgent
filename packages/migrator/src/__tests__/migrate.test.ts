import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../migrate';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe('runMigrations', () => {
  it('applies the initial lark sqlite schema', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-migrator-test-'));
    tempDirs.push(tempDir);

    const dbPath = join(tempDir, 'migrator.sqlite');
    await runMigrations({ dbPath });

    const { createClient } = await import('@libsql/client/sqlite3');
    const client = createClient({ url: `file:${dbPath}` });

    try {
      const threadsTableExists = await client.execute(
        "SELECT 1 as exists_flag FROM sqlite_master WHERE type='table' AND name='lark_threads'",
      );
      expect(threadsTableExists.rows[0]?.exists_flag).toBe(1);

      const messagesTableExists = await client.execute(
        "SELECT 1 as exists_flag FROM sqlite_master WHERE type='table' AND name='lark_messages'",
      );
      expect(messagesTableExists.rows[0]?.exists_flag).toBe(1);

      const telegramThreadsTableExists = await client.execute(
        "SELECT 1 as exists_flag FROM sqlite_master WHERE type='table' AND name='telegram_threads'",
      );
      expect(telegramThreadsTableExists.rows[0]?.exists_flag).toBe(1);

      const telegramMessagesTableExists = await client.execute(
        "SELECT 1 as exists_flag FROM sqlite_master WHERE type='table' AND name='telegram_messages'",
      );
      expect(telegramMessagesTableExists.rows[0]?.exists_flag).toBe(1);

      const sessionBridgesTableExists = await client.execute(
        "SELECT 1 as exists_flag FROM sqlite_master WHERE type='table' AND name='session_bridges'",
      );
      expect(sessionBridgesTableExists.rows[0]?.exists_flag).toBe(1);

      await client.execute({
        sql: `
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['om_root_1', null, 'session-1', 'lark', 'p2p', 'coding', 'claude', 'sonnet', 'active', 100, 100, null],
      });

      await client.execute({
        sql: `
          INSERT INTO telegram_threads (
            chat_id,
            topic_id,
            session_id,
            source,
            task_type,
            executor,
            executor_model,
            status,
            seed_message_id,
            status_message_id,
            metadata_json,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['-100123', '42', 'session-1', 'telegram', 'coding', 'claude', 'sonnet', 'active', '1', '2', '{}', 100, 100, null],
      });

      await client.execute({
        sql: `
          INSERT INTO telegram_messages (
            chat_id,
            message_id,
            topic_id,
            session_id,
            direction,
            sender_type,
            message_type,
            raw_content,
            normalized_text,
            metadata_json,
            created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['-100123', '99', '42', 'session-1', 'inbound', 'user', 'text', 'hello', 'hello', '{}', 101],
      });

      await client.execute({
        sql: `
          INSERT INTO session_bridges (
            session_id,
            lark_root_message_id,
            telegram_chat_id,
            telegram_topic_id,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['session-1', 'om_root_1', '-100123', '42', 100, 100, null],
      });

      const bridgeLookup = await client.execute({
        sql: 'SELECT telegram_chat_id, telegram_topic_id FROM session_bridges WHERE session_id = ?',
        args: ['session-1'],
      });
      expect(bridgeLookup.rows[0]?.telegram_chat_id).toBe('-100123');
      expect(bridgeLookup.rows[0]?.telegram_topic_id).toBe('42');
    } finally {
      client.close();
    }
  });
});
