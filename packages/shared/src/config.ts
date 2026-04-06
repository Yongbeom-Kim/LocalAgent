import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  DEFAULT_PORT,
  DEFAULT_QUEUE_NAME,
  DEFAULT_LOG_LEVEL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TASK_DAEMON_STATUS_PORT,
} from './constants';

/**
 * Walk up from cwd to find the monorepo root (directory containing rush.json)
 * and load .env from there. Falls back to default dotenv.config() if not found.
 */
export function loadEnvFromRoot(): void {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'rush.json'))) {
      dotenv.config({ path: resolve(dir, '.env') });
      return;
    }
    dir = dirname(dir);
  }
  dotenv.config();
}

loadEnvFromRoot();

export interface ApiConfig {
  port: number;
  rabbitmqUrl: string;
  queueName: string;
  logLevel: string;
}

export interface DaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  statusPort: number;
}

export interface ApiAuthConfig {
  enabled: boolean;
  token?: string;
}

export interface RabbitMqManagementConfig {
  baseUrl: string;
  username: string;
  password: string;
  vhost: string;
  encodedVhost: string;
}

export function requireEnvValue(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export function deriveRabbitMqManagementConfig(rabbitmqUrl: string): RabbitMqManagementConfig {
  let parsed: URL;

  try {
    parsed = new URL(rabbitmqUrl);
  } catch {
    throw new Error('RABBITMQ_URL must be a valid URL for management discovery');
  }

  if (!parsed.username || !parsed.password) {
    throw new Error('RABBITMQ_URL must include username and password for management discovery');
  }

  const host = parsed.hostname;
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
  const vhost = pathname ? decodeURIComponent(pathname.slice(1)) : '/';

  return {
    baseUrl: `http://${host}:15672`,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    vhost,
    encodedVhost: encodeURIComponent(vhost),
  };
}

export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return {
    port: env.PORT ? parseInt(env.PORT, 10) : DEFAULT_PORT,
    rabbitmqUrl: requireEnvValue(env, 'RABBITMQ_URL'),
    queueName: env.QUEUE_NAME ?? DEFAULT_QUEUE_NAME,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  };
}

export function loadDaemonConfig(env: Record<string, string | undefined> = process.env): DaemonConfig {
  return {
    apiUrl: requireEnvValue(env, 'API_URL'),
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    statusPort: env.TASK_DAEMON_STATUS_PORT ? parseInt(env.TASK_DAEMON_STATUS_PORT, 10) : DEFAULT_TASK_DAEMON_STATUS_PORT,
  };
}

export function loadApiAuthConfig(env: Record<string, string | undefined> = process.env): ApiAuthConfig {
  if (env.API_AUTH_DISABLED === '1') {
    return { enabled: false };
  }

  return {
    enabled: true,
    token: requireEnvValue(env, 'API_AUTH_TOKEN'),
  };
}
