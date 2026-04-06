import { JobAttempt, TaskResultSubmission } from '@local-agent/shared';
import { ExecutionEnvironment } from '../services/job-environment';

export type ExecutorPrecheckResult =
  | { ok: true }
  | { ok: false; stderr: string };

export interface TaskExecutor {
  precheck(env: ExecutionEnvironment): Promise<ExecutorPrecheckResult>;
  execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission>;
}
