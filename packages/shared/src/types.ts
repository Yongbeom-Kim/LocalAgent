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
  task_source?: TaskSource;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  submitted_at: string;
  task_source?: TaskSource;
}

export interface MarketplaceConfig {
  url: string;
  plugins: string[];
}

export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  history?: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  session_id: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}

export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  history?: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  enriched_at: string;
  session_id: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}

export interface JobAttempt {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  history?: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
  enriched_at: string;
  session_id: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
}

// --- Task Source ---

export interface LarkTaskSource {
  source: 'lark';
  message_id: string;
}

export type TaskSource = LarkTaskSource;

export function isValidTaskSource(value: unknown): value is TaskSource {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.source === 'lark') {
    return typeof obj.message_id === 'string' && obj.message_id.length > 0;
  }
  return false;
}

export const RESULT_STATUSES = ['success', 'failure'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const MAX_RESULT_OUTPUT_BYTES = 100 * 1024; // 100KB

export interface TaskResultSubmission {
  job_id: string;
  task_id: string;
  task_type: string;
  session_id?: string;
  status: ResultStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  task_source?: TaskSource;
}

export interface TaskResult extends TaskResultSubmission {
  result_id: string;
  completed_at: string;
}
