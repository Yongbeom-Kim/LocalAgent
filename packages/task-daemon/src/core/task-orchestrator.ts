import { Job, TaskResultSubmission, createLogger } from '@local-agent/shared';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';
import { TTADKExecutor } from '../adapters/ttadk-executor';
import { TaskExecutor } from '../ports/task-executor';
import { JobEnvironment, ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:orchestrator');

export class TaskOrchestrator {
  constructor(private readonly jobEnv: JobEnvironment) {}

  async handle(job: Job): Promise<TaskResultSubmission> {
    logger.info(
      { job_id: job.job_id, task_id: job.task_id, task_type: job.task_type, executor: job.executor },
      'Processing job',
    );

    let env: ExecutionEnvironment;

    try {
      env = await this.jobEnv.setup(job);
    } catch (error) {
      logger.error({ job_id: job.job_id, err: error }, 'Environment setup failed');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: `Environment setup failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      let executor: TaskExecutor;

      if (job.executor === 'claude_code') {
        executor = new ClaudeCliExecutor();
      } else if (job.executor === 'ttadk') {
        executor = new TTADKExecutor();
      } else {
        throw new Error(`Unknown job executor: ${job.executor}`);
      }

      return await executor.execute(job, env);
    } catch (error) {
      logger.error({ job_id: job.job_id, err: error }, 'Job execution failed');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: `Job execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      await this.jobEnv.teardown(env!);
    }
  }
}
