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
        parentSessionId: null,
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
        parentSessionId: null,
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
        parentSessionId: null,
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

  it('ignores stale session updates that arrive out of order', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapSessionsTable(client.connection);
      const repository = new SessionRepository(client.db);

      await repository.upsertSession({
        sessionId: 'session-3',
        taskType: 'deploy',
        executor: 'cursor',
        executorModel: 'auto',
        status: 'ended',
        createdAtMs: 100,
        updatedAtMs: 300,
        endedAtMs: 300,
      });

      await repository.upsertSession({
        sessionId: 'session-3',
        taskType: 'thread_reply',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        createdAtMs: 200,
        updatedAtMs: 150,
        endedAtMs: null,
      });

      expect(await repository.getSessionById('session-3')).toEqual({
        sessionId: 'session-3',
        parentSessionId: null,
        taskType: 'deploy',
        executor: 'cursor',
        executorModel: 'auto',
        status: 'ended',
        createdAtMs: 100,
        updatedAtMs: 300,
        endedAtMs: 300,
      });
    } finally {
      client.close();
    }
  });

  it('stores parent_session_id for child sessions', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapSessionsTable(client.connection);
      const repository = new SessionRepository(client.db);

      await repository.upsertSession({
        sessionId: 'root-session',
        taskType: 'coding',
        status: 'active',
        createdAtMs: 100,
        updatedAtMs: 100,
      });

      await repository.upsertSession({
        sessionId: 'child-session',
        parentSessionId: 'root-session',
        taskType: 'coding',
        status: 'active',
        createdAtMs: 150,
        updatedAtMs: 150,
      });

      expect(await repository.getSessionById('child-session')).toEqual({
        sessionId: 'child-session',
        parentSessionId: 'root-session',
        taskType: 'coding',
        executor: null,
        executorModel: null,
        status: 'active',
        createdAtMs: 150,
        updatedAtMs: 150,
        endedAtMs: null,
      });
    } finally {
      client.close();
    }
  });

  it('rejects child sessions whose parent row does not already exist', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapSessionsTable(client.connection);
      const repository = new SessionRepository(client.db);

      await expect(
        repository.upsertSession({
          sessionId: 'orphan-child',
          parentSessionId: 'missing-parent',
          taskType: 'coding',
          status: 'active',
          createdAtMs: 100,
          updatedAtMs: 100,
        }),
      ).rejects.toThrow(/FOREIGN KEY constraint failed|Failed query: insert into "sessions"/);
    } finally {
      client.close();
    }
  });

  it('treats parent_session_id as immutable once the session exists', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      await bootstrapSessionsTable(client.connection);
      const repository = new SessionRepository(client.db);

      await repository.upsertSession({
        sessionId: 'root-session',
        taskType: 'coding',
        status: 'active',
        createdAtMs: 100,
        updatedAtMs: 100,
      });
      await repository.upsertSession({
        sessionId: 'other-root',
        taskType: 'coding',
        status: 'active',
        createdAtMs: 110,
        updatedAtMs: 110,
      });
      await repository.upsertSession({
        sessionId: 'child-session',
        parentSessionId: 'root-session',
        taskType: 'coding',
        status: 'active',
        createdAtMs: 120,
        updatedAtMs: 120,
      });

      await repository.upsertSession({
        sessionId: 'child-session',
        parentSessionId: 'other-root',
        taskType: 'coding',
        status: 'ended',
        createdAtMs: 120,
        updatedAtMs: 200,
        endedAtMs: 200,
      });

      expect(await repository.getSessionById('child-session')).toEqual({
        sessionId: 'child-session',
        parentSessionId: 'root-session',
        taskType: 'coding',
        executor: null,
        executorModel: null,
        status: 'ended',
        createdAtMs: 120,
        updatedAtMs: 200,
        endedAtMs: 200,
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
      parent_session_id TEXT,
      task_type TEXT NOT NULL,
      executor TEXT,
      executor_model TEXT,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(session_id)
    )
  `);
}
