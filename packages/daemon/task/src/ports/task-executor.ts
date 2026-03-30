import { JobAttempt, TaskResultSubmission } from '@local-agent/shared';
import { ExecutionEnvironment } from '../services/job-environment';

export interface TaskExecutor {
  execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission>;
}
