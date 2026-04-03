import * as fs from 'node:fs';
import { join } from 'node:path';
import { JobAttempt, TaskResultSubmission, createLogger } from '@local-agent/shared';
import { ExecutorKillResult, TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:cleanup-executor');
const DEFAULT_SESSION_BASE_DIR = '/var/tmp/local-agent/session';

type RemoveDirectory = (path: string) => void;
type DirectoryExists = (path: string) => boolean;

export class CleanupExecutor implements TaskExecutor {
  constructor(
    private readonly baseDir: string = DEFAULT_SESSION_BASE_DIR,
    private readonly removeDirectory: RemoveDirectory = (path) => fs.rmSync(path, { recursive: true, force: true }),
    private readonly directoryExists: DirectoryExists = (path) => fs.existsSync(path),
  ) {}

  async execute(job: JobAttempt, _env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    const workDir = join(this.baseDir, job.session_id);

    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type, session_id: job.session_id, workDir }, 'Cleaning up session workspace');

    if (!this.directoryExists(workDir)) {
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        session_id: job.session_id,
        status: 'success',
        exit_code: 0,
        stdout: `Session workspace not found at ${workDir}; nothing to remove`,
        stderr: '',
      };
    }

    try {
      this.removeDirectory(workDir);

      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        session_id: job.session_id,
        status: 'success',
        exit_code: 0,
        stdout: `Removed session workspace at ${workDir}`,
        stderr: '',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      logger.error(
        { job_id: job.job_id, task_id: job.task_id, task_type: job.task_type, session_id: job.session_id, workDir, error: message },
        'Failed to clean up session workspace',
      );

      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        session_id: job.session_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: message,
      };
    }
  }

  async kill(_sessionId: string, _graceMs: number): Promise<ExecutorKillResult> {
    return {
      status: 'success',
      outcome: 'no_active_process',
      signalPath: 'none',
      waitDurationMs: 0,
      exitCode: 0,
      stdout: 'No active process',
      stderr: '',
    };
  }
}
