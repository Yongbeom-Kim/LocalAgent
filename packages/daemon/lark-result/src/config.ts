import {
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  loadEnvFromRoot,
} from '@local-agent/shared';

loadEnvFromRoot();

export interface LarkDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  larkAppId: string;
  larkAppSecret: string;
  larkRecipientId: string;
}

export function loadLarkDaemonConfig(env: Record<string, string | undefined> = process.env): LarkDaemonConfig {
  return {
    apiUrl: env.API_URL ?? DEFAULT_API_URL,
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    larkAppId: env.LARK_APP_ID ?? '',
    larkAppSecret: env.LARK_APP_SECRET ?? '',
    larkRecipientId: env.LARK_RECIPIENT_ID ?? '',
  };
}
