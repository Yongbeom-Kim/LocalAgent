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
  it('applies the sqlite schema including root-owned reporting channels and session lineage', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-migrator-test-'));
    tempDirs.push(tempDir);

    const dbPath = join(tempDir, 'migrator.sqlite');
    await runMigrations({ dbPath });

    const { createClient } = await import('@libsql/client/sqlite3');
    const client = createClient({ url: `file:${dbPath}` });

    try {
      const schemaVersion = await client.execute('SELECT version, updated_by FROM __schema_version WHERE id = 1');
      expect(schemaVersion.rows[0]?.version).toBe(10);
      expect(schemaVersion.rows[0]?.updated_by).toBe('0005_sync_schema_version');

      const larkThreadColumns = await client.execute("PRAGMA table_info('lark_threads')");
      expect(larkThreadColumns.rows.some((row) => row.name === 'root_session_id')).toBe(true);
      expect(larkThreadColumns.rows.some((row) => row.name === 'session_id')).toBe(false);

      const telegramThreadColumns = await client.execute("PRAGMA table_info('telegram_threads')");
      expect(telegramThreadColumns.rows.some((row) => row.name === 'root_session_id')).toBe(true);
      expect(telegramThreadColumns.rows.some((row) => row.name === 'session_id')).toBe(false);

      const bridgeColumns = await client.execute("PRAGMA table_info('session_bridges')");
      expect(bridgeColumns.rows.some((row) => row.name === 'root_session_id')).toBe(true);
      expect(bridgeColumns.rows.some((row) => row.name === 'session_id')).toBe(false);

      const sessionColumns = await client.execute("PRAGMA table_info('sessions')");
      expect(sessionColumns.rows.some((row) => row.name === 'parent_session_id')).toBe(true);

      await client.execute({
        sql: `
          INSERT INTO sessions (
            session_id,
            parent_session_id,
            task_type,
            executor,
            executor_model,
            status,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['root-session', null, 'coding', 'claude', 'sonnet', 'active', 100, 100, null],
      });

      await client.execute({
        sql: `
          INSERT INTO sessions (
            session_id,
            parent_session_id,
            task_type,
            executor,
            executor_model,
            status,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['child-session', 'root-session', 'coding', 'claude', 'sonnet', 'active', 110, 110, null],
      });

      const lineageRows = await client.execute({
        sql: 'SELECT session_id, parent_session_id FROM sessions WHERE session_id IN (?, ?) ORDER BY session_id',
        args: ['child-session', 'root-session'],
      });
      expect(lineageRows.rows).toEqual([
        { session_id: 'child-session', parent_session_id: 'root-session' },
        { session_id: 'root-session', parent_session_id: null },
      ]);

      await expect(
        client.execute({
          sql: `
            INSERT INTO sessions (
              session_id,
              parent_session_id,
              task_type,
              status,
              created_at_ms,
              updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
          `,
          args: ['orphan-session', 'missing-parent', 'coding', 'active', 120, 120],
        }),
      ).rejects.toThrow(/FOREIGN KEY constraint failed/);

      await client.execute({
        sql: `
          INSERT INTO lark_threads (
            root_message_id,
            thread_id,
            root_session_id,
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
        args: ['om_root_1', null, 'root-session', 'lark', 'p2p', 'coding', 'claude', 'sonnet', 'active', 100, 100, null],
      });

      await client.execute({
        sql: `
          INSERT INTO telegram_threads (
            chat_id,
            topic_id,
            root_session_id,
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
        args: ['-100123', '42', 'root-session', 'telegram', 'coding', 'claude', 'sonnet', 'active', '1', '2', '{}', 100, 100, null],
      });

      await client.execute({
        sql: `
          INSERT INTO session_bridges (
            root_session_id,
            lark_root_message_id,
            telegram_chat_id,
            telegram_topic_id,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['root-session', 'om_root_1', '-100123', '42', 100, 100, null],
      });

      const bridgeLookup = await client.execute({
        sql: 'SELECT telegram_chat_id, telegram_topic_id FROM session_bridges WHERE root_session_id = ?',
        args: ['root-session'],
      });
      expect(bridgeLookup.rows[0]?.telegram_chat_id).toBe('-100123');
      expect(bridgeLookup.rows[0]?.telegram_topic_id).toBe('42');

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
        `,
        args: ['root-session', 'lark', 'om_root_1', 100, 100, null],
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
        `,
        args: ['child-session', 'lark', 'om_root_1', 110, 110, null],
      });

      const sharedLinkRows = await client.execute({
        sql: `
          SELECT session_id
          FROM session_platform_links
          WHERE platform = ? AND external_thread_key = ?
          ORDER BY session_id
        `,
        args: ['lark', 'om_root_1'],
      });
      expect(sharedLinkRows.rows.map((row) => row.session_id)).toEqual(['child-session', 'root-session']);

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
          args: ['root-session', 'lark', 'om_root_2', 120, 120, null],
        }),
      ).rejects.toThrow(/UNIQUE constraint failed: session_platform_links\.session_id, session_platform_links\.platform/);

      const sessionPlatformLinksIndexes = await client.execute("PRAGMA index_list('session_platform_links')");
      expect(
        sessionPlatformLinksIndexes.rows.some(
          (row) => row.name === 'idx_session_platform_links_platform_external_thread_key',
        ),
      ).toBe(true);
      expect(
        sessionPlatformLinksIndexes.rows.some(
          (row) => row.name === 'session_platform_links_platform_external_thread_key_unique',
        ),
      ).toBe(false);
    } finally {
      client.close();
    }
  });
});
