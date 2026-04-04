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
    } finally {
      client.close();
    }
  });
});

