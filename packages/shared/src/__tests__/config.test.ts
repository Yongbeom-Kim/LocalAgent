import { describe, it, expect } from 'vitest';
import { deriveRabbitMqManagementConfig, loadApiConfig, loadDaemonConfig } from '../config';

describe('loadApiConfig', () => {
  it('returns defaults when required env vars are set', () => {
    const config = loadApiConfig({
      RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
    });
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

  it('throws when RABBITMQ_URL is missing', () => {
    expect(() => loadApiConfig({})).toThrow('RABBITMQ_URL is required');
  });
});

describe('loadDaemonConfig', () => {
  it('returns defaults when required env vars are set', () => {
    const config = loadDaemonConfig({
      API_URL: 'http://localhost:3000',
    });
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
    expect(config.statusPort).toBe(7070);
    expect(config.shellCommandDisabled).toBe(false);
  });

  it('reads from env vars', () => {
    const config = loadDaemonConfig({
      API_URL: 'http://other:4000',
      POLL_INTERVAL_MS: '1000',
      LOG_LEVEL: 'warn',
      TASK_DAEMON_STATUS_PORT: '7171',
      LOCAL_AGENT_DISABLE_SHELL_COMMAND: '1',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.pollIntervalMs).toBe(1000);
    expect(config.logLevel).toBe('warn');
    expect(config.statusPort).toBe(7171);
    expect(config.shellCommandDisabled).toBe(true);
  });

  it('throws when API_URL is missing', () => {
    expect(() => loadDaemonConfig({})).toThrow('API_URL is required');
  });
});

describe('deriveRabbitMqManagementConfig', () => {
  it('derives management config from a standard amqp URL', () => {
    const config = deriveRabbitMqManagementConfig('amqp://guest:guest@rabbitmq:5672');
    expect(config).toEqual({
      baseUrl: 'http://rabbitmq:15672',
      username: 'guest',
      password: 'guest',
      vhost: '/',
      encodedVhost: '%2F',
    });
  });

  it('treats an explicit trailing slash as the default vhost', () => {
    const config = deriveRabbitMqManagementConfig('amqp://guest:guest@rabbitmq:5672/');
    expect(config.vhost).toBe('/');
    expect(config.encodedVhost).toBe('%2F');
  });

  it('derives encoded vhost when the URL includes a vhost path', () => {
    const config = deriveRabbitMqManagementConfig('amqp://guest:guest@rabbitmq:5672/my-vhost');
    expect(config.vhost).toBe('my-vhost');
    expect(config.encodedVhost).toBe('my-vhost');
  });

  it('throws when credentials are missing', () => {
    expect(() => deriveRabbitMqManagementConfig('amqp://rabbitmq:5672/my-vhost')).toThrow(
      'RABBITMQ_URL must include username and password for management discovery',
    );
  });

  it('throws when the URL is invalid', () => {
    expect(() => deriveRabbitMqManagementConfig('not-a-url')).toThrow(
      'RABBITMQ_URL must be a valid URL for management discovery',
    );
  });
});
