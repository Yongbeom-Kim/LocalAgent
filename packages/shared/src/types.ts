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

export interface TaskContextRef {
  platform: 'lark' | 'telegram';
  root_key: string;
}

export function isValidTaskContextRef(value: unknown): value is TaskContextRef {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    (obj.platform === 'lark' || obj.platform === 'telegram') &&
    isNonEmptyString(obj.root_key)
  );
}

export interface TaskSessionMetadata {
  fallbackSeedText?: string;
  fallbackOrigin?: string;
  fallbackTitleHint?: string;
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
  // Optional explicit execution target.
  session_id?: string;
  session?: TaskSessionMetadata;
  context_ref?: TaskContextRef;
  task_source?: TaskSource;
}

export interface Task {
  task_id: string;
  task_type: string;
  payload: string;
  executor?: string;
  executor_model?: string;
  submitted_at: string;
  session_id?: string;
  context_ref?: TaskContextRef;
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
  context_ref?: TaskContextRef;
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
  context_ref?: TaskContextRef;
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
  context_ref?: TaskContextRef;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
  skipContinue?: boolean;
}

// --- Task Source ---

export interface LarkTaskSource {
  source: 'lark';
  message_id: string;
}

export interface TelegramTopicTaskSource {
  source: 'telegram';
  chat_id: string;
  topic_id: string;
  message_id: string;
}

export interface TelegramChatTaskSource {
  source: 'telegram';
  chat_id: string;
  message_id: string;
}

export type TaskSource = LarkTaskSource | TelegramTopicTaskSource | TelegramChatTaskSource;

export function isValidTelegramTopicTaskSource(value: unknown): value is TelegramTopicTaskSource {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.source === 'telegram' &&
    isNonEmptyString(obj.chat_id) &&
    isNonEmptyString(obj.topic_id) &&
    isNonEmptyString(obj.message_id)
  );
}

export function isValidTelegramChatTaskSource(value: unknown): value is TelegramChatTaskSource {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.source === 'telegram' &&
    isNonEmptyString(obj.chat_id) &&
    !('topic_id' in obj) &&
    isNonEmptyString(obj.message_id)
  );
}

export function isValidTaskSource(value: unknown): value is TaskSource {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.source === 'lark') {
    return isNonEmptyString(obj.message_id);
  }
  if (obj.source === 'telegram') {
    return isValidTelegramTopicTaskSource(value) || isValidTelegramChatTaskSource(value);
  }
  return false;
}

export const TASK_PHASES = ['received', 'enriching', 'queued', 'executing', 'completed'] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

export function isValidTaskPhase(value: unknown): value is TaskPhase {
  return typeof value === 'string' && TASK_PHASES.includes(value as TaskPhase);
}

export function compareTaskPhases(a: TaskPhase, b: TaskPhase): number {
  return TASK_PHASES.indexOf(a) - TASK_PHASES.indexOf(b);
}

export type TaskPhaseEmitter = 'lark-listener' | 'telegram-listener' | 'task-enrichment' | 'task-daemon';

export interface TaskPhaseEventMetadata {
  thread_id?: string;
  emitted_by: TaskPhaseEmitter;
  note?: string;
}

export interface TaskPhaseEventSubmission {
  task_id: string;
  session_id: string;
  context_ref?: TaskContextRef;
  task_type: string;
  phase: TaskPhase;
  task_source?: TaskSource;
  executor?: TaskExecutorType;
  executor_model?: string;
  metadata?: TaskPhaseEventMetadata;
}

export interface TaskPhaseEvent extends TaskPhaseEventSubmission {
  event_kind: 'phase';
  event_id: string;
  emitted_at: string;
}

export const RESULT_STATUSES = ['success', 'failure'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const MAX_RESULT_OUTPUT_BYTES = 100 * 1024; // 100KB

// --- Normalized Lark inbound envelope ---

export const LARK_INBOUND_SCHEMA_VERSION_V1 = 1 as const;
export type LarkInboundSchemaVersion = typeof LARK_INBOUND_SCHEMA_VERSION_V1;
export const TELEGRAM_INBOUND_SCHEMA_VERSION_V1 = 1 as const;
export type TelegramInboundSchemaVersion = typeof TELEGRAM_INBOUND_SCHEMA_VERSION_V1;

export interface LarkMention {
  key: string;
  name: string;
  open_id: string;
}

export type LarkInboundEnvelope =
  | {
      platform: 'lark';
      schema_version: LarkInboundSchemaVersion;
      message_id: string;
      root_message_id: string;
      thread_id?: string | null;
      chat_type: string;
      sender_open_id: string;
      sender_type: string;
      message_type: string;
      raw_content: string;
      mentions: LarkMention[];
      is_normalizable: true;
      normalized_text: string;
      occurred_at_ms: number;
    }
  | {
      platform: 'lark';
      schema_version: LarkInboundSchemaVersion;
      message_id: string;
      root_message_id: string;
      thread_id?: string | null;
      chat_type: string;
      sender_open_id: string;
      sender_type: string;
      message_type: string;
      raw_content: string;
      mentions: LarkMention[];
      is_normalizable: false;
      normalized_text?: undefined;
      occurred_at_ms: number;
    };

export type TelegramInboundEnvelope =
  | {
      platform: 'telegram';
      schema_version: TelegramInboundSchemaVersion;
      chat_id: string;
      topic_id: string;
      message_id: string;
      sender_id: string;
      sender_is_bot: boolean;
      message_type: string;
      raw_content: string;
      is_normalizable: true;
      normalized_text: string;
      occurred_at_ms: number;
    }
  | {
      platform: 'telegram';
      schema_version: TelegramInboundSchemaVersion;
      chat_id: string;
      topic_id: string;
      message_id: string;
      sender_id: string;
      sender_is_bot: boolean;
      message_type: string;
      raw_content: string;
      is_normalizable: false;
      normalized_text?: undefined;
      occurred_at_ms: number;
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isValidLarkInboundEnvelope(value: unknown): value is LarkInboundEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (obj.platform !== 'lark') return false;
  if (obj.schema_version !== LARK_INBOUND_SCHEMA_VERSION_V1) return false;

  if (!isNonEmptyString(obj.message_id)) return false;
  if (!isNonEmptyString(obj.root_message_id)) return false;
  if (!isNonEmptyString(obj.chat_type)) return false;
  if (!isNonEmptyString(obj.sender_open_id)) return false;
  if (!isNonEmptyString(obj.sender_type)) return false;
  if (!isNonEmptyString(obj.message_type)) return false;
  if (typeof obj.raw_content !== 'string') return false;
  if (typeof obj.occurred_at_ms !== 'number' || !Number.isFinite(obj.occurred_at_ms)) return false;

  if ('thread_id' in obj) {
    if (!(typeof obj.thread_id === 'string' || obj.thread_id === null || obj.thread_id === undefined)) {
      return false;
    }
  }

  if (!Array.isArray(obj.mentions)) return false;
  for (const m of obj.mentions) {
    if (typeof m !== 'object' || m === null) return false;
    const mention = m as Record<string, unknown>;
    if (!isNonEmptyString(mention.key)) return false;
    if (!isNonEmptyString(mention.name)) return false;
    if (!isNonEmptyString(mention.open_id)) return false;
  }

  if (obj.is_normalizable === true) {
    return typeof obj.normalized_text === 'string';
  }

  if (obj.is_normalizable === false) {
    return obj.normalized_text === undefined;
  }

  return false;
}

export function isValidTelegramInboundEnvelope(value: unknown): value is TelegramInboundEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (obj.platform !== 'telegram') return false;
  if (obj.schema_version !== TELEGRAM_INBOUND_SCHEMA_VERSION_V1) return false;

  if (!isNonEmptyString(obj.chat_id)) return false;
  if (!isNonEmptyString(obj.topic_id)) return false;
  if (!isNonEmptyString(obj.message_id)) return false;
  if (!isNonEmptyString(obj.sender_id)) return false;
  if (typeof obj.sender_is_bot !== 'boolean') return false;
  if (!isNonEmptyString(obj.message_type)) return false;
  if (typeof obj.raw_content !== 'string') return false;
  if (typeof obj.occurred_at_ms !== 'number' || !Number.isFinite(obj.occurred_at_ms)) return false;

  if (obj.is_normalizable === true) {
    return typeof obj.normalized_text === 'string';
  }

  if (obj.is_normalizable === false) {
    return obj.normalized_text === undefined;
  }

  return false;
}

export interface TaskResultSubmission {
  job_id: string;
  task_id: string;
  task_type: string;
  session_id: string;
  context_ref?: TaskContextRef;
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

export interface TaskResultEvent extends TaskResult {
  event_kind: 'result';
}

export type TaskEvent = TaskResultEvent | TaskPhaseEvent;

export function isValidTaskEvent(value: unknown): value is TaskEvent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (obj.event_kind === 'result') {
    return (
      isNonEmptyString(obj.result_id) &&
      isNonEmptyString(obj.job_id) &&
      isNonEmptyString(obj.task_id) &&
      isNonEmptyString(obj.session_id) &&
      isNonEmptyString(obj.task_type) &&
      RESULT_STATUSES.includes(obj.status as ResultStatus) &&
      (obj.exit_code === null || typeof obj.exit_code === 'number') &&
      typeof obj.stdout === 'string' &&
      typeof obj.stderr === 'string' &&
      isNonEmptyString(obj.completed_at) &&
      (obj.task_source === undefined || isValidTaskSource(obj.task_source))
    );
  }

  if (obj.event_kind === 'phase') {
    return (
      isNonEmptyString(obj.event_id) &&
      isNonEmptyString(obj.task_id) &&
      isNonEmptyString(obj.session_id) &&
      isNonEmptyString(obj.task_type) &&
      isValidTaskPhase(obj.phase) &&
      isNonEmptyString(obj.emitted_at) &&
      (obj.task_source === undefined || isValidTaskSource(obj.task_source))
    );
  }

  return false;
}
