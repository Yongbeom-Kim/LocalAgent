import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const schemaVersionTable = sqliteTable('__schema_version', {
  id: integer('id').primaryKey(),
  version: integer('version').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
  updatedBy: text('updated_by').notNull(),
});

export const sqliteSchema = {
  schemaVersionTable,
};

export type SqliteSchema = typeof sqliteSchema;

