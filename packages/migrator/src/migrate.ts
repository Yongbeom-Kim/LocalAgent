import { createClient } from '@libsql/client/sqlite3';
import { drizzle } from 'drizzle-orm/libsql/sqlite3';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { resolve } from 'node:path';
import type { MigratorConfig } from './config';

const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, 'migrations');

export async function runMigrations(config: MigratorConfig, migrationsFolder = DEFAULT_MIGRATIONS_DIR): Promise<void> {
  const connection = createClient({
    url: `file:${config.dbPath}`,
  });

  try {
    await connection.execute('PRAGMA journal_mode = WAL');
    await connection.execute('PRAGMA foreign_keys = ON');

    const db = drizzle(connection);
    await migrate(db, { migrationsFolder });
  } finally {
    connection.close();
  }
}

