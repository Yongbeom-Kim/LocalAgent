export const DEFAULT_QUEUE_NAME = 'tasks';
export const DEFAULT_PORT = 3000;
export const DEFAULT_RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';
export const DEFAULT_API_URL = 'http://localhost:3000';
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_LOG_LEVEL = 'info';
export const DEFAULT_RESULTS_EXCHANGE_NAME = 'results';
export const DEFAULT_LARK_QUEUE_NAME = 'lark-messages';
export const DEFAULT_JOBS_QUEUE_NAME = 'jobs';
export const DEFAULT_TELEGRAM_QUEUE_NAME = 'telegram-messages';
export const DEFAULT_SETUP_HOOK_TIMEOUT_MS = 300_000; // 5 minutes
export const SESSION_BASE_DIR = '/var/tmp/local-agent/session';
export const SESSION_DIR_TTL_DAYS = 7;
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 5;
export const DEFAULT_REQUEUE_DELAY_MS = 5000;
export const MAX_SNIPPET_CHARS = 2000;

export const GLOBAL_SYSTEM_PROMPT = `You are running in a non-interactive environment. Any output beyond ${MAX_SNIPPET_CHARS} characters will be truncated. If your response is likely to exceed this limit, create a Lark document with the full content and send the document link to the user instead.`;
