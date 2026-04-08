import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { sessionPlatformLinksTable, type SqliteSchema } from './schema';

export type SessionPlatform = 'lark' | 'telegram';
export type SessionPlatformLinkStatus = 'pending' | 'active' | 'ended';

export interface UpsertSessionPlatformLinkParams {
  sessionId: string;
  platform: SessionPlatform;
  externalThreadKey: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number | null;
}

export interface ClaimPendingSessionPlatformLinkParams {
  sessionId: string;
  platform: SessionPlatform;
  claimToken: string;
  claimExpiresAtMs: number;
  nowMs: number;
}

export interface ActivateClaimedSessionPlatformLinkParams {
  sessionId: string;
  platform: SessionPlatform;
  claimToken: string;
  externalThreadKey: string;
  updatedAtMs: number;
}

export interface ReleaseSessionPlatformClaimParams {
  sessionId: string;
  platform: SessionPlatform;
  claimToken: string;
  updatedAtMs: number;
}

export interface SessionPlatformLinkRow {
  sessionId: string;
  platform: SessionPlatform;
  externalThreadKey: string | null;
  linkStatus: SessionPlatformLinkStatus;
  claimToken: string | null;
  claimExpiresAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs: number | null;
}

function isSessionPlatform(value: string): value is SessionPlatform {
  return value === 'lark' || value === 'telegram';
}

function isSessionPlatformLinkStatus(value: string): value is SessionPlatformLinkStatus {
  return value === 'pending' || value === 'active' || value === 'ended';
}

function toSessionPlatformLinkRow(
  row:
    | {
        sessionId: string;
        platform: string;
        externalThreadKey: string | null;
        linkStatus: string;
        claimToken: string | null;
        claimExpiresAtMs: number | null;
        createdAtMs: number;
        updatedAtMs: number;
        endedAtMs: number | null;
      }
    | undefined,
): SessionPlatformLinkRow | null {
  if (!row) {
    return null;
  }

  if (!isSessionPlatform(row.platform)) {
    throw new Error(`Unexpected session platform: ${row.platform}`);
  }

  if (!isSessionPlatformLinkStatus(row.linkStatus)) {
    throw new Error(`Unexpected session platform link status: ${row.linkStatus}`);
  }

  return {
    ...row,
    platform: row.platform,
    linkStatus: row.linkStatus,
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
        linkStatus: params.endedAtMs == null ? 'active' : 'ended',
        claimToken: null,
        claimExpiresAtMs: null,
        createdAtMs: params.createdAtMs,
        updatedAtMs: params.updatedAtMs,
        endedAtMs: params.endedAtMs ?? null,
      })
      .onConflictDoUpdate({
        target: [sessionPlatformLinksTable.sessionId, sessionPlatformLinksTable.platform],
        set: {
          externalThreadKey: params.externalThreadKey,
          linkStatus: params.endedAtMs == null ? 'active' : 'ended',
          claimToken: null,
          claimExpiresAtMs: null,
          updatedAtMs: sql`MAX(${sessionPlatformLinksTable.updatedAtMs}, ${params.updatedAtMs})`,
          endedAtMs: sql`CASE
            WHEN ${params.endedAtMs ?? null} IS NULL THEN ${sessionPlatformLinksTable.endedAtMs}
            WHEN ${sessionPlatformLinksTable.endedAtMs} IS NULL THEN ${params.endedAtMs ?? null}
            WHEN ${params.endedAtMs ?? null} > ${sessionPlatformLinksTable.endedAtMs} THEN ${params.endedAtMs ?? null}
            ELSE ${sessionPlatformLinksTable.endedAtMs}
          END`,
        },
      });
  }

  async claimPendingLink(params: ClaimPendingSessionPlatformLinkParams): Promise<SessionPlatformLinkRow> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(sessionPlatformLinksTable)
        .where(
          and(
            eq(sessionPlatformLinksTable.sessionId, params.sessionId),
            eq(sessionPlatformLinksTable.platform, params.platform),
          ),
        )
        .get();

      const existingRow = toSessionPlatformLinkRow(existing);
      if (!existingRow) {
        await tx.insert(sessionPlatformLinksTable).values({
          sessionId: params.sessionId,
          platform: params.platform,
          externalThreadKey: null,
          linkStatus: 'pending',
          claimToken: params.claimToken,
          claimExpiresAtMs: params.claimExpiresAtMs,
          createdAtMs: params.nowMs,
          updatedAtMs: params.nowMs,
          endedAtMs: null,
        });
      } else if (existingRow.linkStatus === 'active' || existingRow.linkStatus === 'ended') {
        return existingRow;
      } else {
        const claimIsOwnedByOther =
          existingRow.claimToken !== null &&
          existingRow.claimToken !== params.claimToken &&
          existingRow.claimExpiresAtMs !== null &&
          existingRow.claimExpiresAtMs > params.nowMs;

        if (claimIsOwnedByOther) {
          return existingRow;
        }

        await tx
          .update(sessionPlatformLinksTable)
          .set({
            externalThreadKey: null,
            linkStatus: 'pending',
            claimToken: params.claimToken,
            claimExpiresAtMs: params.claimExpiresAtMs,
            updatedAtMs: params.nowMs,
          })
          .where(
            and(
              eq(sessionPlatformLinksTable.sessionId, params.sessionId),
              eq(sessionPlatformLinksTable.platform, params.platform),
            ),
          );
      }

      const claimed = await tx
        .select()
        .from(sessionPlatformLinksTable)
        .where(
          and(
            eq(sessionPlatformLinksTable.sessionId, params.sessionId),
            eq(sessionPlatformLinksTable.platform, params.platform),
          ),
        )
        .get();

      const claimedRow = toSessionPlatformLinkRow(claimed);
      if (!claimedRow) {
        throw new Error('Failed to claim session platform link');
      }

      return claimedRow;
    });
  }

  async activateClaimedLink(params: ActivateClaimedSessionPlatformLinkParams): Promise<boolean> {
    const result = await this.db
      .update(sessionPlatformLinksTable)
      .set({
        externalThreadKey: params.externalThreadKey,
        linkStatus: 'active',
        claimToken: null,
        claimExpiresAtMs: null,
        updatedAtMs: params.updatedAtMs,
        endedAtMs: null,
      })
      .where(
        and(
          eq(sessionPlatformLinksTable.sessionId, params.sessionId),
          eq(sessionPlatformLinksTable.platform, params.platform),
          eq(sessionPlatformLinksTable.linkStatus, 'pending'),
          eq(sessionPlatformLinksTable.claimToken, params.claimToken),
          or(
            sql`${sessionPlatformLinksTable.claimExpiresAtMs} IS NULL`,
            sql`${sessionPlatformLinksTable.claimExpiresAtMs} >= ${params.updatedAtMs}`,
          ),
        ),
      );

    return result.rowsAffected > 0;
  }

  async releaseSessionPlatformClaim(params: ReleaseSessionPlatformClaimParams): Promise<boolean> {
    const result = await this.db
      .update(sessionPlatformLinksTable)
      .set({
        externalThreadKey: null,
        linkStatus: 'pending',
        claimToken: null,
        claimExpiresAtMs: null,
        updatedAtMs: params.updatedAtMs,
      })
      .where(
        and(
          eq(sessionPlatformLinksTable.sessionId, params.sessionId),
          eq(sessionPlatformLinksTable.platform, params.platform),
          eq(sessionPlatformLinksTable.linkStatus, 'pending'),
          eq(sessionPlatformLinksTable.claimToken, params.claimToken),
        ),
      );

    return result.rowsAffected > 0;
  }

  async releaseExpiredOrFailedClaim(params: ReleaseSessionPlatformClaimParams): Promise<boolean> {
    return this.releaseSessionPlatformClaim(params);
  }

  async getActiveLinkBySessionAndPlatform(
    sessionId: string,
    platform: SessionPlatform,
  ): Promise<SessionPlatformLinkRow | null> {
    const row = await this.db
      .select()
      .from(sessionPlatformLinksTable)
      .where(
        and(
          eq(sessionPlatformLinksTable.sessionId, sessionId),
          eq(sessionPlatformLinksTable.platform, platform),
          eq(sessionPlatformLinksTable.linkStatus, 'active'),
          isNotNull(sessionPlatformLinksTable.externalThreadKey),
        ),
      )
      .get();

    return toSessionPlatformLinkRow(row);
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
          eq(sessionPlatformLinksTable.linkStatus, 'active'),
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
      .set({
        linkStatus: 'ended',
        claimToken: null,
        claimExpiresAtMs: null,
        endedAtMs,
        updatedAtMs: endedAtMs,
      })
      .where(and(eq(sessionPlatformLinksTable.sessionId, sessionId), eq(sessionPlatformLinksTable.platform, platform)));
  }

  async markLinksEnded(sessionId: string, endedAtMs: number): Promise<void> {
    await this.db
      .update(sessionPlatformLinksTable)
      .set({
        linkStatus: 'ended',
        claimToken: null,
        claimExpiresAtMs: null,
        endedAtMs,
        updatedAtMs: endedAtMs,
      })
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
