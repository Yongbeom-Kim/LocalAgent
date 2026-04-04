import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const schemaVersionTable = sqliteTable('__schema_version', {
  id: integer('id').primaryKey(),
  version: integer('version').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
  updatedBy: text('updated_by').notNull(),
});

export const larkThreadsTable = sqliteTable(
  'lark_threads',
  {
    rootMessageId: text('root_message_id').primaryKey(),
    threadId: text('thread_id'),
    sessionId: text('session_id').notNull(),
    source: text('source').notNull(),
    chatType: text('chat_type'),
    taskType: text('task_type').notNull(),
    executor: text('executor').notNull(),
    executorModel: text('executor_model').notNull(),
    status: text('status').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    endedAtMs: integer('ended_at_ms'),
  },
  (table) => ({
    threadIdUnique: uniqueIndex('lark_threads_thread_id_unique').on(table.threadId),
    sessionIdUnique: uniqueIndex('lark_threads_session_id_unique').on(table.sessionId),
    sessionIdIdx: index('idx_lark_threads_session_id').on(table.sessionId),
    threadIdIdx: index('idx_lark_threads_thread_id').on(table.threadId),
    statusUpdatedAtIdx: index('idx_lark_threads_status_updated_at').on(
      table.status,
      sql`${table.updatedAtMs} DESC`,
    ),
  }),
);

export const larkMessagesTable = sqliteTable(
  'lark_messages',
  {
    messageId: text('message_id').primaryKey(),
    source: text('source').notNull(),
    rootMessageId: text('root_message_id')
      .notNull()
      .references(() => larkThreadsTable.rootMessageId),
    sessionId: text('session_id').notNull(),
    threadId: text('thread_id'),
    direction: text('direction').notNull(),
    senderType: text('sender_type').notNull(),
    messageType: text('message_type').notNull(),
    rawContent: text('raw_content').notNull(),
    normalizedText: text('normalized_text'),
    metadataJson: text('metadata_json'),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => ({
    threadCreatedAtIdx: index('idx_lark_messages_thread_created_at').on(
      table.rootMessageId,
      table.createdAtMs,
      table.messageId,
    ),
    sessionCreatedAtIdx: index('idx_lark_messages_session_created_at').on(
      table.sessionId,
      table.createdAtMs,
      table.messageId,
    ),
    threadMessageIdIdx: index('idx_lark_messages_thread_message_id').on(
      table.rootMessageId,
      table.messageId,
    ),
  }),
);

export const sqliteSchema = {
  schemaVersionTable,
  larkThreadsTable,
  larkMessagesTable,
};

export type SqliteSchema = typeof sqliteSchema;
