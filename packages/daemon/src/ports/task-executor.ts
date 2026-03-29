import { Task, TaskResultSubmission } from '@local-agent/shared';

export interface TaskExecutor {
  execute(task: Task): Promise<TaskResultSubmission>;
}
