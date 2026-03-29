import { describe, it, expect } from 'vitest';
import { loadApiConfig, loadDaemonConfig, loadLarkDaemonConfig } from '../config';

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

describe('loadLarkDaemonConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadLarkDaemonConfig({});
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
    expect(config.larkAppId).toBe('');
    expect(config.larkAppSecret).toBe('');
    expect(config.larkRecipientId).toBe('');
  });

  it('reads from env vars', () => {
    const config = loadLarkDaemonConfig({
      API_URL: 'http://other:4000',
      POLL_INTERVAL_MS: '2000',
      LOG_LEVEL: 'debug',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      LARK_RECIPIENT_ID: 'user789',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.logLevel).toBe('debug');
    expect(config.larkAppId).toBe('app123');
    expect(config.larkAppSecret).toBe('secret456');
    expect(config.larkRecipientId).toBe('user789');
  });
});
