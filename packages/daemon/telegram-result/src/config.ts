import {
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  loadEnvFromRoot,
} from '@local-agent/shared';

loadEnvFromRoot();

export interface TelegramDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  telegramBotToken: string;
  telegramChatId: string;
}

export function loadTelegramDaemonConfig(env: Record<string, string | undefined> = process.env): TelegramDaemonConfig {
  return {
    apiUrl: env.API_URL ?? DEFAULT_API_URL,
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: env.TELEGRAM_CHAT_ID ?? '',
  };
}