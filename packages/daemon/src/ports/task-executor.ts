import { Task } from '@local-agent/shared';

export interface TaskExecutor {
  /**
   * Execute a task. Implementations should handle their own errors internally
   * and resolve on completion so polling can proceed to ACK only after the
   * executor finishes its own logging and cleanup.
   */
  execute(task: Task): Promise<void>;
}
