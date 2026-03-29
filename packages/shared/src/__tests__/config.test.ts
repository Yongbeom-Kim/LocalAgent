import { describe, it, expect } from 'vitest';
import { loadApiConfig, loadDaemonConfig } from '../config';

describe('loadApiConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadApiConfig({});
    expect(config.port).toBe(3000);
    expect(config.rabbitmqUrl).toBe('amqp://guest:guest@localhost:5672');
    expect(config.queueName).toBe('tasks');
    expect(config.logLevel).toBe('info');
  });

  it('reads from env vars', () => {
    const config = loadApiConfig({
      PORT: '4000',
      RABBITMQ_URL: 'amqp://other:5672',
      QUEUE_NAME: 'jobs',
      LOG_LEVEL: 'debug',
    });
    expect(config.port).toBe(4000);
    expect(config.rabbitmqUrl).toBe('amqp://other:5672');
    expect(config.queueName).toBe('jobs');
    expect(config.logLevel).toBe('debug');
  });
});

describe('loadDaemonConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadDaemonConfig({});
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
  });

  it('reads from env vars', () => {
    const config = loadDaemonConfig({
      API_URL: 'http://other:4000',
      POLL_INTERVAL_MS: '1000',
      LOG_LEVEL: 'warn',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.pollIntervalMs).toBe(1000);
    expect(config.logLevel).toBe('warn');
  });
});
