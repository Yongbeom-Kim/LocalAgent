import { execFile } from 'node:child_process';
import { JobAttempt, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:ttadk');

export class TTADKExecutor implements TaskExecutor {
  async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning TTADK');

    if (!job.payload) {
      logger.error({ job_id: job.job_id, task_id: job.task_id }, 'Job payload is missing or empty — skipping');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Job payload is missing or empty',
      };
    }

    if (env.isExistingWorkspace && !job.skipContinue) {
      const continueResult = await this.execTTADK(job, env, {
        mode: 'continue',
        input: job.payload,
      });

      if (continueResult.status === 'success') {
        return continueResult;
      }

      logger.warn(
        { job_id: job.job_id, task_id: job.task_id, exit_code: continueResult.exit_code, stderr: continueResult.stderr },
        'TTADK continue failed, falling back to fresh session',
      );
    }

    return this.execTTADK(job, env, {
      mode: 'fresh',
      input: this.buildFreshInput(job),
    });
  }

  private buildFreshInput(job: JobAttempt): string {
    if (!job.history) {
      return job.payload;
    }

    return `--- Thread Context ---\n${job.history}\n--- Current Message ---\n${job.payload}`;
  }

  private execTTADK(
    job: JobAttempt,
    env: ExecutionEnvironment,
    options: { mode: 'continue' | 'fresh'; input: string },
  ): Promise<TaskResultSubmission> {
    const claudeArgs = [
      '--bare',
      '--dangerously-skip-permissions',
      ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
      ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
      ...(options.mode === 'continue' ? ['--continue'] : []),
      '-p', options.input,
    ].join(' ');

    const args = ['code', '-t', 'claude', '-m', job.executor_model, '-a', claudeArgs];

    return new Promise((resolve) => {
      execFile(
        'ttadk',
        args,
        { maxBuffer: 50 * 1024 * 1024, cwd: env.workDir },
        (error, stdout, stderr) => {
          if (error) {
            const execErr = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            logger.error(
              { job_id: job.job_id, task_id: job.task_id, mode: options.mode, exit_code: execErr.code, stdout: execErr.stdout, stderr: execErr.stderr },
              'TTADK failed',
            );

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              task_type: job.task_type,
              status: 'failure',
              exit_code: typeof execErr.code === 'number' ? execErr.code : null,
              stdout: truncate(execErr.stdout ?? '', MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(execErr.stderr ?? '', MAX_RESULT_OUTPUT_BYTES),
            });
          } else {
            logger.info({ job_id: job.job_id, task_id: job.task_id, mode: options.mode, stdout, stderr }, 'TTADK completed');

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              task_type: job.task_type,
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
