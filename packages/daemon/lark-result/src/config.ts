import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  loadEnvFromRoot,
  loadSqliteConfig,
  requireEnvValue,
} from '@local-agent/shared';

loadEnvFromRoot();

export interface LarkDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  larkAppId: string;
  larkAppSecret: string;
  larkRecipientId: string;
  dbPath: string;
  expectedSchemaVersion?: number;
}

export function loadLarkDaemonConfig(env: Record<string, string | undefined> = process.env): LarkDaemonConfig {
  const sqliteConfig = loadSqliteConfig(env);

  return {
    apiUrl: requireEnvValue(env, 'API_URL'),
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    larkAppId: requireEnvValue(env, 'LARK_APP_ID'),
    larkAppSecret: requireEnvValue(env, 'LARK_APP_SECRET'),
    larkRecipientId: requireEnvValue(env, 'LARK_RECIPIENT_ID'),
    dbPath: sqliteConfig.dbPath,
    expectedSchemaVersion: sqliteConfig.expectedSchemaVersion,
  };
}
