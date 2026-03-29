import { Job, TaskResultSubmission } from '@local-agent/shared';

export interface TaskExecutor {
  execute(job: Job): Promise<TaskResultSubmission>;
}
