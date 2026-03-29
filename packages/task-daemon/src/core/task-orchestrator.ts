import { Job, TaskResultSubmission, createLogger } from '@local-agent/shared';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';
import { TTADKExecutor } from '../adapters/ttadk-executor';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('task-daemon:orchestrator');

export class TaskOrchestrator {
  async handle(job: Job): Promise<TaskResultSubmission> {
    logger.info(
      { job_id: job.job_id, task_id: job.task_id, task_type: job.task_type, executor: job.executor },
      'Processing job',
    );

    let executor: TaskExecutor;

    if (job.executor === 'claude_code') {
      executor = new ClaudeCliExecutor();
    } else if (job.executor === 'ttadk') {
      executor = new TTADKExecutor();
    } else {
      logger.error({ job_id: job.job_id, executor: job.executor }, 'Unknown job executor — refusing to ack');
      throw new Error(`Unknown job executor: ${job.executor}`);
    }

    return executor.execute(job);
  }
}
