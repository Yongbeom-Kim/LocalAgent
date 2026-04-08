import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  integer,
  text,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
} from 'drizzle-orm/sqlite-core';

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
    rootSessionId: text('root_session_id').notNull(),
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
    rootSessionIdUnique: uniqueIndex('lark_threads_root_session_id_unique').on(table.rootSessionId),
    rootSessionIdIdx: index('idx_lark_threads_root_session_id').on(table.rootSessionId),
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

export const telegramThreadsTable = sqliteTable(
  'telegram_threads',
  {
    chatId: text('chat_id').notNull(),
    topicId: text('topic_id').notNull(),
    rootSessionId: text('root_session_id').notNull().unique(),
    source: text('source').notNull(),
    taskType: text('task_type').notNull(),
    executor: text('executor').notNull(),
    executorModel: text('executor_model').notNull(),
    status: text('status').notNull(),
    seedMessageId: text('seed_message_id'),
    statusMessageId: text('status_message_id'),
    metadataJson: text('metadata_json'),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    endedAtMs: integer('ended_at_ms'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatId, table.topicId] }),
    rootSessionIdIdx: index('idx_telegram_threads_root_session_id').on(table.rootSessionId),
    statusUpdatedAtIdx: index('idx_telegram_threads_status_updated_at').on(
      table.status,
      sql`${table.updatedAtMs} DESC`,
    ),
  }),
);

export const telegramMessagesTable = sqliteTable(
  'telegram_messages',
  {
    chatId: text('chat_id').notNull(),
    messageId: text('message_id').notNull(),
    topicId: text('topic_id').notNull(),
    sessionId: text('session_id').notNull(),
    direction: text('direction').notNull(),
    senderType: text('sender_type').notNull(),
    messageType: text('message_type').notNull(),
    rawContent: text('raw_content').notNull(),
    normalizedText: text('normalized_text'),
    metadataJson: text('metadata_json'),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatId, table.messageId] }),
    topicFk: foreignKey({
      columns: [table.chatId, table.topicId],
      foreignColumns: [telegramThreadsTable.chatId, telegramThreadsTable.topicId],
    }),
    topicCreatedAtIdx: index('idx_telegram_messages_topic_created_at').on(
      table.chatId,
      table.topicId,
      table.createdAtMs,
      table.messageId,
    ),
    sessionCreatedAtIdx: index('idx_telegram_messages_session_created_at').on(
      table.sessionId,
      table.createdAtMs,
      table.messageId,
    ),
  }),
);

export const sessionsTable = sqliteTable(
  'sessions',
  {
    sessionId: text('session_id').primaryKey(),
    parentSessionId: text('parent_session_id'),
    taskType: text('task_type').notNull(),
    executor: text('executor'),
    executorModel: text('executor_model'),
    status: text('status').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    endedAtMs: integer('ended_at_ms'),
  },
  (table) => ({
    parentSessionFk: foreignKey({
      columns: [table.parentSessionId],
      foreignColumns: [table.sessionId],
    }),
    parentSessionIdIdx: index('idx_sessions_parent_session_id').on(table.parentSessionId),
    statusUpdatedAtIdx: index('idx_sessions_status_updated_at').on(table.status, sql`${table.updatedAtMs} DESC`),
  }),
);

export const sessionPlatformLinksTable = sqliteTable(
  'session_platform_links',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessionsTable.sessionId),
    platform: text('platform').notNull(),
    externalThreadKey: text('external_thread_key').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    endedAtMs: integer('ended_at_ms'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sessionId, table.platform] }),
    platformExternalThreadKeyIdx: index('idx_session_platform_links_platform_external_thread_key').on(
      table.platform,
      table.externalThreadKey,
    ),
    sessionIdIdx: index('idx_session_platform_links_session_id').on(table.sessionId),
  }),
);

export const sessionBridgesTable = sqliteTable(
  'session_bridges',
  {
    rootSessionId: text('root_session_id').primaryKey(),
    larkRootMessageId: text('lark_root_message_id').notNull().unique(),
    telegramChatId: text('telegram_chat_id').notNull(),
    telegramTopicId: text('telegram_topic_id').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
    endedAtMs: integer('ended_at_ms'),
  },
  (table) => ({
    telegramTopicUnique: uniqueIndex('session_bridges_telegram_topic_unique').on(
      table.telegramChatId,
      table.telegramTopicId,
    ),
    larkRootFk: foreignKey({
      columns: [table.larkRootMessageId],
      foreignColumns: [larkThreadsTable.rootMessageId],
    }),
    telegramTopicFk: foreignKey({
      columns: [table.telegramChatId, table.telegramTopicId],
      foreignColumns: [telegramThreadsTable.chatId, telegramThreadsTable.topicId],
    }),
  }),
);

export const sqliteSchema = {
  schemaVersionTable,
  larkThreadsTable,
  larkMessagesTable,
  telegramThreadsTable,
  telegramMessagesTable,
  sessionsTable,
  sessionPlatformLinksTable,
  sessionBridgesTable,
};

export type SqliteSchema = typeof sqliteSchema;
