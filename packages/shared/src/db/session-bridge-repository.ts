import { and, eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { sessionBridgesTable, type SqliteSchema } from './schema';

export interface UpsertSessionBridgeParams {
  rootSessionId: string;
  larkRootMessageId: string;
  telegramChatId: string;
  telegramTopicId: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number | null;
}

export interface SessionBridgeRow {
  rootSessionId: string;
  sessionId: string;
  larkRootMessageId: string;
  telegramChatId: string;
  telegramTopicId: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs: number | null;
}

function toSessionBridgeRow(
  row:
    | {
        rootSessionId: string;
        larkRootMessageId: string;
        telegramChatId: string;
        telegramTopicId: string;
        createdAtMs: number;
        updatedAtMs: number;
        endedAtMs: number | null;
      }
    | undefined,
): SessionBridgeRow | null {
  if (!row) {
    return null;
  }

  return {
    ...row,
    sessionId: row.rootSessionId,
  };
}

export class SessionBridgeRepository {
  constructor(private readonly db: LibSQLDatabase<SqliteSchema>) {}

  async upsertSessionBridge(params: UpsertSessionBridgeParams): Promise<void> {
    await this.db
      .insert(sessionBridgesTable)
      .values({
        rootSessionId: params.rootSessionId,
        larkRootMessageId: params.larkRootMessageId,
        telegramChatId: params.telegramChatId,
        telegramTopicId: params.telegramTopicId,
        createdAtMs: params.createdAtMs,
        updatedAtMs: params.updatedAtMs,
        endedAtMs: params.endedAtMs ?? null,
      })
      .onConflictDoUpdate({
        target: sessionBridgesTable.rootSessionId,
        set: {
          larkRootMessageId: params.larkRootMessageId,
          telegramChatId: params.telegramChatId,
          telegramTopicId: params.telegramTopicId,
          updatedAtMs: params.updatedAtMs,
          endedAtMs: params.endedAtMs ?? null,
        },
      });
  }

  async getBridgeByRootSessionId(rootSessionId: string): Promise<SessionBridgeRow | null> {
    const row = await this.db
      .select()
      .from(sessionBridgesTable)
      .where(eq(sessionBridgesTable.rootSessionId, rootSessionId))
      .get();

    return toSessionBridgeRow(row);
  }

  async getBridgeBySessionId(sessionId: string): Promise<SessionBridgeRow | null> {
    return this.getBridgeByRootSessionId(sessionId);
  }

  async getBridgeByLarkRootMessageId(larkRootMessageId: string): Promise<SessionBridgeRow | null> {
    const row = await this.db
      .select()
      .from(sessionBridgesTable)
      .where(eq(sessionBridgesTable.larkRootMessageId, larkRootMessageId))
      .get();

    return toSessionBridgeRow(row);
  }

  async getBridgeByTelegramTopic(chatId: string, topicId: string): Promise<SessionBridgeRow | null> {
    const row = await this.db
      .select()
      .from(sessionBridgesTable)
      .where(and(eq(sessionBridgesTable.telegramChatId, chatId), eq(sessionBridgesTable.telegramTopicId, topicId)))
      .get();

    return toSessionBridgeRow(row);
  }

  async markBridgeEnded(rootSessionId: string, endedAtMs: number): Promise<void> {
    await this.db
      .update(sessionBridgesTable)
      .set({ endedAtMs, updatedAtMs: endedAtMs })
      .where(eq(sessionBridgesTable.rootSessionId, rootSessionId));
  }

  async deleteBridgeByRootSessionId(rootSessionId: string): Promise<void> {
    await this.db.delete(sessionBridgesTable).where(eq(sessionBridgesTable.rootSessionId, rootSessionId));
  }

  async deleteBridgeBySessionId(sessionId: string): Promise<void> {
    await this.deleteBridgeByRootSessionId(sessionId);
  }
}
