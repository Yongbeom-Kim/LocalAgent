import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger, MAX_RESULT_OUTPUT_BYTES, truncate } from '@local-agent/shared';

const execFileAsync = promisify(execFile);
const logger = createLogger('task-daemon:setup-hook-runner');

interface JobContext {
  job_id: string;
  task_id: string;
  task_type: string;
  session_id: string;
  payload: string;
}

export class SetupHookExecutionError extends Error {
  exit_code = 1;
  stdout: string;
  stderr: string;
  timedOut: boolean;

  constructor(params: { message: string; stdout: string; stderr: string; timedOut: boolean }) {
    super(params.message);
    this.name = 'SetupHookExecutionError';
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.timedOut = params.timedOut;
  }
}

export class SetupHookRunner {
  async run(
    script: string,
    workDir: string,
    jobContext: JobContext,
    timeoutMs: number,
  ): Promise<void> {
    logger.info({ job_id: jobContext.job_id, workDir, timeoutMs }, 'Running setup hook');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LOCALAGENT_JOB_ID: jobContext.job_id,
      LOCALAGENT_TASK_ID: jobContext.task_id,
      LOCALAGENT_TASK_TYPE: jobContext.task_type,
      LOCALAGENT_SESSION_ID: jobContext.session_id,
      LOCALAGENT_PAYLOAD: jobContext.payload,
    };

    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-e', '-u', '-o', 'pipefail', '-c', script], {
        cwd: workDir,
        env,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      if (stdout) {
        logger.info({ job_id: jobContext.job_id, stdout }, 'Setup hook stdout');
      }
      if (stderr) {
        logger.warn({ job_id: jobContext.job_id, stderr }, 'Setup hook stderr');
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        code?: unknown;
        killed?: unknown;
        signal?: unknown;
        stdout?: unknown;
        stderr?: unknown;
      };

      const rawStdout = typeof err.stdout === 'string' ? err.stdout : '';
      const rawStderr = typeof err.stderr === 'string' ? err.stderr : '';

      const exitCode = typeof err.code === 'number' ? err.code : null;
      // execFile() timeout errors typically set killed=true and leave exit code unset.
      const timedOut = err.killed === true && exitCode === null;
      const isNonZeroExit = exitCode !== null && exitCode !== 0;

      // Only wrap the cases we want downstream to treat as a setup hook failure.
      if (!timedOut && !isNonZeroExit) {
        const message = rawStderr
          ? `Setup hook failed: ${rawStderr.trim()}`
          : `Setup hook failed: ${err.message}`;

        logger.error({ job_id: jobContext.job_id, err: error }, 'Setup hook failed');
        throw new Error(message);
      }

      let stderr = rawStderr.trim() ? rawStderr : (err.message ?? '').toString().trim();
      if (timedOut && !stderr) {
        stderr = `Setup hook timed out after ${timeoutMs}ms`;
      }

      const stdout = truncate(rawStdout, MAX_RESULT_OUTPUT_BYTES);
      const truncatedStderr = truncate(stderr, MAX_RESULT_OUTPUT_BYTES);

      logger.error(
        {
          job_id: jobContext.job_id,
          timedOut,
          exit_code: exitCode,
          stdout: stdout ? truncate(stdout, 8 * 1024) : '',
          stderr: truncatedStderr ? truncate(truncatedStderr, 8 * 1024) : '',
          err: error,
        },
        'Setup hook failed',
      );

      throw new SetupHookExecutionError({
        message: timedOut ? 'Setup hook timed out' : 'Setup hook exited non-zero',
        stdout,
        stderr: truncatedStderr,
        timedOut,
      });
    }
  }
}
