import {
  DEFAULT_LOG_LEVEL,
  loadEnvFromRoot,
  loadSqliteConfig,
  requireEnvValue,
  type SqliteConfig,
} from '@local-agent/shared';
import { DEFAULT_DEDUP_TTL_MS } from './constants';

loadEnvFromRoot();

export interface LarkListenerConfig extends SqliteConfig {
  appId: string;
  appSecret: string;
  apiUrl: string;
  logLevel: string;
  dedupTtlMs: number;
}

export function loadLarkListenerConfig(
  env: Record<string, string | undefined> = process.env,
): LarkListenerConfig {
  const sqlite = loadSqliteConfig(env);

  return {
    ...sqlite,
    appId: requireEnvValue(env, 'LARK_APP_ID'),
    appSecret: requireEnvValue(env, 'LARK_APP_SECRET'),
    apiUrl: requireEnvValue(env, 'API_URL'),
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    dedupTtlMs: env.DEDUP_TTL_MS
      ? parseInt(env.DEDUP_TTL_MS, 10)
      : DEFAULT_DEDUP_TTL_MS,
  };
}
