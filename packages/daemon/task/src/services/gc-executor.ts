import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Job, TaskResultSubmission, SESSION_BASE_DIR, SESSION_DIR_TTL_DAYS, createLogger, LarkHistoryRepository, createSqliteClient, loadSqliteConfig } from '@local-agent/shared';
import { SessionLockManager } from './session-lock';

const logger = createLogger('task-daemon:gc-executor');

type ListEndedSessionIds = () => Promise<string[]>;
type DeleteRowsBySessionId = (sessionId: string) => Promise<void>;

const listEndedSessionIdsFromDb: ListEndedSessionIds = async (): Promise<string[]> => {
  const client = await createSqliteClient(loadSqliteConfig());

  try {
    const queryResult = await client.connection.execute(
      "SELECT session_id FROM lark_threads WHERE status = 'ended'",
    );

    return queryResult.rows
      .map((row) => {
        if (!row || typeof row !== 'object') {
          return '';
        }
        const raw = (row as Record<string, unknown>).session_id;
        return typeof raw === 'string' ? raw : '';
      })
      .filter((sessionId) => sessionId.length > 0);
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
    private readonly listEndedSessionIds: ListEndedSessionIds = listEndedSessionIdsFromDb,
    private readonly deleteRowsBySessionId: DeleteRowsBySessionId = deleteRowsBySessionIdFromDb,
  ) {}

  async execute(job: Job): Promise<TaskResultSubmission> {
    if (!existsSync(SESSION_BASE_DIR)) {
      await this.cleanupEndedRows(job);
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        ...(job.task_source ? { task_source: job.task_source } : {}),
        status: 'success',
        exit_code: 0,
        stdout: 'GC complete: no session directories found.',
        stderr: '',
      };
    }

    const cutoff = Date.now() - SESSION_DIR_TTL_DAYS * 24 * 60 * 60 * 1000;
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

    await this.cleanupEndedRows(job);

    return {
      job_id: job.job_id,
      task_id: job.task_id,
      task_type: job.task_type,
      ...(job.task_source ? { task_source: job.task_source } : {}),
      status: 'success',
      exit_code: 0,
      stdout: `GC complete: removed ${removed} session(s), retained ${retained}.${errors > 0 ? ` Errors: ${errors}.` : ''}`,
      stderr: '',
    };
  }

  private async cleanupEndedRows(job: Job): Promise<void> {
    let endedSessionIds: string[];
    try {
      endedSessionIds = await this.listEndedSessionIds();
    } catch (error) {
      logger.error({ job_id: job.job_id, err: error }, 'Failed to query ended sessions for DB cleanup');
      return;
    }

    if (endedSessionIds.length === 0) {
      return;
    }

    for (const sessionId of endedSessionIds) {
      try {
        await this.deleteRowsBySessionId(sessionId);
      } catch (error) {
        logger.error({ job_id: job.job_id, session_id: sessionId, err: error }, 'Failed to delete ended session DB rows');
      }
    }
  }
}
