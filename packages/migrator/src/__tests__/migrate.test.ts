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
  it('applies the sqlite schema including session lineage, fallback metadata, and claimable platform links', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-migrator-test-'));
    tempDirs.push(tempDir);

    const dbPath = join(tempDir, 'migrator.sqlite');
    await runMigrations({ dbPath });

    const { createClient } = await import('@libsql/client/sqlite3');
    const client = createClient({ url: `file:${dbPath}` });

    try {
      const schemaVersion = await client.execute('SELECT version, updated_by FROM __schema_version WHERE id = 1');
      expect(schemaVersion.rows[0]?.version).toBe(13);
      expect(schemaVersion.rows[0]?.updated_by).toBe('0007_session_platform_link_claims');

      const larkThreadColumns = await client.execute("PRAGMA table_info('lark_threads')");
      expect(larkThreadColumns.rows.some((row) => row.name === 'root_session_id')).toBe(true);
      expect(larkThreadColumns.rows.some((row) => row.name === 'session_id')).toBe(false);

      const telegramThreadColumns = await client.execute("PRAGMA table_info('telegram_threads')");
      expect(telegramThreadColumns.rows.some((row) => row.name === 'root_session_id')).toBe(true);
      expect(telegramThreadColumns.rows.some((row) => row.name === 'session_id')).toBe(false);

      const bridgeColumns = await client.execute("PRAGMA table_info('session_bridges')");
      expect(bridgeColumns.rows.some((row) => row.name === 'root_session_id')).toBe(true);
      expect(bridgeColumns.rows.some((row) => row.name === 'session_id')).toBe(false);

      const sessionsColumns = await client.execute("PRAGMA table_info('sessions')");
      const sessionColumnNames = sessionsColumns.rows.map((row) => String(row.name));
      expect(sessionColumnNames).toContain('parent_session_id');
      expect(sessionColumnNames).toContain('fallback_seed_text');
      expect(sessionColumnNames).toContain('fallback_origin');
      expect(sessionColumnNames).toContain('fallback_title_hint');

      const sessionPlatformLinkColumns = await client.execute("PRAGMA table_info('session_platform_links')");
      const sessionPlatformLinkColumnNames = sessionPlatformLinkColumns.rows.map((row) => String(row.name));
      expect(sessionPlatformLinkColumnNames).toContain('link_status');
      expect(sessionPlatformLinkColumnNames).toContain('claim_token');
      expect(sessionPlatformLinkColumnNames).toContain('claim_expires_at_ms');

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
      ).toBe(true);

      const sessionBridgesIndexes = await client.execute("PRAGMA index_list('session_bridges')");
      expect(
        sessionBridgesIndexes.rows.some(
          (row) => row.name === 'session_platform_links_platform_external_thread_key_unique',
        ),
      ).toBe(false);

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
            ended_at_ms,
            fallback_seed_text,
            fallback_origin,
            fallback_title_hint
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['child-session', 'root-session', 'coding', 'claude', 'sonnet', 'active', 110, 110, null, 'seed text', 'scheduler', 'Daily summary'],
      });

      const lineageRows = await client.execute({
        sql: 'SELECT session_id, parent_session_id FROM sessions WHERE session_id IN (?, ?) ORDER BY session_id',
        args: ['child-session', 'root-session'],
      });
      expect(lineageRows.rows).toEqual([
        { session_id: 'child-session', parent_session_id: 'root-session' },
        { session_id: 'root-session', parent_session_id: null },
      ]);

      const canonicalSessionLookup = await client.execute({
        sql: 'SELECT session_id, fallback_seed_text, fallback_origin, fallback_title_hint FROM sessions WHERE session_id = ?',
        args: ['child-session'],
      });
      expect(canonicalSessionLookup.rows[0]?.session_id).toBe('child-session');
      expect(canonicalSessionLookup.rows[0]?.fallback_seed_text).toBe('seed text');
      expect(canonicalSessionLookup.rows[0]?.fallback_origin).toBe('scheduler');
      expect(canonicalSessionLookup.rows[0]?.fallback_title_hint).toBe('Daily summary');

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
            link_status,
            claim_token,
            claim_expires_at_ms,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['root-session', 'lark', 'om_root_1', 'active', null, null, 100, 100, null],
      });

      await client.execute({
        sql: `
          INSERT INTO session_platform_links (
            session_id,
            platform,
            external_thread_key,
            link_status,
            claim_token,
            claim_expires_at_ms,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['child-session', 'telegram', '-100123:42', 'active', null, null, 110, 110, null],
      });

      const larkLinkLookup = await client.execute({
        sql: 'SELECT external_thread_key, link_status FROM session_platform_links WHERE session_id = ? AND platform = ?',
        args: ['root-session', 'lark'],
      });
      expect(larkLinkLookup.rows[0]?.external_thread_key).toBe('om_root_1');
      expect(larkLinkLookup.rows[0]?.link_status).toBe('active');

      const telegramLinkLookup = await client.execute({
        sql: 'SELECT external_thread_key, link_status FROM session_platform_links WHERE session_id = ? AND platform = ?',
        args: ['child-session', 'telegram'],
      });
      expect(telegramLinkLookup.rows[0]?.external_thread_key).toBe('-100123:42');
      expect(telegramLinkLookup.rows[0]?.link_status).toBe('active');

      const sharedLinkRows = await client.execute({
        sql: `
          SELECT session_id
          FROM session_platform_links
          WHERE platform = ? AND external_thread_key = ?
          ORDER BY session_id
        `,
        args: ['lark', 'om_root_1'],
      });
      expect(sharedLinkRows.rows.map((row) => row.session_id)).toEqual(['root-session']);

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
        `,
        args: ['session-2', 'coding', 'claude', 'sonnet', 'active', 200, 200, null],
      });

      await expect(
        client.execute({
          sql: `
            INSERT INTO session_platform_links (
              session_id,
              platform,
              external_thread_key,
              link_status,
              claim_token,
              claim_expires_at_ms,
              created_at_ms,
              updated_at_ms,
              ended_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          args: ['session-2', 'telegram', '-100123:42', 'active', null, null, 200, 200, null],
        }),
      ).rejects.toThrow(/UNIQUE constraint failed: session_platform_links\.platform, session_platform_links\.external_thread_key/);

      await expect(
        client.execute({
          sql: `
            INSERT INTO session_platform_links (
              session_id,
              platform,
              external_thread_key,
              link_status,
              claim_token,
              claim_expires_at_ms,
              created_at_ms,
              updated_at_ms,
              ended_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          args: ['root-session', 'lark', 'om_root_2', 'active', null, null, 200, 200, null],
        }),
      ).rejects.toThrow(/UNIQUE constraint failed: session_platform_links\.session_id, session_platform_links\.platform/);

      const pendingInsert = await client.execute({
        sql: `
          INSERT INTO session_platform_links (
            session_id,
            platform,
            external_thread_key,
            link_status,
            claim_token,
            claim_expires_at_ms,
            created_at_ms,
            updated_at_ms,
            ended_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: ['session-2', 'telegram', null, 'pending', 'claim-1', 500, 200, 200, null],
      });
      expect(pendingInsert.rowsAffected).toBe(1);
    } finally {
      client.close();
    }
  });
});
