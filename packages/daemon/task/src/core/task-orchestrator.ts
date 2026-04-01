import { Job, JobAttempt, TaskResultSubmission, TaskExecutorType, createLogger } from '@local-agent/shared';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';
import { TTADKExecutor } from '../adapters/ttadk-executor';
import { TaskExecutor } from '../ports/task-executor';
import { JobEnvironment, ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:orchestrator');

export class TaskOrchestrator {
  constructor(private readonly jobEnv: JobEnvironment) {}

  async handle(job: Job): Promise<TaskResultSubmission> {
    logger.info(
      { job_id: job.job_id, task_id: job.task_id, task_type: job.task_type, executors: job.executors },
      'Processing job',
    );

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

    let lastResult: TaskResultSubmission | null = null;

    for (let i = 0; i < job.executors.length; i++) {
      const pref = job.executors[i];
      const isLast = i === job.executors.length - 1;

      let env: ExecutionEnvironment;
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

      try {
        const executor = this.resolveExecutor(pref.executor);
        const attempt: JobAttempt = {
          job_id: job.job_id,
          task_id: job.task_id,
          task_type: job.task_type,
          payload: job.payload,
          executor: pref.executor,
          executor_model: pref.executor_model,
          submitted_at: job.submitted_at,
          enriched_at: job.enriched_at,
          system_prompt: job.system_prompt,
          marketplaces: job.marketplaces,
        };

        lastResult = await executor.execute(attempt, env);

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
        };

        if (!isLast) {
          logger.warn(
            { job_id: job.job_id, executor: pref.executor, model: pref.executor_model, attempt: i + 1 },
            'Executor threw, trying next preference',
          );
        }
      } finally {
        await this.jobEnv.teardown(env!);
      }
    }

    logger.error({ job_id: job.job_id }, 'All executor preferences exhausted');
    return lastResult!;
  }

  private resolveExecutor(executor: TaskExecutorType): TaskExecutor {
    if (executor === 'claude_code') return new ClaudeCliExecutor();
    if (executor === 'ttadk') return new TTADKExecutor();
    throw new Error(`Unknown executor: ${executor}`);
  }
}
