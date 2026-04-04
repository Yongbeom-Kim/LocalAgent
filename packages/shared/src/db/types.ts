import type { Client } from '@libsql/client/sqlite3';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { SqliteSchema } from './schema';

export interface SqliteConfig {
  dbPath: string;
  expectedSchemaVersion?: number;
}

export interface SqliteClient {
  readonly db: LibSQLDatabase<SqliteSchema>;
  readonly connection: Client;
  close(): void;
}
