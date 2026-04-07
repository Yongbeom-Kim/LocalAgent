import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteClient } from '../../db/client';
import { SessionRepository } from '../../db/session-repository';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe('SessionRepository', () => {
  it('creates and updates canonical sessions without platform ids', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapSessionsTable(client.connection);
      const repository = new SessionRepository(client.db);

      await repository.upsertSession({
        sessionId: 'session-1',
        taskType: 'coding',
        status: 'active',
        createdAtMs: 100,
        updatedAtMs: 100,
      });

      expect(await repository.getSessionById('session-1')).toEqual({
        sessionId: 'session-1',
        taskType: 'coding',
        executor: null,
        executorModel: null,
        status: 'active',
        createdAtMs: 100,
        updatedAtMs: 100,
        endedAtMs: null,
      });

      await repository.upsertSession({
        sessionId: 'session-1',
        taskType: 'coding',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'ended',
        createdAtMs: 200,
        updatedAtMs: 300,
        endedAtMs: 300,
      });

      expect(await repository.getSessionById('session-1')).toEqual({
        sessionId: 'session-1',
        taskType: 'coding',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'ended',
        createdAtMs: 100,
        updatedAtMs: 300,
        endedAtMs: 300,
      });
    } finally {
      client.close();
    }
  });

  it('marks a canonical session as ended', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapSessionsTable(client.connection);
      const repository = new SessionRepository(client.db);

      await repository.upsertSession({
        sessionId: 'session-2',
        taskType: 'ops',
        executor: 'cursor',
        executorModel: 'auto',
        status: 'active',
        createdAtMs: 1000,
        updatedAtMs: 1000,
      });

      await repository.markSessionEnded('session-2', 1200);

      expect(await repository.getSessionById('session-2')).toEqual({
        sessionId: 'session-2',
        taskType: 'ops',
        executor: 'cursor',
        executorModel: 'auto',
        status: 'ended',
        createdAtMs: 1000,
        updatedAtMs: 1200,
        endedAtMs: 1200,
      });
    } finally {
      client.close();
    }
  });
});

async function bootstrapSessionsTable(connection: Awaited<ReturnType<typeof createSqliteClient>>['connection']): Promise<void> {
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
}
