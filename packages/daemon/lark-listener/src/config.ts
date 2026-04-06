import {
  DEFAULT_LOG_LEVEL,
  loadEnvFromRoot,
  loadSqliteConfig,
  requireEnvValue,
} from '@local-agent/shared';
import { DEFAULT_DEDUP_TTL_MS } from './constants';

loadEnvFromRoot();

export interface LarkListenerConfig {
  appId: string;
  appSecret: string;
  apiUrl: string;
  logLevel: string;
  dedupTtlMs: number;
  dbPath: string;
  expectedSchemaVersion?: number;
}

export function loadLarkListenerConfig(
  env: Record<string, string | undefined> = process.env,
): LarkListenerConfig {
  const appId = requireEnvValue(env, 'LARK_APP_ID');
  const appSecret = requireEnvValue(env, 'LARK_APP_SECRET');
  const apiUrl = requireEnvValue(env, 'API_URL');
  const sqliteConfig = loadSqliteConfig(env);

  return {
    appId,
    appSecret,
    apiUrl,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    dedupTtlMs: env.DEDUP_TTL_MS
      ? parseInt(env.DEDUP_TTL_MS, 10)
      : DEFAULT_DEDUP_TTL_MS,
    dbPath: sqliteConfig.dbPath,
    expectedSchemaVersion: sqliteConfig.expectedSchemaVersion,
  };
}
