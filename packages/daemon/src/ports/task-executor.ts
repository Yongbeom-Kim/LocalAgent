import { Task } from '@local-agent/shared';

export interface TaskExecutor {
  /**
   * Execute a task. Implementations should handle their own errors internally
   * and resolve on completion. Rejections will propagate to the caller.
   */
  execute(task: Task): Promise<void>;
}
