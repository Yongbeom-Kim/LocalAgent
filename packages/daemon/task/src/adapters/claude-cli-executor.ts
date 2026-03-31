import { spawn } from 'node:child_process';
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
      ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
      '-p', '-',
    ];

    return new Promise((resolve) => {
      const child = spawn('claude', args, { cwd: env.workDir });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      child.stdin.write(job.payload);
      child.stdin.end();

      child.on('close', (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();

        if (code !== 0) {
          logger.error(
            { job_id: job.job_id, task_id: job.task_id, exit_code: code, stdout, stderr },
            'Claude Code failed',
          );

          resolve({
            job_id: job.job_id,
            task_id: job.task_id,
            status: 'failure',
            exit_code: code,
            stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
            stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
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
      });

      child.on('error', (err) => {
        logger.error(
          { job_id: job.job_id, task_id: job.task_id, error: err.message },
          'Failed to spawn Claude Code',
        );

        resolve({
          job_id: job.job_id,
          task_id: job.task_id,
          status: 'failure',
          exit_code: null,
          stdout: '',
          stderr: err.message,
        });
      });
    });
  }
}
