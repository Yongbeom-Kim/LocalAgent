import { and, eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { sessionPlatformLinksTable, type SqliteSchema } from './schema';

export type SessionPlatform = 'lark' | 'telegram';

export interface UpsertSessionPlatformLinkParams {
  sessionId: string;
  platform: SessionPlatform;
  externalThreadKey: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number | null;
}

export interface SessionPlatformLinkRow {
  sessionId: string;
  platform: SessionPlatform;
  externalThreadKey: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs: number | null;
}

export class SessionPlatformLinkRepository {
  constructor(private readonly db: LibSQLDatabase<SqliteSchema>) {}

  async upsertLink(params: UpsertSessionPlatformLinkParams): Promise<void> {
    await this.upsertSessionPlatformLink(params);
  }

  async upsertSessionPlatformLink(params: UpsertSessionPlatformLinkParams): Promise<void> {
    await this.db
      .insert(sessionPlatformLinksTable)
      .values({
        sessionId: params.sessionId,
        platform: params.platform,
        externalThreadKey: params.externalThreadKey,
        createdAtMs: params.createdAtMs,
        updatedAtMs: params.updatedAtMs,
        endedAtMs: params.endedAtMs ?? null,
      })
      .onConflictDoUpdate({
        target: [sessionPlatformLinksTable.sessionId, sessionPlatformLinksTable.platform],
        set: {
          externalThreadKey: params.externalThreadKey,
          updatedAtMs: params.updatedAtMs,
          endedAtMs: params.endedAtMs ?? null,
        },
      });
  }

  async getLinkBySessionAndPlatform(
    sessionId: string,
    platform: SessionPlatform,
  ): Promise<SessionPlatformLinkRow | null> {
    const row = await this.db
      .select()
      .from(sessionPlatformLinksTable)
      .where(and(eq(sessionPlatformLinksTable.sessionId, sessionId), eq(sessionPlatformLinksTable.platform, platform)))
      .get();

    return row ?? null;
  }

  async getLinkBySessionIdAndPlatform(
    sessionId: string,
    platform: SessionPlatform,
  ): Promise<SessionPlatformLinkRow | null> {
    return this.getLinkBySessionAndPlatform(sessionId, platform);
  }

  async getLinkByPlatformAndExternalThreadKey(
    platform: SessionPlatform,
    externalThreadKey: string,
  ): Promise<SessionPlatformLinkRow | null> {
    const row = await this.db
      .select()
      .from(sessionPlatformLinksTable)
      .where(
        and(
          eq(sessionPlatformLinksTable.platform, platform),
          eq(sessionPlatformLinksTable.externalThreadKey, externalThreadKey),
        ),
      )
      .get();

    return row ?? null;
  }

  async getLinkByPlatformThread(
    platform: SessionPlatform,
    externalThreadKey: string,
  ): Promise<SessionPlatformLinkRow | null> {
    return this.getLinkByPlatformAndExternalThreadKey(platform, externalThreadKey);
  }

  async markSessionPlatformLinkEnded(
    sessionId: string,
    platform: SessionPlatform,
    endedAtMs: number,
  ): Promise<void> {
    await this.db
      .update(sessionPlatformLinksTable)
      .set({ endedAtMs, updatedAtMs: endedAtMs })
      .where(and(eq(sessionPlatformLinksTable.sessionId, sessionId), eq(sessionPlatformLinksTable.platform, platform)));
  }

  async markLinksEnded(sessionId: string, endedAtMs: number): Promise<void> {
    await this.db
      .update(sessionPlatformLinksTable)
      .set({ endedAtMs, updatedAtMs: endedAtMs })
      .where(eq(sessionPlatformLinksTable.sessionId, sessionId));
  }

  async deleteLinksBySessionId(sessionId: string): Promise<void> {
    await this.db.delete(sessionPlatformLinksTable).where(eq(sessionPlatformLinksTable.sessionId, sessionId));
  }
}
