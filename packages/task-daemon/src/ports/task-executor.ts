import { Job, TaskResultSubmission } from '@local-agent/shared';
import { ExecutionEnvironment } from '../services/job-environment';

export interface TaskExecutor {
  execute(job: Job, env: ExecutionEnvironment): Promise<TaskResultSubmission>;
}
