import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteClient } from '../../db/client';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe('createSqliteClient', () => {
  it('enables WAL mode and bootstraps schema metadata table without migrations', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-shared-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({
      dbPath: join(tempDir, 'bootstrap.sqlite'),
    });

    try {
      const journalMode = await client.connection.execute('PRAGMA journal_mode');
      expect(journalMode.rows[0]?.journal_mode).toBe('wal');

      const tableExists = await client.connection.execute(
        "SELECT 1 as exists_flag FROM sqlite_master WHERE type='table' AND name='__schema_version'",
      );

      expect(tableExists.rows[0]?.exists_flag).toBe(1);
    } finally {
      client.close();
    }
  });
});
