import { JobAttempt, TaskExecutorType, TaskResultSubmission } from '@local-agent/shared';
import { ExecutionEnvironment } from '../services/job-environment';

export const DEFAULT_KILL_GRACE_PERIOD_MS = 15_000;
export const EXECUTION_KILLED_MESSAGE = 'Execution terminated by /kill';

export type ExecutorKillOutcome = 'terminated_active_process' | 'no_active_process';

export interface ExecutorKillResult {
  status: 'success' | 'failure';
  outcome: ExecutorKillOutcome;
  signalPath: 'none' | 'SIGTERM -> exited' | 'SIGTERM -> SIGKILL';
  waitDurationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecutorActiveSession {
  runId: string;
  sessionId: string;
  executor: TaskExecutorType;
  executorModel: string;
}

export interface TaskExecutorLifecycle {
  onActiveStart(info: ExecutorActiveSession): void;
  onActiveEnd(info: ExecutorActiveSession): void;
}

export interface TaskExecutor {
  execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission>;
  kill(sessionId: string, graceMs: number): Promise<ExecutorKillResult>;
}
