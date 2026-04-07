import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteClient } from '../../db/client';
import { SessionPlatformLinkRepository } from '../../db/session-platform-link-repository';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe('SessionPlatformLinkRepository', () => {
  it('maps session ids to platform thread roots without embedding them in sessions', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-link-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapSessionAndLinkTables(client.connection);
      const repository = new SessionPlatformLinkRepository(client.db);

      await repository.upsertSessionPlatformLink({
        sessionId: 'session-1',
        platform: 'lark',
        externalThreadKey: 'om_root_1',
        createdAtMs: 100,
        updatedAtMs: 100,
      });

      await repository.upsertSessionPlatformLink({
        sessionId: 'session-1',
        platform: 'telegram',
        externalThreadKey: '-100123:42',
        createdAtMs: 100,
        updatedAtMs: 100,
      });

      expect(await repository.getLinkBySessionAndPlatform('session-1', 'lark')).toEqual({
        sessionId: 'session-1',
        platform: 'lark',
        externalThreadKey: 'om_root_1',
        createdAtMs: 100,
        updatedAtMs: 100,
        endedAtMs: null,
      });

      expect(await repository.getLinkByPlatformAndExternalThreadKey('telegram', '-100123:42')).toEqual({
        sessionId: 'session-1',
        platform: 'telegram',
        externalThreadKey: '-100123:42',
        createdAtMs: 100,
        updatedAtMs: 100,
        endedAtMs: null,
      });

      const sessionsColumns = await client.connection.execute('PRAGMA table_info(sessions)');
      const sessionColumnNames = sessionsColumns.rows.map((row) => String(row.name));
      expect(sessionColumnNames).not.toContain('lark_root_message_id');
      expect(sessionColumnNames).not.toContain('telegram_chat_id');
      expect(sessionColumnNames).not.toContain('telegram_topic_id');
    } finally {
      client.close();
    }
  });

  it('updates and ends per-platform links by canonical session id', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-link-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapSessionAndLinkTables(client.connection);
      const repository = new SessionPlatformLinkRepository(client.db);

      await repository.upsertSessionPlatformLink({
        sessionId: 'session-2',
        platform: 'lark',
        externalThreadKey: 'om_root_old',
        createdAtMs: 200,
        updatedAtMs: 200,
      });

      await repository.upsertSessionPlatformLink({
        sessionId: 'session-2',
        platform: 'lark',
        externalThreadKey: 'om_root_new',
        createdAtMs: 400,
        updatedAtMs: 500,
      });

      await repository.markSessionPlatformLinkEnded('session-2', 'lark', 600);

      expect(await repository.getLinkBySessionAndPlatform('session-2', 'lark')).toEqual({
        sessionId: 'session-2',
        platform: 'lark',
        externalThreadKey: 'om_root_new',
        createdAtMs: 200,
        updatedAtMs: 600,
        endedAtMs: 600,
      });
    } finally {
      client.close();
    }
  });
});

async function bootstrapSessionAndLinkTables(
  connection: Awaited<ReturnType<typeof createSqliteClient>>['connection'],
): Promise<void> {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      executor TEXT,
      executor_model TEXT,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS session_platform_links (
      session_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      external_thread_key TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER,
      PRIMARY KEY (session_id, platform),
      UNIQUE (platform, external_thread_key),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    )
  `);

  await connection.execute(`
    INSERT INTO sessions (
      session_id,
      task_type,
      executor,
      executor_model,
      status,
      created_at_ms,
      updated_at_ms,
      ended_at_ms
    ) VALUES ('session-1', 'coding', NULL, NULL, 'active', 100, 100, NULL)
    ON CONFLICT(session_id) DO NOTHING
  `);

  await connection.execute(`
    INSERT INTO sessions (
      session_id,
      task_type,
      executor,
      executor_model,
      status,
      created_at_ms,
      updated_at_ms,
      ended_at_ms
    ) VALUES ('session-2', 'coding', 'claude', 'sonnet', 'active', 200, 200, NULL)
    ON CONFLICT(session_id) DO NOTHING
  `);
}
