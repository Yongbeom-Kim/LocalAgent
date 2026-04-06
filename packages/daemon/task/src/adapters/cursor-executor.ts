import { spawn, spawnSync } from 'node:child_process';
import { JobAttempt, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { ExecutorPrecheckResult, TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:cursor');
const REQUIRED_BINARIES = ['agent'] as const;

export class CursorExecutor implements TaskExecutor {
  async precheck(_env: ExecutionEnvironment): Promise<ExecutorPrecheckResult> {
    return this.checkRequiredBinaries('cursor', REQUIRED_BINARIES);
  }

  async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning Cursor');

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

    if (env.pluginDirs.length > 0) {
      logger.debug(
        { job_id: job.job_id, task_id: job.task_id, plugin_count: env.pluginDirs.length },
        'Cursor executor ignores plugin directories in v1',
      );
    }

    if (env.isExistingWorkspace && !job.skipContinue) {
      const continueResult = await this.spawnAgent(job, env, {
        mode: 'continue',
        input: job.payload,
      });

      if (continueResult.status === 'success') {
        return continueResult;
      }

      logger.warn(
        { job_id: job.job_id, task_id: job.task_id, exit_code: continueResult.exit_code, stderr: continueResult.stderr },
        'Cursor continue failed, falling back to fresh session',
      );
    }

    return this.spawnAgent(job, env, {
      mode: 'fresh',
      input: this.buildFreshInput(job),
    });
  }

  private checkRequiredBinaries(
    executorName: string,
    binaries: readonly string[],
  ): ExecutorPrecheckResult {
    try {
      const missing = binaries.filter((binary) => {
        const result = spawnSync('sh', ['-lc', `command -v ${binary} >/dev/null 2>&1`], {
          stdio: 'ignore',
        });
        return result.status !== 0;
      });

      if (missing.length === 0) {
        return { ok: true };
      }

      return {
        ok: false,
        stderr: `Executor "${executorName}" unavailable: missing required binaries in PATH: ${missing.join(', ')}`,
      };
    } catch {
      return {
        ok: false,
        stderr: `Executor "${executorName}" unavailable: missing required binaries in PATH: ${binaries.join(', ')}`,
      };
    }
  }

  private buildFreshInput(job: JobAttempt): string {
    if (!job.history) {
      return job.payload;
    }

    return `--- Thread Context ---\n${job.history}\n--- Current Message ---\n${job.payload}`;
  }

  private buildPromptForArgv(job: JobAttempt, input: string): string {
    if (job.system_prompt) {
      return `--- System ---\n${job.system_prompt}\n--- User ---\n${input}`;
    }
    return input;
  }

  private spawnAgent(
    job: JobAttempt,
    env: ExecutionEnvironment,
    options: { mode: 'continue' | 'fresh'; input: string },
  ): Promise<TaskResultSubmission> {
    const promptString = this.buildPromptForArgv(job, options.input);
    const args = [
      '--print',
      '--trust',
      '--force',
      '--workspace',
      env.workDir,
      '--model',
      job.executor_model,
      '--output-format',
      'text',
      ...(options.mode === 'continue' ? ['--continue'] : []),
      '--',
      promptString,
    ];

    return new Promise((resolve) => {
      const child = spawn('agent', args, { cwd: env.workDir, shell: false, detached: process.platform !== 'win32' });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        const resolvedStdout = stdout;
        const resolvedStderr = stderr;

        if (code !== 0) {
          logger.error(
            { job_id: job.job_id, task_id: job.task_id, mode: options.mode, exit_code: code },
            'Cursor failed',
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
            'Cursor completed',
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
          'Failed to spawn Cursor',
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
