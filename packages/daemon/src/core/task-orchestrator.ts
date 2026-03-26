import { Task, createLogger } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';

const logger = createLogger('daemon:orchestrator');

export class TaskOrchestrator {
  constructor(private readonly executor: TaskExecutor) {}

  async handle(task: Task): Promise<void> {
    logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Processing task');
    await this.executor.execute(task);
  }
}
