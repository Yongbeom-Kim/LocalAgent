import { Task, TaskResultSubmission, createLogger } from '@local-agent/shared';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';
import { TTADKExecutor } from '../adapters/ttadk-executor';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('task-daemon:orchestrator');

export class TaskOrchestrator {
  async handle(task: Task): Promise<TaskResultSubmission> {
    logger.info(
      { task_id: task.task_id, task_type: task.task_type, executor: task.executor },
      'Processing task',
    );

    let executor: TaskExecutor;

    if (task.executor === 'claude_code') {
      executor = new ClaudeCliExecutor();
    } else if (task.executor === 'ttadk') {
      executor = new TTADKExecutor();
    } else {
      logger.error({ task_id: task.task_id, executor: task.executor }, 'Unknown task executor — refusing to ack');
      throw new Error(`Unknown task executor: ${task.executor}`);
    }

    return executor.execute(task);
  }
}
