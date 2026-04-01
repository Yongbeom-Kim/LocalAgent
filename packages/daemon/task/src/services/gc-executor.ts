import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  Job,
  TaskResultSubmission,
  SESSION_BASE_DIR,
  SESSION_DIR_TTL_DAYS,
  createLogger,
} from '@local-agent/shared';

const logger = createLogger('task-daemon:gc-executor');

export class GcExecutor {
  execute(job: Job): TaskResultSubmission {
    if (!existsSync(SESSION_BASE_DIR)) {
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
}
