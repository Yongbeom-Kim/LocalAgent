import { execFile } from 'node:child_process';
import { Job, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('task-daemon:ttadk');

export class TTADKExecutor implements TaskExecutor {
  async execute(job: Job): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning TTADK');

    if (!job.payload) {
      logger.error({ job_id: job.job_id, task_id: job.task_id }, 'Job payload is missing or empty — skipping');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Job payload is missing or empty',
      };
    }

    return new Promise((resolve) => {
      execFile(
        'ttadk',
        ['code', '-t', 'claude', '-m', job.executor_model, '-a', `--dangerously-skip-permissions -p ${job.payload}`],
        { maxBuffer: 50 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const execErr = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            logger.error(
              { job_id: job.job_id, task_id: job.task_id, exit_code: execErr.code, stdout: execErr.stdout, stderr: execErr.stderr },
              'TTADK failed',
            );

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              status: 'failure',
              exit_code: typeof execErr.code === 'number' ? execErr.code : null,
              stdout: truncate(execErr.stdout ?? '', MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(execErr.stderr ?? '', MAX_RESULT_OUTPUT_BYTES),
            });
          } else {
            logger.info({ job_id: job.job_id, task_id: job.task_id, stdout, stderr }, 'TTADK completed');

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              status: 'success',
              exit_code: 0,
              stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
            });
          }
        },
      );
    });
  }
}
