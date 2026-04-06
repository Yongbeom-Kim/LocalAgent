import { spawn } from 'node:child_process';
import { JobAttempt, TaskResultSubmission, createLogger } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';
import { OutputCapture } from '../services/output-capture';

const logger = createLogger('task-daemon:shell-executor');

export class ShellExecutor implements TaskExecutor {
  async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning shell command');

    if (!job.payload) {
      logger.error({ job_id: job.job_id, task_id: job.task_id }, 'Job payload is missing or empty — skipping');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        session_id: job.session_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Job payload is missing or empty',
      };
    }

    return new Promise((resolve) => {
      const child = spawn('zsh', ['-lc', job.payload], {
        cwd: env.workDir,
        detached: process.platform !== 'win32',
      });
      const stdoutCapture = new OutputCapture();
      const stderrCapture = new OutputCapture();

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutCapture.append(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrCapture.append(chunk);
      });

      child.on('close', (code) => {
        const stdout = stdoutCapture.read();
        const stderr = stderrCapture.read();

        if (code !== 0) {
          logger.error(
            { job_id: job.job_id, task_id: job.task_id, exit_code: code },
            'Shell command failed',
          );

          resolve({
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            session_id: job.session_id,
            status: 'failure',
            exit_code: code,
            stdout,
            stderr,
          });
          return;
        }

        logger.info({ job_id: job.job_id, task_id: job.task_id }, 'Shell command completed');

        resolve({
          job_id: job.job_id,
          task_id: job.task_id,
          task_type: job.task_type,
          session_id: job.session_id,
          status: 'success',
          exit_code: 0,
          stdout,
          stderr,
        });
      });

      child.on('error', (err) => {
        logger.error(
          { job_id: job.job_id, task_id: job.task_id, error: err.message },
          'Failed to spawn shell command',
        );

        resolve({
          job_id: job.job_id,
          task_id: job.task_id,
          task_type: job.task_type,
          session_id: job.session_id,
          status: 'failure',
          exit_code: null,
          stdout: '',
          stderr: err.message,
        });
      });
    });
  }
}
