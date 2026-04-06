import { asc, eq, lt, and, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { telegramMessagesTable, telegramThreadsTable, type SqliteSchema } from './schema';

export interface UpsertTelegramThreadStateParams {
  chatId: string;
  topicId: string;
  sessionId: string;
  source: string;
  taskType: string;
  executor: string;
  executorModel: string;
  status: string;
  seedMessageId?: string | null;
  statusMessageId?: string | null;
  metadataJson?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number | null;
}

export interface RecordTelegramMessageParams {
  chatId: string;
  messageId: string;
  topicId: string;
  sessionId: string;
  direction: string;
  senderType: string;
  messageType: string;
  rawContent: string;
  normalizedText: string | null;
  metadataJson: string | null;
  createdAtMs: number;
}

export interface TelegramThreadRow {
  chatId: string;
  topicId: string;
  sessionId: string;
  source: string;
  taskType: string;
  executor: string;
  executorModel: string;
  status: string;
  seedMessageId: string | null;
  statusMessageId: string | null;
  metadataJson: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs: number | null;
}

export interface TelegramMessageRow {
  chatId: string;
  messageId: string;
  topicId: string;
  sessionId: string;
  direction: string;
  senderType: string;
  messageType: string;
  rawContent: string;
  normalizedText: string | null;
  metadataJson: string | null;
  createdAtMs: number;
}

export class TelegramHistoryRepository {
  constructor(private readonly db: LibSQLDatabase<SqliteSchema>) {}

  async upsertTelegramThreadState(params: UpsertTelegramThreadStateParams): Promise<void> {
    await this.db
      .insert(telegramThreadsTable)
      .values({
        chatId: params.chatId,
        topicId: params.topicId,
        sessionId: params.sessionId,
        source: params.source,
        taskType: params.taskType,
        executor: params.executor,
        executorModel: params.executorModel,
        status: params.status,
        seedMessageId: params.seedMessageId ?? null,
        statusMessageId: params.statusMessageId ?? null,
        metadataJson: params.metadataJson ?? null,
        createdAtMs: params.createdAtMs,
        updatedAtMs: params.updatedAtMs,
        endedAtMs: params.endedAtMs ?? null,
      })
      .onConflictDoUpdate({
        target: [telegramThreadsTable.chatId, telegramThreadsTable.topicId],
        set: {
          sessionId: params.sessionId,
          source: params.source,
          taskType: params.taskType,
          executor: params.executor,
          executorModel: params.executorModel,
          status: params.status,
          seedMessageId: sql`COALESCE(${params.seedMessageId ?? null}, ${telegramThreadsTable.seedMessageId})`,
          statusMessageId: sql`COALESCE(${params.statusMessageId ?? null}, ${telegramThreadsTable.statusMessageId})`,
          metadataJson: sql`COALESCE(${params.metadataJson ?? null}, ${telegramThreadsTable.metadataJson})`,
          updatedAtMs: params.updatedAtMs,
          endedAtMs: params.endedAtMs ?? null,
        },
      });

    await this.db
      .update(telegramMessagesTable)
      .set({ sessionId: params.sessionId, topicId: params.topicId })
      .where(and(eq(telegramMessagesTable.chatId, params.chatId), eq(telegramMessagesTable.topicId, params.topicId)));
  }

  async recordInboundTelegramMessage(params: RecordTelegramMessageParams): Promise<void> {
    await this.recordTelegramMessage(params);
  }

  async recordOutboundTelegramMessage(params: RecordTelegramMessageParams): Promise<void> {
    await this.recordTelegramMessage(params);
  }

  async getTelegramThreadByTopic(chatId: string, topicId: string): Promise<TelegramThreadRow | null> {
    const row = await this.db
      .select()
      .from(telegramThreadsTable)
      .where(and(eq(telegramThreadsTable.chatId, chatId), eq(telegramThreadsTable.topicId, topicId)))
      .get();

    return row ?? null;
  }

  async getTelegramThreadBySessionId(sessionId: string): Promise<TelegramThreadRow | null> {
    const row = await this.db
      .select()
      .from(telegramThreadsTable)
      .where(eq(telegramThreadsTable.sessionId, sessionId))
      .get();

    return row ?? null;
  }

  async getTelegramMessageByChatAndMessageId(
    chatId: string,
    messageId: string,
  ): Promise<TelegramMessageRow | null> {
    const row = await this.db
      .select()
      .from(telegramMessagesTable)
      .where(and(eq(telegramMessagesTable.chatId, chatId), eq(telegramMessagesTable.messageId, messageId)))
      .get();

    return row ?? null;
  }

  async listTelegramMessagesForTopic(chatId: string, topicId: string): Promise<TelegramMessageRow[]> {
    return this.db
      .select()
      .from(telegramMessagesTable)
      .where(and(eq(telegramMessagesTable.chatId, chatId), eq(telegramMessagesTable.topicId, topicId)))
      .orderBy(asc(telegramMessagesTable.createdAtMs), asc(telegramMessagesTable.messageId));
  }

  async markTelegramThreadNewInstance(params: {
    sessionId: string;
    executor: string;
    executorModel: string;
    updatedAtMs: number;
  }): Promise<void> {
    await this.db
      .update(telegramThreadsTable)
      .set({
        executor: params.executor,
        executorModel: params.executorModel,
        status: 'active',
        updatedAtMs: params.updatedAtMs,
        endedAtMs: null,
      })
      .where(eq(telegramThreadsTable.sessionId, params.sessionId));
  }

  async markTelegramThreadEnded(sessionId: string, endedAtMs: number): Promise<void> {
    await this.db
      .update(telegramThreadsTable)
      .set({
        status: 'ended',
        endedAtMs,
        updatedAtMs: endedAtMs,
      })
      .where(eq(telegramThreadsTable.sessionId, sessionId));
  }

  async getStaleTelegramSessionIdsBeforeUpdatedAt(cutoffMs: number): Promise<string[]> {
    const rows = await this.db
      .select({ sessionId: telegramThreadsTable.sessionId })
      .from(telegramThreadsTable)
      .where(lt(telegramThreadsTable.updatedAtMs, cutoffMs))
      .orderBy(asc(telegramThreadsTable.updatedAtMs), asc(telegramThreadsTable.sessionId));

    return rows.map((row) => row.sessionId);
  }

  async deleteTelegramRowsBySessionId(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(telegramMessagesTable).where(eq(telegramMessagesTable.sessionId, sessionId));
      await tx.delete(telegramThreadsTable).where(eq(telegramThreadsTable.sessionId, sessionId));
    });
  }

  private async recordTelegramMessage(params: RecordTelegramMessageParams): Promise<void> {
    await this.db
      .insert(telegramMessagesTable)
      .values({
        chatId: params.chatId,
        messageId: params.messageId,
        topicId: params.topicId,
        sessionId: params.sessionId,
        direction: params.direction,
        senderType: params.senderType,
        messageType: params.messageType,
        rawContent: params.rawContent,
        normalizedText: params.normalizedText,
        metadataJson: params.metadataJson,
        createdAtMs: params.createdAtMs,
      })
      .onConflictDoNothing({ target: [telegramMessagesTable.chatId, telegramMessagesTable.messageId] });

    await this.db
      .update(telegramThreadsTable)
      .set({ updatedAtMs: params.createdAtMs })
      .where(and(eq(telegramThreadsTable.chatId, params.chatId), eq(telegramThreadsTable.topicId, params.topicId)));
  }
}
