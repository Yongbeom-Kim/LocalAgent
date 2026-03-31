import { resolve } from 'node:path';
import {
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  loadEnvFromRoot,
} from '@local-agent/shared';

loadEnvFromRoot();

export interface EnrichmentDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  enrichmentConfigPath: string;
  larkAppId?: string;
  larkAppSecret?: string;
}

const DEFAULT_ENRICHMENT_CONFIG_PATH = resolve(__dirname, '../config/enrichment.yaml');

export function loadEnrichmentDaemonConfig(env: Record<string, string | undefined> = process.env): EnrichmentDaemonConfig {
  return {
    apiUrl: env.API_URL ?? DEFAULT_API_URL,
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    enrichmentConfigPath: env.ENRICHMENT_CONFIG_PATH ?? DEFAULT_ENRICHMENT_CONFIG_PATH,
    larkAppId: env.LARK_APP_ID,
    larkAppSecret: env.LARK_APP_SECRET,
  };
}
