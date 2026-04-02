import { Job, JobAttempt, TaskResultSubmission, TaskExecutorType, createLogger } from '@local-agent/shared';
import { ClaudeExecutor } from '../adapters/claude-executor';
import { CleanupExecutor } from '../adapters/cleanup-executor';
import { ClaudeWExecutor } from '../adapters/claude-w-executor';
import { CursorExecutor } from '../adapters/cursor-executor';
import { TaskExecutor } from '../ports/task-executor';
import { GcExecutor } from '../services/gc-executor';
import { JobEnvironment, ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:orchestrator');
const NEW_INSTANCE_MAX_RETRIES = 3;
const EMPTY_EXECUTION_ENVIRONMENT: ExecutionEnvironment = {
  workDir: '',
  pluginDirs: [],
  isExistingWorkspace: false,
};

export class TaskOrchestrator {
  constructor(private readonly jobEnv: JobEnvironment) {}

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

  private resolveExecutor(executor: TaskExecutorType): TaskExecutor {
    if (executor === 'claude') return new ClaudeExecutor();
    if (executor === 'claude-w') return new ClaudeWExecutor();
    if (executor === 'builtin') return new CleanupExecutor();
    if (executor === 'cursor') return new CursorExecutor();
    throw new Error(`Unknown executor: ${executor}`);
  }
}
