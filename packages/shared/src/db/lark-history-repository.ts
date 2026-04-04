import { asc, eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { larkMessagesTable, larkThreadsTable, type SqliteSchema } from './schema';

export interface UpsertInboundLarkMessageParams {
  rootMessageId: string;
  threadId: string | null;
  sessionId: string;
  source: string;
  chatType: string | null;
  taskType: string;
  executor: string;
  executorModel: string;
  status: string;
  threadCreatedAtMs: number;
  threadUpdatedAtMs: number;
  message: {
    messageId: string;
    messageType: string;
    rawContent: string;
    normalizedText: string | null;
    metadataJson: string | null;
    createdAtMs: number;
  };
}

export interface RecordOutboundLarkMessageParams {
  messageId: string;
  source: string;
  rootMessageId: string;
  sessionId: string;
  threadId: string | null;
  messageType: string;
  rawContent: string;
  normalizedText: string | null;
  metadataJson: string | null;
  createdAtMs: number;
}

export interface MarkLarkThreadNewInstanceParams {
  sessionId: string;
  executor: string;
  executorModel: string;
  updatedAtMs: number;
}

export interface UpsertLarkThreadStateParams {
  rootMessageId: string;
  threadId: string | null;
  sessionId: string;
  source: string;
  chatType: string | null;
  taskType: string;
  executor: string;
  executorModel: string;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number | null;
}

export interface LarkThreadRow {
  rootMessageId: string;
  threadId: string | null;
  sessionId: string;
  source: string;
  chatType: string | null;
  taskType: string;
  executor: string;
  executorModel: string;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs: number | null;
}

export interface LarkMessageRow {
  messageId: string;
  source: string;
  rootMessageId: string;
  sessionId: string;
  threadId: string | null;
  direction: string;
  senderType: string;
  messageType: string;
  rawContent: string;
  normalizedText: string | null;
  metadataJson: string | null;
  createdAtMs: number;
}

export class LarkHistoryRepository {
  constructor(private readonly db: LibSQLDatabase<SqliteSchema>) {}

  async upsertInboundLarkMessage(params: UpsertInboundLarkMessageParams): Promise<void> {
    await this.db
      .insert(larkThreadsTable)
      .values({
        rootMessageId: params.rootMessageId,
        threadId: params.threadId,
        sessionId: params.sessionId,
        source: params.source,
        chatType: params.chatType,
        taskType: params.taskType,
        executor: params.executor,
        executorModel: params.executorModel,
        status: params.status,
        createdAtMs: params.threadCreatedAtMs,
        updatedAtMs: params.threadUpdatedAtMs,
        endedAtMs: null,
      })
      .onConflictDoUpdate({
        target: larkThreadsTable.rootMessageId,
        set: {
          threadId: sql`COALESCE(excluded.thread_id, ${larkThreadsTable.threadId})`,
          sessionId: params.sessionId,
          source: params.source,
          chatType: sql`COALESCE(excluded.chat_type, ${larkThreadsTable.chatType})`,
          taskType: params.taskType,
          executor: params.executor,
          executorModel: params.executorModel,
          status: params.status,
          updatedAtMs: params.threadUpdatedAtMs,
          endedAtMs: null,
        },
      });

    await this.db
      .insert(larkMessagesTable)
      .values({
        messageId: params.message.messageId,
        source: params.source,
        rootMessageId: params.rootMessageId,
        sessionId: params.sessionId,
        threadId: params.threadId,
        direction: 'inbound',
        senderType: 'user',
        messageType: params.message.messageType,
        rawContent: params.message.rawContent,
        normalizedText: params.message.normalizedText,
        metadataJson: params.message.metadataJson,
        createdAtMs: params.message.createdAtMs,
      })
      .onConflictDoNothing({ target: larkMessagesTable.messageId });
  }

  async recordOutboundLarkMessage(params: RecordOutboundLarkMessageParams): Promise<void> {
    await this.db
      .insert(larkMessagesTable)
      .values({
        messageId: params.messageId,
        source: params.source,
        rootMessageId: params.rootMessageId,
        sessionId: params.sessionId,
        threadId: params.threadId,
        direction: 'outbound',
        senderType: 'bot',
        messageType: params.messageType,
        rawContent: params.rawContent,
        normalizedText: params.normalizedText,
        metadataJson: params.metadataJson,
        createdAtMs: params.createdAtMs,
      })
      .onConflictDoNothing({ target: larkMessagesTable.messageId });

    await this.db
      .update(larkThreadsTable)
      .set({
        threadId: sql`COALESCE(${params.threadId}, ${larkThreadsTable.threadId})`,
        updatedAtMs: params.createdAtMs,
      })
      .where(eq(larkThreadsTable.rootMessageId, params.rootMessageId));
  }

  async getLarkThreadByThreadId(threadId: string): Promise<LarkThreadRow | null> {
    if (threadId.length === 0) {
      return null;
    }

    const row = await this.db
      .select()
      .from(larkThreadsTable)
      .where(eq(larkThreadsTable.threadId, threadId))
      .get();

    return row ?? null;
  }

  async getLarkThreadBySessionId(sessionId: string): Promise<LarkThreadRow | null> {
    const row = await this.db
      .select()
      .from(larkThreadsTable)
      .where(eq(larkThreadsTable.sessionId, sessionId))
      .get();

    return row ?? null;
  }

  async getLarkThreadByRootMessageId(rootMessageId: string): Promise<LarkThreadRow | null> {
    const row = await this.db
      .select()
      .from(larkThreadsTable)
      .where(eq(larkThreadsTable.rootMessageId, rootMessageId))
      .get();

    return row ?? null;
  }

  async getLarkMessageByMessageId(messageId: string): Promise<LarkMessageRow | null> {
    const row = await this.db
      .select()
      .from(larkMessagesTable)
      .where(eq(larkMessagesTable.messageId, messageId))
      .get();

    return row ?? null;
  }

  async getLarkMessagesForThread(rootMessageId: string): Promise<LarkMessageRow[]> {
    return this.db
      .select()
      .from(larkMessagesTable)
      .where(eq(larkMessagesTable.rootMessageId, rootMessageId))
      .orderBy(asc(larkMessagesTable.createdAtMs), asc(larkMessagesTable.messageId));
  }

  async markLarkThreadNewInstance(params: MarkLarkThreadNewInstanceParams): Promise<void> {
    await this.db
      .update(larkThreadsTable)
      .set({
        executor: params.executor,
        executorModel: params.executorModel,
        status: 'active',
        updatedAtMs: params.updatedAtMs,
        endedAtMs: null,
      })
      .where(eq(larkThreadsTable.sessionId, params.sessionId));
  }

  async markLarkThreadEnded(sessionId: string, endedAtMs: number): Promise<void> {
    await this.db
      .update(larkThreadsTable)
      .set({
        status: 'ended',
        endedAtMs,
        updatedAtMs: endedAtMs,
      })
      .where(eq(larkThreadsTable.sessionId, sessionId));
  }

  async upsertLarkThreadState(params: UpsertLarkThreadStateParams): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(larkThreadsTable)
        .values({
          rootMessageId: params.rootMessageId,
          threadId: params.threadId,
          sessionId: params.sessionId,
          source: params.source,
          chatType: params.chatType,
          taskType: params.taskType,
          executor: params.executor,
          executorModel: params.executorModel,
          status: params.status,
          createdAtMs: params.createdAtMs,
          updatedAtMs: params.updatedAtMs,
          endedAtMs: params.endedAtMs ?? null,
        })
        .onConflictDoUpdate({
          target: larkThreadsTable.rootMessageId,
          set: {
            threadId: sql`COALESCE(excluded.thread_id, ${larkThreadsTable.threadId})`,
            sessionId: params.sessionId,
            source: params.source,
            chatType: sql`COALESCE(excluded.chat_type, ${larkThreadsTable.chatType})`,
            taskType: params.taskType,
            executor: params.executor,
            executorModel: params.executorModel,
            status: params.status,
            updatedAtMs: params.updatedAtMs,
            endedAtMs: params.endedAtMs ?? null,
          },
        });

      await tx
        .update(larkMessagesTable)
        .set({
          sessionId: params.sessionId,
          threadId: sql`COALESCE(${params.threadId}, ${larkMessagesTable.threadId})`,
        })
        .where(eq(larkMessagesTable.rootMessageId, params.rootMessageId));
    });
  }

  async deleteLarkRowsBySessionId(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(larkMessagesTable).where(eq(larkMessagesTable.sessionId, sessionId));
      await tx.delete(larkThreadsTable).where(eq(larkThreadsTable.sessionId, sessionId));
    });
  }
}
