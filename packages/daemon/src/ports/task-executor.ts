import { Task } from '@local-agent/shared';

export interface TaskExecutor {
  execute(task: Task): Promise<void>;
}
