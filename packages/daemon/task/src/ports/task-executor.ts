import { JobAttempt, TaskResultSubmission } from '@local-agent/shared';
import { ExecutionEnvironment } from '../services/job-environment';
import { RunningJobRegistration } from '../services/cancellation-registry';

export interface TaskExecutionHooks {
  runningJob?: RunningJobRegistration;
}

export type ExecutorPrecheckResult =
  | { ok: true }
  | { ok: false; stderr: string };

export interface TaskExecutor {
  precheck(env: ExecutionEnvironment): Promise<ExecutorPrecheckResult>;
  execute(job: JobAttempt, env: ExecutionEnvironment, hooks?: TaskExecutionHooks): Promise<TaskResultSubmission>;
}
