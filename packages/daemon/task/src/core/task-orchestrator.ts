import { Job, JobAttempt, TaskResultSubmission, TaskExecutorType, createLogger } from '@local-agent/shared';
import { ClaudeExecutor } from '../adapters/claude-executor';
import { CleanupExecutor } from '../adapters/cleanup-executor';
import { ClaudeWExecutor } from '../adapters/claude-w-executor';
import { CursorExecutor } from '../adapters/cursor-executor';
import { TTCodexExecutor } from '../adapters/ttcodex-executor';
import { TaskExecutor } from '../ports/task-executor';
import { GcExecutor } from '../services/gc-executor';
import { JobEnvironment, ExecutionEnvironment } from '../services/job-environment';
import { SetupHookExecutionError } from '../services/setup-hook-runner';

const logger = createLogger('task-daemon:orchestrator');
const NEW_INSTANCE_MAX_RETRIES = 3;
const EMPTY_EXECUTION_ENVIRONMENT: ExecutionEnvironment = {
  workDir: '',
  pluginDirs: [],
  isExistingWorkspace: false,
};

export class TaskOrchestrator {
  private readonly executors: Record<TaskExecutorType, TaskExecutor>;

  constructor(private readonly jobEnv: JobEnvironment) {
    this.executors = {
      claude: new ClaudeExecutor(),
      'claude-w': new ClaudeWExecutor(),
      builtin: new CleanupExecutor(),
      cursor: new CursorExecutor(),
      ttcodex: new TTCodexExecutor(),
    };
  }

  async handle(job: Job): Promise<TaskResultSubmission> {
    logger.info(
      { job_id: job.job_id, task_id: job.task_id, task_type: job.task_type, executors: job.executors },
      'Processing job',
    );

    if (job.task_type === 'gc') {
      logger.info({ job_id: job.job_id, task_id: job.task_id }, 'Processing gc job');
      const gcExecutor = new GcExecutor();
      return gcExecutor.execute(job);
    }

    if (job.executors.length === 0) {
      logger.error({ job_id: job.job_id }, 'Job has empty executors array');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Job has no executor preferences',
      };
    }

    const isCleanupTask = job.task_type === 'cleanup';

    let env: ExecutionEnvironment;
    if (isCleanupTask) {
      env = EMPTY_EXECUTION_ENVIRONMENT;
    } else {
      try {
        env = await this.jobEnv.setup(job);
      } catch (error) {
        if (error instanceof SetupHookExecutionError) {
          logger.error({ job_id: job.job_id, err: error }, 'Setup hook failed');
          return {
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            status: 'failure',
            exit_code: error.exit_code,
            stdout: error.stdout,
            stderr: error.stderr,
          };
        }

        logger.error({ job_id: job.job_id, err: error }, 'Environment setup failed');
        return {
          job_id: job.job_id,
          task_id: job.task_id,
          task_type: job.task_type,
          status: 'failure',
          exit_code: null,
          stdout: '',
          stderr: `Environment setup failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    const isNewInstance = job.task_type === 'new_instance' || job.skipContinue;
    const maxAttempts = isNewInstance ? NEW_INSTANCE_MAX_RETRIES : 1;

    let lastResult: TaskResultSubmission | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        logger.warn({ job_id: job.job_id, attempt }, 'Retrying new_instance execution');
      }

      lastResult = await this.runExecutors(job, env);

      if (lastResult.status === 'success') {
        return lastResult;
      }

      if (attempt < maxAttempts) {
        logger.warn({ job_id: job.job_id, attempt }, 'new_instance attempt failed, will retry');
      }
    }

    logger.error({ job_id: job.job_id }, 'All executor preferences exhausted');
    return lastResult!;
  }

  private async runExecutors(job: Job, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    let lastResult: TaskResultSubmission | null = null;

    for (let i = 0; i < job.executors.length; i++) {
      const pref = job.executors[i];
      const isLast = i === job.executors.length - 1;

      try {
        const executor = this.resolveExecutor(pref.executor);
        const precheckResult = await this.runPrecheck(executor, pref.executor, pref.executor_model, env);

        if (!precheckResult.ok) {
          lastResult = {
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            session_id: job.session_id,
            status: 'failure',
            exit_code: null,
            stdout: '',
            stderr: precheckResult.stderr,
            executor: pref.executor,
            executor_model: pref.executor_model,
          };

          if (!isLast) {
            logger.warn(
              { job_id: job.job_id, executor: pref.executor, model: pref.executor_model, attempt: i + 1 },
              'Executor failed, trying next preference',
            );
          }

          continue;
        }

        const attempt: JobAttempt = {
          job_id: job.job_id,
          task_id: job.task_id,
          session_id: job.session_id,
          task_type: job.task_type,
          payload: job.payload,
          history: job.history,
          executor: pref.executor,
          executor_model: pref.executor_model,
          submitted_at: job.submitted_at,
          enriched_at: job.enriched_at,
          system_prompt: job.system_prompt,
          marketplaces: job.marketplaces,
          skipContinue: job.skipContinue,
        };

        const executorResult = await executor.execute(attempt, env);
        lastResult = {
          ...executorResult,
          executor: pref.executor,
          executor_model: pref.executor_model,
        };

        if (lastResult.status === 'success') {
          return lastResult;
        }

        if (!isLast) {
          logger.warn(
            { job_id: job.job_id, executor: pref.executor, model: pref.executor_model, attempt: i + 1 },
            'Executor failed, trying next preference',
          );
        }
      } catch (error) {
        logger.error({ job_id: job.job_id, err: error }, 'Job execution failed');
        lastResult = {
          job_id: job.job_id,
          task_id: job.task_id,
          task_type: job.task_type,
          status: 'failure',
          exit_code: null,
          stdout: '',
          stderr: `Job execution failed: ${error instanceof Error ? error.message : String(error)}`,
          executor: pref.executor,
          executor_model: pref.executor_model,
        };

        if (!isLast) {
          logger.warn(
            { job_id: job.job_id, executor: pref.executor, model: pref.executor_model, attempt: i + 1 },
            'Executor threw, trying next preference',
          );
        }
      }
    }

    return lastResult!;
  }

  private async runPrecheck(
    executor: TaskExecutor,
    executorName: TaskExecutorType,
    executorModel: string,
    env: ExecutionEnvironment,
  ) {
    try {
      const result = await executor.precheck(env);
      if (!result.ok) {
        logger.warn(
          { executor: executorName, model: executorModel, stderr: result.stderr },
          'Executor precheck failed, trying next preference',
        );
      }
      return result;
    } catch (error) {
      const stderr = `Executor "${executorName}" precheck threw: ${error instanceof Error ? error.message : String(error)}`;
      logger.warn(
        { executor: executorName, model: executorModel, stderr },
        'Executor precheck failed, trying next preference',
      );
      return { ok: false as const, stderr };
    }
  }

  private resolveExecutor(executor: TaskExecutorType): TaskExecutor {
    const resolved = this.executors[executor];
    if (!resolved) {
      throw new Error(`Unknown executor: ${executor}`);
    }
    return resolved;
  }
}
