import dotenv from 'dotenv';
import {
  DEFAULT_PORT,
  DEFAULT_RABBITMQ_URL,
  DEFAULT_QUEUE_NAME,
  DEFAULT_LOG_LEVEL,
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
} from './constants';

dotenv.config();

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
}

export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return {
    port: env.PORT ? parseInt(env.PORT, 10) : DEFAULT_PORT,
    rabbitmqUrl: env.RABBITMQ_URL ?? DEFAULT_RABBITMQ_URL,
    queueName: env.QUEUE_NAME ?? DEFAULT_QUEUE_NAME,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  };
}

export function loadDaemonConfig(env: Record<string, string | undefined> = process.env): DaemonConfig {
  return {
    apiUrl: env.API_URL ?? DEFAULT_API_URL,
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  };
}

export interface LarkDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  larkAppId: string;
  larkAppSecret: string;
  larkRecipientId: string;
}

export function loadLarkDaemonConfig(env: Record<string, string | undefined> = process.env): LarkDaemonConfig {
  return {
    apiUrl: env.API_URL ?? DEFAULT_API_URL,
    pollIntervalMs: env.POLL_INTERVAL_MS ? parseInt(env.POLL_INTERVAL_MS, 10) : DEFAULT_POLL_INTERVAL_MS,
    logLevel: env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    larkAppId: env.LARK_APP_ID ?? '',
    larkAppSecret: env.LARK_APP_SECRET ?? '',
    larkRecipientId: env.LARK_RECIPIENT_ID ?? '',
  };
}
