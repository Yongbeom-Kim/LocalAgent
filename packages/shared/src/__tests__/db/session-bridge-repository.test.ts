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

describe('session_bridges schema removal', () => {
  it('does not create the legacy session_bridges table in fresh sqlite databases', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'local-agent-session-bridge-db-test-'));
    tempDirs.push(tempDir);

    const client = await createSqliteClient({ dbPath: join(tempDir, 'history.sqlite') });

    try {
      const bridgeColumns = await client.connection.execute("PRAGMA table_info('session_bridges')");
      expect(bridgeColumns.rows).toEqual([]);
    } finally {
      client.close();
    }
  });
});
