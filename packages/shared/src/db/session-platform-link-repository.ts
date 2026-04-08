import { and, eq, inArray } from 'drizzle-orm';
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

function toSessionPlatformLinkRow(
  row:
    | {
        sessionId: string;
        platform: string;
        externalThreadKey: string;
        createdAtMs: number;
        updatedAtMs: number;
        endedAtMs: number | null;
      }
    | undefined,
): SessionPlatformLinkRow | null {
  if (!row) {
    return null;
  }

  if (row.platform !== 'lark' && row.platform !== 'telegram') {
    throw new Error(`Unexpected session platform: ${row.platform}`);
  }

  return {
    ...row,
    platform: row.platform,
  };
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

    return toSessionPlatformLinkRow(row);
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
    const rows = await this.listLinksByPlatformAndExternalThreadKey(platform, externalThreadKey);
    return rows[0] ?? null;
  }

  async listLinksByPlatformAndExternalThreadKey(
    platform: SessionPlatform,
    externalThreadKey: string,
  ): Promise<SessionPlatformLinkRow[]> {
    const row = await this.db
      .select()
      .from(sessionPlatformLinksTable)
      .where(
        and(
          eq(sessionPlatformLinksTable.platform, platform),
          eq(sessionPlatformLinksTable.externalThreadKey, externalThreadKey),
        ),
      )
      .orderBy(sessionPlatformLinksTable.createdAtMs, sessionPlatformLinksTable.sessionId);

    return row.map((entry) => toSessionPlatformLinkRow(entry)).filter((entry): entry is SessionPlatformLinkRow => entry !== null);
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

  async deleteLinksBySessionIds(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }

    await this.db.delete(sessionPlatformLinksTable).where(inArray(sessionPlatformLinksTable.sessionId, sessionIds));
  }
}
