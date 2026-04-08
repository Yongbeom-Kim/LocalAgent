import { eq, inArray, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { sessionsTable, type SqliteSchema } from './schema';

export interface UpsertSessionParams {
  sessionId: string;
  parentSessionId?: string | null;
  taskType: string;
  executor?: string | null;
  executorModel?: string | null;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number | null;
  fallbackSeedText?: string | null;
  fallbackOrigin?: string | null;
  fallbackTitleHint?: string | null;
}

export interface SessionRow {
  sessionId: string;
  parentSessionId: string | null;
  taskType: string;
  executor: string | null;
  executorModel: string | null;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs: number | null;
  fallbackSeedText: string | null;
  fallbackOrigin: string | null;
  fallbackTitleHint: string | null;
}

export class SessionRepository {
  constructor(private readonly db: LibSQLDatabase<SqliteSchema>) {}

  async upsertSession(params: UpsertSessionParams): Promise<void> {
    await this.db
      .insert(sessionsTable)
      .values({
        sessionId: params.sessionId,
        parentSessionId: params.parentSessionId ?? null,
        taskType: params.taskType,
        executor: params.executor ?? null,
        executorModel: params.executorModel ?? null,
        status: params.status,
        createdAtMs: params.createdAtMs,
        updatedAtMs: params.updatedAtMs,
        endedAtMs: params.endedAtMs ?? null,
        fallbackSeedText: params.fallbackSeedText ?? null,
        fallbackOrigin: params.fallbackOrigin ?? null,
        fallbackTitleHint: params.fallbackTitleHint ?? null,
      })
      .onConflictDoUpdate({
        target: sessionsTable.sessionId,
        set: {
          parentSessionId: sessionsTable.parentSessionId,
          taskType: sql`CASE
            WHEN ${params.updatedAtMs} >= ${sessionsTable.updatedAtMs} THEN ${params.taskType}
            ELSE ${sessionsTable.taskType}
          END`,
          executor: sql`CASE
            WHEN ${params.updatedAtMs} >= ${sessionsTable.updatedAtMs} THEN ${params.executor ?? null}
            ELSE ${sessionsTable.executor}
          END`,
          executorModel: sql`CASE
            WHEN ${params.updatedAtMs} >= ${sessionsTable.updatedAtMs} THEN ${params.executorModel ?? null}
            ELSE ${sessionsTable.executorModel}
          END`,
          status: sql`CASE
            WHEN ${params.updatedAtMs} >= ${sessionsTable.updatedAtMs} THEN ${params.status}
            ELSE ${sessionsTable.status}
          END`,
          createdAtMs: sql`MIN(${sessionsTable.createdAtMs}, ${params.createdAtMs})`,
          updatedAtMs: sql`MAX(${sessionsTable.updatedAtMs}, ${params.updatedAtMs})`,
          endedAtMs: sql`CASE
            WHEN ${params.endedAtMs ?? null} IS NULL THEN ${sessionsTable.endedAtMs}
            WHEN ${sessionsTable.endedAtMs} IS NULL THEN ${params.endedAtMs ?? null}
            WHEN ${params.endedAtMs ?? null} > ${sessionsTable.endedAtMs} THEN ${params.endedAtMs ?? null}
            ELSE ${sessionsTable.endedAtMs}
          END`,
          fallbackSeedText: sql`CASE
            WHEN ${params.updatedAtMs} >= ${sessionsTable.updatedAtMs} THEN ${params.fallbackSeedText ?? null}
            ELSE ${sessionsTable.fallbackSeedText}
          END`,
          fallbackOrigin: sql`CASE
            WHEN ${params.updatedAtMs} >= ${sessionsTable.updatedAtMs} THEN ${params.fallbackOrigin ?? null}
            ELSE ${sessionsTable.fallbackOrigin}
          END`,
          fallbackTitleHint: sql`CASE
            WHEN ${params.updatedAtMs} >= ${sessionsTable.updatedAtMs} THEN ${params.fallbackTitleHint ?? null}
            ELSE ${sessionsTable.fallbackTitleHint}
          END`,
        },
      });
  }

  async getSessionById(sessionId: string): Promise<SessionRow | null> {
    const row = await this.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.sessionId, sessionId))
      .get();

    return row ?? null;
  }

  async markSessionEnded(sessionId: string, endedAtMs: number): Promise<void> {
    await this.db
      .update(sessionsTable)
      .set({ endedAtMs, updatedAtMs: endedAtMs, status: 'ended' })
      .where(eq(sessionsTable.sessionId, sessionId));
  }

  async deleteSessionById(sessionId: string): Promise<void> {
    await this.db.delete(sessionsTable).where(eq(sessionsTable.sessionId, sessionId));
  }

  async listChildSessions(parentSessionId: string): Promise<SessionRow[]> {
    return this.db.select().from(sessionsTable).where(eq(sessionsTable.parentSessionId, parentSessionId));
  }

  async listDescendantSessionIds(rootSessionId: string): Promise<string[]> {
    const descendants: string[] = [];
    const queue = [rootSessionId];
    const seen = new Set<string>(queue);

    while (queue.length > 0) {
      const parentSessionId = queue.shift()!;
      const children = await this.listChildSessions(parentSessionId);

      for (const child of children) {
        if (seen.has(child.sessionId)) {
          continue;
        }

        seen.add(child.sessionId);
        descendants.push(child.sessionId);
        queue.push(child.sessionId);
      }
    }

    return descendants;
  }

  async deleteSessionsByIds(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }

    await this.db.delete(sessionsTable).where(inArray(sessionsTable.sessionId, sessionIds));
  }
}
