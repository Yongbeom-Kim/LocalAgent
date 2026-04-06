import {
  DEFAULT_LOG_LEVEL,
  loadApiAuthConfig,
  loadEnvFromRoot,
  requireEnvValue,
} from '@local-agent/shared';
import { DEFAULT_DEDUP_TTL_MS } from './constants';

loadEnvFromRoot();

export interface LarkListenerConfig {
  appId: string;
  appSecret: string;
  apiUrl: string;
  apiAuthEnabled: boolean;
  apiAuthToken?: string;
  logLevel: string;
  dedupTtlMs: number;
}

export function loadLarkListenerConfig(
  env: Record<string, string | undefined> = process.env,
): LarkListenerConfig {
  const apiAuthConfig = loadApiAuthConfig(env);

  return {
    appId: requireEnvValue(env, 'LARK_APP_ID'),
    appSecret: requireEnvValue(env, 'LARK_APP_SECRET'),
    apiUrl: requireEnvValue(env, 'API_URL'),
    apiAuthEnabled: apiAuthConfig.enabled,
    apiAuthToken: apiAuthConfig.enabled ? apiAuthConfig.token : undefined,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    dedupTtlMs: env.DEDUP_TTL_MS
      ? parseInt(env.DEDUP_TTL_MS, 10)
      : DEFAULT_DEDUP_TTL_MS,
  };
}
