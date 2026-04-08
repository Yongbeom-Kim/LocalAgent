import { resolve } from 'node:path';
import {
  DEFAULT_LOG_LEVEL,
  loadApiAuthConfig,
  loadEnvFromRoot,
  requireEnvValue,
} from '@local-agent/shared';

loadEnvFromRoot();

export interface SchedulerConfig {
  apiUrl: string;
  apiAuthEnabled: boolean;
  apiAuthToken?: string;
  scheduleConfigDir: string;
  crontabPath: string;
  configSnapshotPath: string;
  distEntryPath: string;
  logLevel: string;
}

const DEFAULT_SCHEDULE_CONFIG_DIR = resolve(__dirname, '../config');
const DEFAULT_ARTIFACTS_DIR = resolve(__dirname, '../artifacts');

export function loadSchedulerConfig(env: Record<string, string | undefined> = process.env): SchedulerConfig {
  const apiAuthConfig = loadApiAuthConfig(env);
  const artifactsDir = env.SCHEDULER_ARTIFACTS_DIR ?? DEFAULT_ARTIFACTS_DIR;

  return {
    apiUrl: requireEnvValue(env, 'API_URL'),
    apiAuthEnabled: apiAuthConfig.enabled,
    apiAuthToken: apiAuthConfig.enabled ? apiAuthConfig.token : undefined,
    scheduleConfigDir: env.SCHEDULER_CONFIG_DIR ?? DEFAULT_SCHEDULE_CONFIG_DIR,
    crontabPath: env.SCHEDULER_CRONTAB_PATH ?? resolve(artifactsDir, 'scheduler.crontab'),
    configSnapshotPath: env.SCHEDULER_CONFIG_SNAPSHOT_PATH ?? resolve(artifactsDir, 'config.snapshot.json'),
    distEntryPath: env.SCHEDULER_DIST_ENTRY_PATH ?? 'dist/index.js',
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  };
}
