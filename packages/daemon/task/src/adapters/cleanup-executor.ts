import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  JobAttempt,
  TaskResultSubmission,
  createLogger,
} from '@local-agent/shared';
import { ExecutorPrecheckResult, TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:cleanup-executor');
const DEFAULT_SESSION_BASE_DIR = '/var/tmp/local-agent/session';

type RemoveDirectory = (path: string) => void;
type DirectoryExists = (path: string) => boolean;

export class CleanupExecutor implements TaskExecutor {
  // TODO: DB cleanup ownership across daemons is still architecturally unsatisfying; revisit once canonical session stores are settled.
  constructor(
    private readonly baseDir: string = DEFAULT_SESSION_BASE_DIR,
    private readonly removeDirectory: RemoveDirectory = (path) => fs.rmSync(path, { recursive: true, force: true }),
    private readonly directoryExists: DirectoryExists = (path) => fs.existsSync(path),
  ) {}

  async precheck(_env: ExecutionEnvironment): Promise<ExecutorPrecheckResult> {
    return { ok: true };
  }

  async execute(job: JobAttempt, _env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    const workDir = join(this.baseDir, job.session_id);
    const workspaceExists = this.directoryExists(workDir);
    const successMessage = workspaceExists
      ? `Removed session workspace at ${workDir}`
      : `Session workspace not found at ${workDir}; nothing to remove`;

    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type, session_id: job.session_id, workDir }, 'Cleaning up session workspace');

    try {
      if (workspaceExists) {
        this.removeDirectory(workDir);
      }

      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        session_id: job.session_id,
        status: 'success',
        exit_code: 0,
        stdout: successMessage,
        stderr: '',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      logger.error(
        {
          job_id: job.job_id,
          task_id: job.task_id,
          task_type: job.task_type,
          session_id: job.session_id,
          workDir,
          workspaceExists,
          error: message,
        },
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
}
