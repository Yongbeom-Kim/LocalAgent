import { requireEnvValue } from '../config';
import type { SqliteConfig } from './types';

const SCHEMA_VERSION_ERROR = 'LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION must be a non-negative integer when provided';

export function loadSqliteConfig(env: Record<string, string | undefined> = process.env): SqliteConfig {
  const dbPath = requireEnvValue(env, 'LOCAL_AGENT_DB_PATH');
  const expectedSchemaVersionRaw = env.LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION?.trim();

  if (!expectedSchemaVersionRaw) {
    return { dbPath, expectedSchemaVersion: undefined };
  }

  const expectedSchemaVersion = Number(expectedSchemaVersionRaw);
  if (!Number.isInteger(expectedSchemaVersion) || expectedSchemaVersion < 0) {
    throw new Error(SCHEMA_VERSION_ERROR);
  }

  return {
    dbPath,
    expectedSchemaVersion,
  };
}

