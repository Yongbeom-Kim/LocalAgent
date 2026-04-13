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
  it('maps session ids to active platform thread roots without embedding them in sessions', async () => {
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

      expect(await repository.getActiveLinkBySessionAndPlatform('session-1', 'lark')).toEqual({
        sessionId: 'session-1',
        platform: 'lark',
        externalThreadKey: 'om_root_1',
        claimToken: null,
        claimExpiresAtMs: null,
        createdAtMs: 100,
        updatedAtMs: 100,
      });

      expect(await repository.getLinkByPlatformAndExternalThreadKey('telegram', '-100123:42')).toEqual({
        sessionId: 'session-1',
        platform: 'telegram',
        externalThreadKey: '-100123:42',
        claimToken: null,
        claimExpiresAtMs: null,
        createdAtMs: 100,
        updatedAtMs: 100,
      });

      const linkColumns = await client.connection.execute('PRAGMA table_info(session_platform_links)');
      const linkColumnNames = linkColumns.rows.map((row) => String(row.name));
      expect(linkColumnNames).not.toContain('link_status');
      expect(linkColumnNames).not.toContain('ended_at_ms');

      const sessionsColumns = await client.connection.execute('PRAGMA table_info(sessions)');
      const sessionColumnNames = sessionsColumns.rows.map((row) => String(row.name));
      expect(sessionColumnNames).not.toContain('lark_root_message_id');
      expect(sessionColumnNames).not.toContain('telegram_chat_id');
      expect(sessionColumnNames).not.toContain('telegram_topic_id');
    } finally {
      client.close();
    }
  });

  it('claims pending links, blocks steals before expiry, and activates the winning claim', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-link-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapSessionAndLinkTables(client.connection);
      const repository = new SessionPlatformLinkRepository(client.db);

      const firstClaim = await repository.claimPendingLink({
        sessionId: 'session-2',
        platform: 'lark',
        claimToken: 'claim-a',
        claimExpiresAtMs: 500,
        nowMs: 200,
      });

      expect(firstClaim).toEqual({
        sessionId: 'session-2',
        platform: 'lark',
        externalThreadKey: null,
        claimToken: 'claim-a',
        claimExpiresAtMs: 500,
        createdAtMs: 200,
        updatedAtMs: 200,
      });

      const blockedClaim = await repository.claimPendingLink({
        sessionId: 'session-2',
        platform: 'lark',
        claimToken: 'claim-b',
        claimExpiresAtMs: 700,
        nowMs: 300,
      });

      expect(blockedClaim).toEqual(firstClaim);

      const takeoverClaim = await repository.claimPendingLink({
        sessionId: 'session-2',
        platform: 'lark',
        claimToken: 'claim-b',
        claimExpiresAtMs: 900,
        nowMs: 600,
      });

      expect(takeoverClaim).toEqual({
        sessionId: 'session-2',
        platform: 'lark',
        externalThreadKey: null,
        claimToken: 'claim-b',
        claimExpiresAtMs: 900,
        createdAtMs: 200,
        updatedAtMs: 600,
      });

      expect(
        await repository.activateClaimedLink({
          sessionId: 'session-2',
          platform: 'lark',
          claimToken: 'claim-a',
          externalThreadKey: 'om_root_old',
          updatedAtMs: 620,
        }),
      ).toBe(false);

      expect(
        await repository.activateClaimedLink({
          sessionId: 'session-2',
          platform: 'lark',
          claimToken: 'claim-b',
          externalThreadKey: 'om_root_new',
          updatedAtMs: 650,
        }),
      ).toBe(true);

      expect(await repository.getActiveLinkBySessionAndPlatform('session-2', 'lark')).toEqual({
        sessionId: 'session-2',
        platform: 'lark',
        externalThreadKey: 'om_root_new',
        claimToken: null,
        claimExpiresAtMs: null,
        createdAtMs: 200,
        updatedAtMs: 650,
      });
    } finally {
      client.close();
    }
  });

  it('releases failed claims by deleting the pending row and allows shared external keys', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-link-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapSessionAndLinkTables(client.connection);
      const repository = new SessionPlatformLinkRepository(client.db);

      await repository.upsertSessionPlatformLink({
        sessionId: 'session-2',
        platform: 'lark',
        externalThreadKey: 'om_root_new',
        createdAtMs: 200,
        updatedAtMs: 200,
      });

      await client.connection.execute(`
        INSERT INTO sessions (
          session_id,
          task_type,
          executor,
          executor_model,
          status,
          created_at_ms,
          updated_at_ms,
          fallback_seed_text,
          fallback_origin,
          fallback_title_hint
        ) VALUES ('session-3', 'coding', NULL, NULL, 'active', 300, 300, NULL, NULL, NULL)
      `);

      await repository.upsertSessionPlatformLink({
        sessionId: 'session-3',
        platform: 'lark',
        externalThreadKey: 'om_root_new',
        createdAtMs: 300,
        updatedAtMs: 300,
      });

      expect(await repository.listLinksByPlatformAndExternalThreadKey('lark', 'om_root_new')).toEqual([
        {
          sessionId: 'session-2',
          platform: 'lark',
          externalThreadKey: 'om_root_new',
          claimToken: null,
          claimExpiresAtMs: null,
          createdAtMs: 200,
          updatedAtMs: 200,
        },
        {
          sessionId: 'session-3',
          platform: 'lark',
          externalThreadKey: 'om_root_new',
          claimToken: null,
          claimExpiresAtMs: null,
          createdAtMs: 300,
          updatedAtMs: 300,
        },
      ]);

      const claimed = await repository.claimPendingLink({
        sessionId: 'session-1',
        platform: 'telegram',
        claimToken: 'claim-release',
        claimExpiresAtMs: 800,
        nowMs: 400,
      });
      expect(claimed.externalThreadKey).toBeNull();

      expect(
        await repository.releaseExpiredOrFailedClaim({
          sessionId: 'session-1',
          platform: 'telegram',
          claimToken: 'claim-release',
          updatedAtMs: 450,
        }),
      ).toBe(true);

      expect(await repository.getLinkBySessionAndPlatform('session-1', 'telegram')).toBeNull();

      await repository.deleteLinksBySessionId('session-2');
      expect(await repository.getActiveLinkBySessionAndPlatform('session-2', 'lark')).toBeNull();
      expect(await repository.getLinkBySessionAndPlatform('session-2', 'lark')).toBeNull();
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
      fallback_seed_text TEXT,
      fallback_origin TEXT,
      fallback_title_hint TEXT
    )
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS session_platform_links (
      session_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      external_thread_key TEXT,
      claim_token TEXT,
      claim_expires_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, platform),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    )
  `);

  await connection.execute(`
    CREATE INDEX IF NOT EXISTS idx_session_platform_links_platform_external_thread_key
    ON session_platform_links (platform, external_thread_key)
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
      fallback_seed_text,
      fallback_origin,
      fallback_title_hint
    ) VALUES ('session-1', 'coding', NULL, NULL, 'active', 100, 100, NULL, NULL, NULL)
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
      fallback_seed_text,
      fallback_origin,
      fallback_title_hint
    ) VALUES ('session-2', 'coding', 'claude', 'sonnet', 'active', 200, 200, NULL, NULL, NULL)
    ON CONFLICT(session_id) DO NOTHING
  `);
}
