import { spawn } from 'node:child_process';
import { JobAttempt, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { ExecutorPrecheckResult, TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';
import { checkRequiredBinaries } from './executor-precheck';

const logger = createLogger('task-daemon:claude');
const REQUIRED_BINARIES = ['claude'] as const;

export class ClaudeExecutor implements TaskExecutor {
  async precheck(_env: ExecutionEnvironment): Promise<ExecutorPrecheckResult> {
    return checkRequiredBinaries('claude', REQUIRED_BINARIES);
  }

  async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning Claude');

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
      const continueResult = await this.spawnClaude(job, env, {
        mode: 'continue',
        input: job.payload,
      });

      if (continueResult.status === 'success') {
        return continueResult;
      }

      logger.warn(
        { job_id: job.job_id, task_id: job.task_id, exit_code: continueResult.exit_code, stderr: continueResult.stderr },
        'Claude continue failed, falling back to fresh session',
      );
    }

    return this.spawnClaude(job, env, {
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

  private spawnClaude(
    job: JobAttempt,
    env: ExecutionEnvironment,
    options: { mode: 'continue' | 'fresh'; input: string },
  ): Promise<TaskResultSubmission> {
    const args = [
      '--dangerously-skip-permissions',
      '--model', job.executor_model,
      ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
      ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
      ...(options.mode === 'continue' ? ['--continue'] : []),
      '-p', '-',
    ];

    return new Promise((resolve) => {
      const child = spawn('claude', args, { cwd: env.workDir, detached: process.platform !== 'win32' });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.stdin.write(options.input);
      child.stdin.end();

      child.on('close', (code) => {
        const resolvedStdout = stdout;
        const resolvedStderr = stderr;

        if (code !== 0) {
          logger.error(
            { job_id: job.job_id, task_id: job.task_id, mode: options.mode, exit_code: code },
            'Claude failed',
          );

          resolve({
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            status: 'failure',
            exit_code: code,
            stdout: truncate(resolvedStdout, MAX_RESULT_OUTPUT_BYTES),
            stderr: truncate(resolvedStderr, MAX_RESULT_OUTPUT_BYTES),
          });
        } else {
          logger.info(
            { job_id: job.job_id, task_id: job.task_id, mode: options.mode },
            'Claude completed',
          );

          resolve({
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            status: 'success',
            exit_code: 0,
            stdout: truncate(resolvedStdout, MAX_RESULT_OUTPUT_BYTES),
            stderr: truncate(resolvedStderr, MAX_RESULT_OUTPUT_BYTES),
          });
        }
      });

      child.on('error', (err) => {
        logger.error(
          { job_id: job.job_id, task_id: job.task_id, mode: options.mode, error: err.message },
          'Failed to spawn Claude',
        );

        resolve({
          job_id: job.job_id,
          task_id: job.task_id,
          task_type: job.task_type,
          status: 'failure',
          exit_code: null,
          stdout: '',
          stderr: err.message,
        });
      });
    });
  }
}
