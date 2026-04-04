import { loadSqliteConfig } from '@local-agent/shared';

export interface MigratorConfig {
  dbPath: string;
}

export function loadMigratorConfig(env: Record<string, string | undefined> = process.env): MigratorConfig {
  const { dbPath } = loadSqliteConfig(env);
  return { dbPath };
}

