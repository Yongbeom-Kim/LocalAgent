import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  JobAttempt,
  TaskResultSubmission,
  createLogger,
  parseCleanupPayload,
} from '@local-agent/shared';
import { ExecutorPrecheckResult, TaskExecutor } from '../ports/task-executor';
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

  async precheck(_env: ExecutionEnvironment): Promise<ExecutorPrecheckResult> {
    return { ok: true };
  }

  async execute(job: JobAttempt, _env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    const cleanupPayload = parseCleanupPayload(job.payload, job.session_id);
    if (cleanupPayload.kind === 'invalid') {
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        session_id: job.session_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: cleanupPayload.reason,
      };
    }

    const workspaces = cleanupPayload.sessionIds.map((sessionId) => ({
      sessionId,
      workDir: join(this.baseDir, sessionId),
    }));

    logger.info(
      {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        session_id: job.session_id,
        cleanup_session_ids: cleanupPayload.sessionIds,
      },
      'Cleaning up session workspace subtree',
    );

    try {
      const removed: string[] = [];
      const missing: string[] = [];

      for (const workspace of workspaces) {
        if (this.directoryExists(workspace.workDir)) {
          this.removeDirectory(workspace.workDir);
          removed.push(workspace.workDir);
        } else {
          missing.push(workspace.workDir);
        }
      }

      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        session_id: job.session_id,
        status: 'success',
        exit_code: 0,
        stdout: this.formatSuccessMessage(cleanupPayload.sessionIds.length, removed, missing),
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
          cleanup_session_ids: cleanupPayload.sessionIds,
          error: message,
        },
        'Failed to clean up session workspace subtree',
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

  private formatSuccessMessage(sessionCount: number, removed: string[], missing: string[]): string {
    if (sessionCount === 1) {
      if (removed.length === 1) {
        return `Removed session workspace at ${removed[0]}`;
      }

      return `Session workspace not found at ${missing[0]}; nothing to remove`;
    }

    return [
      `Cleanup removed ${removed.length} of ${sessionCount} session workspace(s).`,
      ...(removed.length > 0 ? [`Removed: ${removed.join(', ')}`] : []),
      ...(missing.length > 0 ? [`Missing: ${missing.join(', ')}`] : []),
    ].join(' ');
  }
}
