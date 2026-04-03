import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@local-agent/shared';

const execFileAsync = promisify(execFile);
const logger = createLogger('task-daemon:setup-hook-runner');

interface JobContext {
  job_id: string;
  task_id: string;
  task_type: string;
  session_id: string;
  payload: string;
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
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      const stderr = err.stderr ?? '';
      const message = stderr
        ? `Setup hook failed: ${stderr.trim()}`
        : `Setup hook failed: ${err.message}`;

      logger.error({ job_id: jobContext.job_id, err: error }, 'Setup hook failed');
      throw new Error(message);
    }
  }
}
