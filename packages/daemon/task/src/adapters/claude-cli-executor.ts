import { execFile } from 'node:child_process';
import { JobAttempt, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:claude-cli');

export class ClaudeCliExecutor implements TaskExecutor {
  async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning Claude Code');

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

    const args = [
      '--dangerously-skip-permissions',
      '--model', job.executor_model,
      ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
      '-p', job.payload,
    ];

    return new Promise((resolve) => {
      execFile(
        'claude',
        args,
        { maxBuffer: 50 * 1024 * 1024, cwd: env.workDir },
        (error, stdout, stderr) => {
          if (error) {
            const execErr = error as NodeJS.ErrnoException;
            logger.error(
              { job_id: job.job_id, task_id: job.task_id, exit_code: execErr.code, stdout, stderr },
              'Claude Code failed',
            );

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              status: 'failure',
              exit_code: typeof execErr.code === 'number' ? execErr.code : null,
              stdout: truncate(stdout ?? '', MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(stderr ?? '', MAX_RESULT_OUTPUT_BYTES),
            });
          } else {
            logger.info({ job_id: job.job_id, task_id: job.task_id, stdout, stderr }, 'Claude Code completed');

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
