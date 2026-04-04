import { createClient, type Client } from '@libsql/client/sqlite3';
import { drizzle } from 'drizzle-orm/libsql/sqlite3';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { schemaVersionTable, sqliteSchema, type SqliteSchema } from './schema';
import type { SqliteClient, SqliteConfig } from './types';

export async function createSqliteClient(config: SqliteConfig): Promise<SqliteClient> {
  const connection = createClient({
    url: `file:${config.dbPath}`,
  });

  await connection.execute('PRAGMA journal_mode = WAL');
  await connection.execute('PRAGMA foreign_keys = ON');
  await ensureSchemaVersionTable(connection);

  const db = drizzle(connection, { schema: sqliteSchema });

  return {
    db,
    connection,
    close() {
      connection.close();
    },
  };
}

export async function assertExpectedSchemaVersion(
  db: LibSQLDatabase<SqliteSchema>,
  expectedSchemaVersion?: number,
): Promise<void> {
  if (expectedSchemaVersion === undefined) {
    return;
  }

  const row = await db
    .select({ version: schemaVersionTable.version })
    .from(schemaVersionTable)
    .where(eq(schemaVersionTable.id, 1))
    .get();

  if (!row || row.version !== expectedSchemaVersion) {
    throw new Error(
      `Schema version mismatch: expected ${expectedSchemaVersion}, got ${row?.version ?? 'unset'}. Run migrations before starting this service.`,
    );
  }
}

async function ensureSchemaVersionTable(connection: Client): Promise<void> {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS __schema_version (
      id INTEGER PRIMARY KEY,
      version INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    )
  `);
}
