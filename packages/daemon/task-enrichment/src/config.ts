import { resolve } from 'node:path';
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  loadEnvFromRoot,
  loadSqliteConfig,
  requireEnvValue,
} from '@local-agent/shared';

loadEnvFromRoot();

export interface EnrichmentDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  taskDaemonStatusUrl: string;
  enrichmentConfigDir: string;
  dbPath: string;
  expectedSchemaVersion?: number;
}

const DEFAULT_ENRICHMENT_CONFIG_DIR = resolve(__dirname, '../config');

export function loadEnrichmentDaemonConfig(env: Record<string, string | undefined> = process.env): EnrichmentDaemonConfig {
  const sqliteConfig = loadSqliteConfig(env);

  return {
    apiUrl: requireEnvValue(env, 'API_URL'),
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    taskDaemonStatusUrl: requireEnvValue(env, 'TASK_DAEMON_STATUS_URL'),
    enrichmentConfigDir: env.ENRICHMENT_CONFIG_DIR ?? DEFAULT_ENRICHMENT_CONFIG_DIR,
    dbPath: sqliteConfig.dbPath,
    expectedSchemaVersion: sqliteConfig.expectedSchemaVersion,
  };
}
