export const DEFAULT_QUEUE_NAME = 'tasks';
export const DEFAULT_PORT = 3000;
export const DEFAULT_API_URL = 'http://localhost:3000';
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_LOG_LEVEL = 'info';
export const DEFAULT_RESULTS_EXCHANGE_NAME = 'results';
export const DEFAULT_LARK_QUEUE_NAME = 'lark-messages';
export const DEFAULT_JOBS_QUEUE_NAME = 'jobs';
export const DEFAULT_JOBS_EXCHANGE_NAME = DEFAULT_JOBS_QUEUE_NAME;
export const DEFAULT_SESSION_JOBS_QUEUE_PREFIX = 'jobs.session';
export const DEFAULT_IMMEDIATE_JOBS_EXCHANGE_NAME = 'jobs.immediate';
export const DEFAULT_IMMEDIATE_SESSION_JOBS_QUEUE_PREFIX = 'jobs.immediate';
export const DEFAULT_SESSION_QUEUE_IDLE_TTL_MS = 60 * 60 * 1000;
export const IMMEDIATE_SESSION_JOB_TASK_TYPES = ['kill'] as const;
export const DEFAULT_TELEGRAM_QUEUE_NAME = 'telegram-messages';
export const DEFAULT_SETUP_HOOK_TIMEOUT_MS = 300_000; // 5 minutes
export const DEFAULT_KILL_CANCELLATION_GRACE_TIMEOUT_MS = 5_000;
export const SESSION_BASE_DIR = '/var/tmp/local-agent/session';
export const SESSION_DIR_TTL_DAYS = 7;
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 5;
export const DEFAULT_REQUEUE_DELAY_MS = 5000;
export const DEFAULT_TASK_DAEMON_STATUS_PORT = 7070;
export const DEFAULT_TASK_DAEMON_MACHINE_LOCK_PATH = '/var/tmp/local-agent/task-daemon.lock';
export const TASK_DAEMON_MACHINE_LOCK_DISABLE_ENV = 'TASK_DAEMON_DISABLE_MACHINE_LOCK';
export const MAX_SNIPPET_CHARS = 100000;

/** Express `json()` body limit (also headroom for non-result routes). RabbitMQ default max message size is far larger. */
export const MAX_API_JSON_BODY_BYTES = 1024 * 1024;

export const TASK_EVENT_KINDS = ['result', 'phase', 'mirror'] as const;

export const GLOBAL_SYSTEM_PROMPT = `You are running in a non-interactive environment. Any output beyond ${MAX_SNIPPET_CHARS} characters will be truncated. If your response is likely to exceed this limit, create a Lark document with the full content and send the document link to the user instead.`;
