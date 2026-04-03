export const TASK_EXECUTORS = ['claude', 'claude-w', 'builtin', 'cursor', 'ttcodex'] as const;
export const TASK_EXECUTOR_OPTIONS = TASK_EXECUTORS.join(', ');
export type TaskExecutorType = (typeof TASK_EXECUTORS)[number];

export function isTaskExecutorType(value: unknown): value is TaskExecutorType {
  return typeof value === 'string' && TASK_EXECUTORS.includes(value as TaskExecutorType);
}

export const EXECUTOR_MODELS = {
  claude: ['opus', 'sonnet', 'haiku'],
  'claude-w': [
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.2-codex',
    'gpt-5.2',
    'glm-5',
    'glm-4.7',
    'kimi-k2.5',
    'minimax-2.5',
    'minimax-2.7',
  ],
  builtin: ['none'],
  cursor: [
    'auto',
    'composer-2-fast',
    'composer-2',
    'composer-1.5',
    'gpt-5.3-codex-low',
    'gpt-5.3-codex-low-fast',
    'gpt-5.3-codex',
    'gpt-5.3-codex-fast',
    'gpt-5.3-codex-high',
    'gpt-5.3-codex-high-fast',
    'gpt-5.3-codex-xhigh',
    'gpt-5.3-codex-xhigh-fast',
    'gpt-5.2',
    'gpt-5.3-codex-spark-preview-low',
    'gpt-5.3-codex-spark-preview',
    'gpt-5.3-codex-spark-preview-high',
    'gpt-5.3-codex-spark-preview-xhigh',
    'gpt-5.2-codex-low',
    'gpt-5.2-codex-low-fast',
    'gpt-5.2-codex',
    'gpt-5.2-codex-fast',
    'gpt-5.2-codex-high',
    'gpt-5.2-codex-high-fast',
    'gpt-5.2-codex-xhigh',
    'gpt-5.2-codex-xhigh-fast',
    'gpt-5.1-codex-max-low',
    'gpt-5.1-codex-max-low-fast',
    'gpt-5.1-codex-max-medium',
    'gpt-5.1-codex-max-medium-fast',
    'gpt-5.1-codex-max-high',
    'gpt-5.1-codex-max-high-fast',
    'gpt-5.1-codex-max-xhigh',
    'gpt-5.1-codex-max-xhigh-fast',
    'gpt-5.4-high',
    'gpt-5.4-high-fast',
    'gpt-5.4-xhigh-fast',
    'claude-4.6-opus-high-thinking',
    'gpt-5.4-low',
    'gpt-5.4-medium',
    'gpt-5.4-medium-fast',
    'gpt-5.4-xhigh',
    'claude-4.6-sonnet-medium',
    'claude-4.6-sonnet-medium-thinking',
    'claude-4.6-opus-high',
    'claude-4.6-opus-max',
    'claude-4.6-opus-max-thinking',
    'claude-4.5-opus-high',
    'claude-4.5-opus-high-thinking',
    'gpt-5.2-low',
    'gpt-5.2-low-fast',
    'gpt-5.2-fast',
    'gpt-5.2-high',
    'gpt-5.2-high-fast',
    'gpt-5.2-xhigh',
    'gpt-5.2-xhigh-fast',
    'gemini-3.1-pro',
    'gpt-5.4-mini-none',
    'gpt-5.4-mini-low',
    'gpt-5.4-mini-medium',
    'gpt-5.4-mini-high',
    'gpt-5.4-mini-xhigh',
    'gpt-5.4-nano-none',
    'gpt-5.4-nano-low',
    'gpt-5.4-nano-medium',
    'gpt-5.4-nano-high',
    'gpt-5.4-nano-xhigh',
    'grok-4-20',
    'grok-4-20-thinking',
    'claude-4.5-sonnet',
    'claude-4.5-sonnet-thinking',
    'gpt-5.1-low',
    'gpt-5.1',
    'gpt-5.1-high',
    'gemini-3-flash',
    'gpt-5.1-codex-mini-low',
    'gpt-5.1-codex-mini',
    'gpt-5.1-codex-mini-high',
    'claude-4-sonnet',
    'claude-4-sonnet-1m',
    'claude-4-sonnet-thinking',
    'claude-4-sonnet-1m-thinking',
    'gpt-5-mini',
    'kimi-k2.5',
  ],
  ttcodex: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex'],
} as const satisfies Record<TaskExecutorType, readonly string[]>;

export type ExecutorModelType<T extends TaskExecutorType = TaskExecutorType> =
  (typeof EXECUTOR_MODELS)[T][number];

export function isValidExecutorModel(
  executor: TaskExecutorType,
  model: unknown,
): model is ExecutorModelType {
  if (typeof model !== 'string') return false;
  return (EXECUTOR_MODELS[executor] as readonly string[]).includes(model);
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

export const CONTROL_TASK_TYPES = ['new_instance', 'gc', 'cleanup', 'status'] as const;
export type ControlTaskType = (typeof CONTROL_TASK_TYPES)[number];

export function isControlTaskType(value: unknown): value is ControlTaskType {
  return typeof value === 'string' && CONTROL_TASK_TYPES.includes(value as ControlTaskType);
}

export interface TaskSubmission {
  task_type: string;
  payload: string;
  executor?: string;
  executor_model?: string;
  task_source?: TaskSource;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  executor?: string;
  executor_model?: string;
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
  skipContinue?: boolean;
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
  skipContinue?: boolean;
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
  skipContinue?: boolean;
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
  executor?: TaskExecutorType;
  executor_model?: string;
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
