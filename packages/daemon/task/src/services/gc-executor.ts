import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Job, TaskResultSubmission, SESSION_BASE_DIR, SESSION_DIR_TTL_DAYS, createLogger, LarkHistoryRepository, createSqliteClient, loadSqliteConfig } from '@local-agent/shared';
import { SessionLockManager } from './session-lock';

const logger = createLogger('task-daemon:gc-executor');

type ListStaleSessionIds = (cutoffMs: number) => Promise<string[]>;
type DeleteRowsBySessionId = (sessionId: string) => Promise<void>;

const listStaleSessionIdsFromDb: ListStaleSessionIds = async (cutoffMs: number): Promise<string[]> => {
  const client = await createSqliteClient(loadSqliteConfig());

  try {
    const repository = new LarkHistoryRepository(client.db);
    return await repository.getStaleLarkSessionIdsBeforeUpdatedAt(cutoffMs);
  } finally {
    client.close();
  }
};

const deleteRowsBySessionIdFromDb: DeleteRowsBySessionId = async (sessionId: string): Promise<void> => {
  const client = await createSqliteClient(loadSqliteConfig());

  try {
    const repository = new LarkHistoryRepository(client.db);
    await repository.deleteLarkRowsBySessionId(sessionId);
  } finally {
    client.close();
  }
};

export class GcExecutor {
  private readonly sessionLock = new SessionLockManager();

  constructor(
    private readonly listStaleSessionIds: ListStaleSessionIds = listStaleSessionIdsFromDb,
    private readonly deleteRowsBySessionId: DeleteRowsBySessionId = deleteRowsBySessionIdFromDb,
  ) {}

  async execute(job: Job): Promise<TaskResultSubmission> {
    const cutoff = Date.now() - SESSION_DIR_TTL_DAYS * 24 * 60 * 60 * 1000;

    if (!existsSync(SESSION_BASE_DIR)) {
      const dbCleanup = await this.cleanupStaleRows(job, cutoff);
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        ...(job.task_source ? { task_source: job.task_source } : {}),
        status: 'success',
        exit_code: 0,
        stdout: this.formatSummary({
          removedDirs: 0,
          retainedDirs: 0,
          deletedDbSessions: dbCleanup.deleted,
          errors: dbCleanup.errors,
        }),
        stderr: '',
      };
    }

    let removed = 0;
    let retained = 0;
    let errors = 0;

    for (const entry of readdirSync(SESSION_BASE_DIR)) {
      const dirPath = join(SESSION_BASE_DIR, entry);

      try {
        const stats = statSync(dirPath);
        if (!stats.isDirectory()) {
          continue;
        }

        // Skip actively-locked sessions (safety net)
        if (this.sessionLock.isLockedByLiveProcess(entry)) {
          logger.info({ job_id: job.job_id, dirPath }, 'Skipping locked session directory');
          retained += 1;
          continue;
        }

        if (stats.mtimeMs < cutoff && stats.atimeMs < cutoff) {
          try {
            rmSync(dirPath, { recursive: true, force: true });
            removed += 1;
          } catch (error) {
            errors += 1;
            logger.error({ job_id: job.job_id, dirPath, err: error }, 'Failed to remove stale session directory');
          }
        } else {
          retained += 1;
        }
      } catch (error) {
        errors += 1;
        logger.error({ job_id: job.job_id, dirPath, err: error }, 'Failed to inspect session directory');
      }
    }

    const dbCleanup = await this.cleanupStaleRows(job, cutoff);
    errors += dbCleanup.errors;

    return {
      job_id: job.job_id,
      task_id: job.task_id,
      task_type: job.task_type,
      ...(job.task_source ? { task_source: job.task_source } : {}),
      status: 'success',
      exit_code: 0,
      stdout: this.formatSummary({
        removedDirs: removed,
        retainedDirs: retained,
        deletedDbSessions: dbCleanup.deleted,
        errors,
      }),
      stderr: '',
    };
  }

  private async cleanupStaleRows(job: Job, cutoffMs: number): Promise<{ deleted: number; errors: number }> {
    let staleSessionIds: string[];
    try {
      staleSessionIds = await this.listStaleSessionIds(cutoffMs);
    } catch (error) {
      logger.error({ job_id: job.job_id, cutoff_ms: cutoffMs, err: error }, 'Failed to query stale sessions for DB cleanup');
      return { deleted: 0, errors: 1 };
    }

    if (staleSessionIds.length === 0) {
      return { deleted: 0, errors: 0 };
    }

    let deleted = 0;
    let errors = 0;

    for (const sessionId of staleSessionIds) {
      try {
        await this.deleteRowsBySessionId(sessionId);
        deleted += 1;
      } catch (error) {
        errors += 1;
        logger.error({ job_id: job.job_id, session_id: sessionId, err: error }, 'Failed to delete stale session DB rows');
      }
    }

    return { deleted, errors };
  }

  private formatSummary(params: {
    removedDirs: number;
    retainedDirs: number;
    deletedDbSessions: number;
    errors: number;
  }): string {
    return `GC complete: removed ${params.removedDirs} session dir(s), retained ${params.retainedDirs} session dir(s), deleted ${params.deletedDbSessions} DB session(s).${params.errors > 0 ? ` Errors: ${params.errors}.` : ''}`;
  }
}
