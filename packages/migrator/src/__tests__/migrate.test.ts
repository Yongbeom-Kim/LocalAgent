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
  it('applies the sqlite schema including canonical sessions and platform links', async () => {
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

      const sessionsTableExists = await client.execute(
        "SELECT 1 as exists_flag FROM sqlite_master WHERE type='table' AND name='sessions'",
      );
      expect(sessionsTableExists.rows[0]?.exists_flag).toBe(1);

      const sessionPlatformLinksTableExists = await client.execute(
        "SELECT 1 as exists_flag FROM sqlite_master WHERE type='table' AND name='session_platform_links'",
      );
      expect(sessionPlatformLinksTableExists.rows[0]?.exists_flag).toBe(1);

      const sessionPlatformLinksPkInfo = await client.execute("PRAGMA index_list('session_platform_links')");
      expect(
        sessionPlatformLinksPkInfo.rows.some(
          (row) => String(row.origin).toLowerCase() === 'pk' || Number(row.origin) === 112,
        ),
      ).toBe(true);
      expect(sessionPlatformLinksPkInfo.rows.some((row) => row.name === 'session_platform_links_platform_external_thread_key_unique')).toBe(true);

      const sessionBridgesUniqueInfo = await client.execute("PRAGMA index_list('session_bridges')");
      expect(sessionBridgesUniqueInfo.rows.some((row) => row.name === 'session_platform_links_platform_external_thread_key_unique')).toBe(false);

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

      await client.execute({
        sql: `
          INSERT INTO sessions (
            session_id,
            task_type,
            executor,
            executor_model,
            status,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO NOTHING
        `,
        args: ['session-1', 'coding', 'claude', 'sonnet', 'active', 100, 100, null],
      });

      await client.execute({
        sql: `
          INSERT INTO session_platform_links (
            session_id,
            platform,
            external_thread_key,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, platform) DO NOTHING
        `,
        args: ['session-1', 'lark', 'om_root_1', 100, 100, null],
      });

      await client.execute({
        sql: `
          INSERT INTO session_platform_links (
            session_id,
            platform,
            external_thread_key,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, platform) DO NOTHING
        `,
        args: ['session-1', 'telegram', '-100123:42', 100, 100, null],
      });

      const canonicalSessionLookup = await client.execute({
        sql: 'SELECT session_id, task_type, status FROM sessions WHERE session_id = ?',
        args: ['session-1'],
      });
      expect(canonicalSessionLookup.rows[0]?.session_id).toBe('session-1');
      expect(canonicalSessionLookup.rows[0]?.task_type).toBe('coding');
      expect(canonicalSessionLookup.rows[0]?.status).toBe('active');

      const larkLinkLookup = await client.execute({
        sql: 'SELECT external_thread_key FROM session_platform_links WHERE session_id = ? AND platform = ?',
        args: ['session-1', 'lark'],
      });
      expect(larkLinkLookup.rows[0]?.external_thread_key).toBe('om_root_1');

      const telegramLinkLookup = await client.execute({
        sql: 'SELECT external_thread_key FROM session_platform_links WHERE session_id = ? AND platform = ?',
        args: ['session-1', 'telegram'],
      });
      expect(telegramLinkLookup.rows[0]?.external_thread_key).toBe('-100123:42');

      const duplicatePlatformExternalInsert = await client.execute({
        sql: `
          INSERT INTO sessions (
            session_id,
            task_type,
            executor,
            executor_model,
            status,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['session-2', 'coding', 'claude', 'sonnet', 'active', 200, 200, null],
      });
      expect(duplicatePlatformExternalInsert.rowsAffected).toBe(1);

      await expect(
        client.execute({
          sql: `
            INSERT INTO session_platform_links (
              session_id,
              platform,
              external_thread_key,
              created_at_ms,
              updated_at_ms,
              ended_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
          `,
          args: ['session-2', 'telegram', '-100123:42', 200, 200, null],
        }),
      ).rejects.toThrow(/UNIQUE constraint failed: session_platform_links\.platform, session_platform_links\.external_thread_key/);

      await expect(
        client.execute({
          sql: `
            INSERT INTO session_platform_links (
              session_id,
              platform,
              external_thread_key,
              created_at_ms,
              updated_at_ms,
              ended_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
          `,
          args: ['session-1', 'lark', 'om_root_2', 200, 200, null],
        }),
      ).rejects.toThrow(/UNIQUE constraint failed: session_platform_links\.session_id, session_platform_links\.platform/);
    } finally {
      client.close();
    }
  });
});
