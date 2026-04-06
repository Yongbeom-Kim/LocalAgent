import { and, eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { sessionBridgesTable, type SqliteSchema } from './schema';

export interface UpsertSessionBridgeParams {
  sessionId: string;
  larkRootMessageId: string;
  telegramChatId: string;
  telegramTopicId: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number | null;
}

export interface SessionBridgeRow {
  sessionId: string;
  larkRootMessageId: string;
  telegramChatId: string;
  telegramTopicId: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs: number | null;
}

export class SessionBridgeRepository {
  constructor(private readonly db: LibSQLDatabase<SqliteSchema>) {}

  async upsertSessionBridge(params: UpsertSessionBridgeParams): Promise<void> {
    await this.db
      .insert(sessionBridgesTable)
      .values({
        sessionId: params.sessionId,
        larkRootMessageId: params.larkRootMessageId,
        telegramChatId: params.telegramChatId,
        telegramTopicId: params.telegramTopicId,
        createdAtMs: params.createdAtMs,
        updatedAtMs: params.updatedAtMs,
        endedAtMs: params.endedAtMs ?? null,
      })
      .onConflictDoUpdate({
        target: sessionBridgesTable.sessionId,
        set: {
          larkRootMessageId: params.larkRootMessageId,
          telegramChatId: params.telegramChatId,
          telegramTopicId: params.telegramTopicId,
          updatedAtMs: params.updatedAtMs,
          endedAtMs: params.endedAtMs ?? null,
        },
      });
  }

  async getBridgeBySessionId(sessionId: string): Promise<SessionBridgeRow | null> {
    const row = await this.db
      .select()
      .from(sessionBridgesTable)
      .where(eq(sessionBridgesTable.sessionId, sessionId))
      .get();

    return row ?? null;
  }

  async getBridgeByLarkRootMessageId(larkRootMessageId: string): Promise<SessionBridgeRow | null> {
    const row = await this.db
      .select()
      .from(sessionBridgesTable)
      .where(eq(sessionBridgesTable.larkRootMessageId, larkRootMessageId))
      .get();

    return row ?? null;
  }

  async getBridgeByTelegramTopic(chatId: string, topicId: string): Promise<SessionBridgeRow | null> {
    const row = await this.db
      .select()
      .from(sessionBridgesTable)
      .where(and(eq(sessionBridgesTable.telegramChatId, chatId), eq(sessionBridgesTable.telegramTopicId, topicId)))
      .get();

    return row ?? null;
  }

  async markBridgeEnded(sessionId: string, endedAtMs: number): Promise<void> {
    await this.db
      .update(sessionBridgesTable)
      .set({ endedAtMs, updatedAtMs: endedAtMs })
      .where(eq(sessionBridgesTable.sessionId, sessionId));
  }

  async deleteBridgeBySessionId(sessionId: string): Promise<void> {
    await this.db.delete(sessionBridgesTable).where(eq(sessionBridgesTable.sessionId, sessionId));
  }
}
