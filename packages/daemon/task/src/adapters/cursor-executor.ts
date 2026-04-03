import { spawn } from 'node:child_process';
import { JobAttempt, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import {
  EXECUTION_KILLED_MESSAGE,
  ExecutorActiveSession,
  ExecutorKillResult,
  TaskExecutor,
  TaskExecutorLifecycle,
} from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';
import { killProcessTree } from '../services/killable-process';
import { OutputCapture } from '../services/output-capture';

const logger = createLogger('task-daemon:cursor');

const NOOP_LIFECYCLE: TaskExecutorLifecycle = {
  onActiveStart: () => {},
  onActiveEnd: () => {},
};

interface ActiveRun {
  info: ExecutorActiveSession;
  child: ReturnType<typeof spawn>;
  stdout: OutputCapture;
  stderr: OutputCapture;
  terminatedByKill: boolean;
}

export class CursorExecutor implements TaskExecutor {
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(private readonly lifecycle: TaskExecutorLifecycle = NOOP_LIFECYCLE) {}

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

      if (continueResult.stderr === EXECUTION_KILLED_MESSAGE) {
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

  async kill(sessionId: string, graceMs: number): Promise<ExecutorKillResult> {
    const activeRun = this.activeRuns.get(sessionId);
    if (!activeRun) {
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

    activeRun.terminatedByKill = true;

    return killProcessTree({
      child: activeRun.child,
      graceMs,
      getStdout: () => activeRun.stdout.read(),
      getStderr: () => activeRun.stderr.read(),
    });
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
      const stdout = new OutputCapture();
      const stderr = new OutputCapture();
      const activeRun = this.registerActiveRun(job, child, stdout, stderr);

      child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk));

      child.on('close', (code) => {
        this.clearActiveRun(activeRun.info);
        const resolvedStdout = stdout.read();
        const resolvedStderr = stderr.read();

        if (code !== 0) {
          if (activeRun.terminatedByKill) {
            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              task_type: job.task_type,
              status: 'failure',
              exit_code: null,
              stdout: truncate(resolvedStdout, MAX_RESULT_OUTPUT_BYTES),
              stderr: EXECUTION_KILLED_MESSAGE,
            });
            return;
          }

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
        this.clearActiveRun(activeRun.info);
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

  private registerActiveRun(job: JobAttempt, child: ReturnType<typeof spawn>, stdout: OutputCapture, stderr: OutputCapture): ActiveRun {
    const info: ExecutorActiveSession = {
      runId: `${job.job_id}:${job.task_id}:${job.executor}:${Date.now()}:${Math.random()}`,
      sessionId: job.session_id,
      executor: job.executor,
      executorModel: job.executor_model,
    };
    const activeRun: ActiveRun = { info, child, stdout, stderr, terminatedByKill: false };
    this.activeRuns.set(job.session_id, activeRun);
    this.lifecycle.onActiveStart(info);
    return activeRun;
  }

  private clearActiveRun(info: ExecutorActiveSession): void {
    const current = this.activeRuns.get(info.sessionId);
    if (current?.info.runId !== info.runId) {
      return;
    }
    this.activeRuns.delete(info.sessionId);
    this.lifecycle.onActiveEnd(info);
  }
}
