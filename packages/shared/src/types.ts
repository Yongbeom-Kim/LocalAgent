export const TASK_EXECUTORS = ['claude_code', 'ttadk'] as const;
export const TASK_EXECUTOR_OPTIONS = TASK_EXECUTORS.join(', ');
export type TaskExecutorType = (typeof TASK_EXECUTORS)[number];

export function isTaskExecutorType(value: unknown): value is TaskExecutorType {
  return typeof value === 'string' && TASK_EXECUTORS.includes(value as TaskExecutorType);
}

export const EXECUTOR_MODELS = {
  claude_code: ['opus', 'sonnet', 'haiku'],
  ttadk: ['glm-5-ttadk', 'kimi-k2.5', 'glm-4.7-ttadk', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.2-codex'],
} as const satisfies Record<TaskExecutorType, readonly string[]>;

export type ExecutorModelType<T extends TaskExecutorType = TaskExecutorType> =
  (typeof EXECUTOR_MODELS)[T][number];

export function isValidExecutorModel(
  executor: TaskExecutorType,
  model: unknown,
): model is ExecutorModelType {
  return (
    typeof model === 'string' &&
    (EXECUTOR_MODELS[executor] as readonly string[]).includes(model)
  );
}

export function getExecutorModelOptions(executor: TaskExecutorType): string {
  return EXECUTOR_MODELS[executor].join(', ');
}

export interface ExecutorPreference {
  executor: TaskExecutorType;
  executor_model: string;
}

export function isValidExecutorPreferences(
  executors: unknown,
): executors is ExecutorPreference[] {
  if (!Array.isArray(executors) || executors.length === 0) return false;
  return executors.every(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      isTaskExecutorType((e as Record<string, unknown>).executor) &&
      isValidExecutorModel(
        (e as Record<string, unknown>).executor as TaskExecutorType,
        (e as Record<string, unknown>).executor_model,
      ),
  );
}

export interface TaskSubmission {
  task_type: string;
  payload: string;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  submitted_at: string;
}

export interface MarketplaceConfig {
  url: string;
  plugins: string[];
}

export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  marketplaces?: MarketplaceConfig[];
}

export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  enriched_at: string;
  marketplaces?: MarketplaceConfig[];
}

export interface JobAttempt {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
  enriched_at: string;
  marketplaces?: MarketplaceConfig[];
}

export const RESULT_STATUSES = ['success', 'failure'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const MAX_RESULT_OUTPUT_BYTES = 100 * 1024; // 100KB

export interface TaskResultSubmission {
  job_id: string;
  task_id: string;
  status: ResultStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

export interface TaskResult extends TaskResultSubmission {
  result_id: string;
  completed_at: string;
}
