import { resolve } from 'node:path';
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  loadApiAuthConfig,
  loadEnvFromRoot,
  requireEnvValue,
} from '@local-agent/shared';

loadEnvFromRoot();

export interface EnrichmentDaemonConfig {
  apiUrl: string;
  apiAuthEnabled: boolean;
  apiAuthToken?: string;
  pollIntervalMs: number;
  logLevel: string;
  taskDaemonStatusUrl: string;
  enrichmentConfigDir: string;
  dbPath: string;
  expectedSchemaVersion?: number;
}

const DEFAULT_ENRICHMENT_CONFIG_DIR = resolve(__dirname, '../config');
const SCHEMA_VERSION_ERROR = 'LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION must be a non-negative integer when provided';

function loadSqliteDaemonConfig(env: Record<string, string | undefined>): {
  dbPath: string;
  expectedSchemaVersion?: number;
} {
  const dbPath = requireEnvValue(env, 'LOCAL_AGENT_DB_PATH');
  const expectedSchemaVersionRaw = env.LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION?.trim();

  if (!expectedSchemaVersionRaw) {
    return { dbPath, expectedSchemaVersion: undefined };
  }

  const expectedSchemaVersion = Number(expectedSchemaVersionRaw);
  if (!Number.isInteger(expectedSchemaVersion) || expectedSchemaVersion < 0) {
    throw new Error(SCHEMA_VERSION_ERROR);
  }

  return { dbPath, expectedSchemaVersion };
}

export function loadEnrichmentDaemonConfig(env: Record<string, string | undefined> = process.env): EnrichmentDaemonConfig {
  const apiAuthConfig = loadApiAuthConfig(env);
  const sqliteConfig = loadSqliteDaemonConfig(env);

  return {
    apiUrl: requireEnvValue(env, 'API_URL'),
    apiAuthEnabled: apiAuthConfig.enabled,
    apiAuthToken: apiAuthConfig.enabled ? apiAuthConfig.token : undefined,
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    taskDaemonStatusUrl: requireEnvValue(env, 'TASK_DAEMON_STATUS_URL'),
    enrichmentConfigDir: env.ENRICHMENT_CONFIG_DIR ?? DEFAULT_ENRICHMENT_CONFIG_DIR,
    dbPath: sqliteConfig.dbPath,
    expectedSchemaVersion: sqliteConfig.expectedSchemaVersion,
  };
}
