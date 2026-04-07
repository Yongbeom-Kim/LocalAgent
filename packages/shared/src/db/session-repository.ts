import { eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { sessionsTable, type SqliteSchema } from './schema';

export interface UpsertSessionParams {
  sessionId: string;
  taskType: string;
  executor?: string | null;
  executorModel?: string | null;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number | null;
}

export interface SessionRow {
  sessionId: string;
  taskType: string;
  executor: string | null;
  executorModel: string | null;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs: number | null;
}

export class SessionRepository {
  constructor(private readonly db: LibSQLDatabase<SqliteSchema>) {}

  async upsertSession(params: UpsertSessionParams): Promise<void> {
    await this.db
      .insert(sessionsTable)
      .values({
        sessionId: params.sessionId,
        taskType: params.taskType,
        executor: params.executor ?? null,
        executorModel: params.executorModel ?? null,
        status: params.status,
        createdAtMs: params.createdAtMs,
        updatedAtMs: params.updatedAtMs,
        endedAtMs: params.endedAtMs ?? null,
      })
      .onConflictDoUpdate({
        target: sessionsTable.sessionId,
        set: {
          taskType: params.taskType,
          executor: params.executor ?? null,
          executorModel: params.executorModel ?? null,
          status: params.status,
          createdAtMs: sql`MIN(${sessionsTable.createdAtMs}, ${params.createdAtMs})`,
          updatedAtMs: params.updatedAtMs,
          endedAtMs: params.endedAtMs ?? null,
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
}
