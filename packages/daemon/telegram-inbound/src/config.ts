import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  loadApiAuthConfig,
  loadEnvFromRoot,
  loadSqliteConfig,
  requireEnvValue,
} from '@local-agent/shared';

loadEnvFromRoot();

export interface TelegramDaemonConfig {
  apiUrl: string;
  apiAuthEnabled: boolean;
  apiAuthToken?: string;
  pollIntervalMs: number;
  logLevel: string;
  telegramBotToken: string;
  telegramForumGroupId: string;
  dbPath: string;
  expectedSchemaVersion?: number;
}

export function loadTelegramDaemonConfig(env: Record<string, string | undefined> = process.env): TelegramDaemonConfig {
  const sqliteConfig = loadSqliteConfig(env);
  const apiAuthConfig = loadApiAuthConfig(env);

  return {
    apiUrl: requireEnvValue(env, 'API_URL'),
    apiAuthEnabled: apiAuthConfig.enabled,
    apiAuthToken: apiAuthConfig.enabled ? apiAuthConfig.token : undefined,
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    telegramBotToken: requireEnvValue(env, 'TELEGRAM_BOT_TOKEN'),
    telegramForumGroupId: requireEnvValue(env, 'TELEGRAM_FORUM_GROUP_ID'),
    dbPath: sqliteConfig.dbPath,
    expectedSchemaVersion: sqliteConfig.expectedSchemaVersion,
  };
}
