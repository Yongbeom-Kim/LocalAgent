import { Task, createLogger } from '@local-agent/shared';

const logger = createLogger('daemon:handler');

export async function handleTask(task: Task): Promise<void> {
  logger.info({ task_id: task.task_id, task_type: task.task_type, payload: task.payload }, 'Processing task');
}
