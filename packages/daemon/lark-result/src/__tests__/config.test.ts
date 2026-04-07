import { describe, it, expect } from 'vitest';
import { loadLarkDaemonConfig } from '../config';

describe('loadLarkDaemonConfig', () => {
  it('returns defaults when required env vars are set', () => {
    const config = loadLarkDaemonConfig({
      API_URL: 'http://localhost:3000',
      API_AUTH_TOKEN: 'lark-result-token',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      LARK_RECIPIENT_ID: 'user789',
      LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
    });
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.apiAuthEnabled).toBe(true);
    expect(config.apiAuthToken).toBe('lark-result-token');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
    expect(config.larkAppId).toBe('app123');
    expect(config.larkAppSecret).toBe('secret456');
    expect(config.larkRecipientId).toBe('user789');
    expect(config.dbPath).toBe('/tmp/local-agent.sqlite');
    expect(config.expectedSchemaVersion).toBeUndefined();
  });

  it('reads from env vars', () => {
    const config = loadLarkDaemonConfig({
      API_URL: 'http://other:4000',
      API_AUTH_TOKEN: 'daemon-token',
      POLL_INTERVAL_MS: '2000',
      LOG_LEVEL: 'debug',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      LARK_RECIPIENT_ID: 'user789',
      LOCAL_AGENT_DB_PATH: '/tmp/other.sqlite',
      LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION: '8',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.apiAuthEnabled).toBe(true);
    expect(config.apiAuthToken).toBe('daemon-token');
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.logLevel).toBe('debug');
    expect(config.larkAppId).toBe('app123');
    expect(config.larkAppSecret).toBe('secret456');
    expect(config.larkRecipientId).toBe('user789');
    expect(config.dbPath).toBe('/tmp/other.sqlite');
    expect(config.expectedSchemaVersion).toBe(8);
  });

  it('allows startup without token when API_AUTH_DISABLED is 1', () => {
    const config = loadLarkDaemonConfig({
      API_URL: 'http://localhost:3000',
      API_AUTH_DISABLED: '1',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      LARK_RECIPIENT_ID: 'user789',
      LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
    });

    expect(config.apiAuthEnabled).toBe(false);
    expect(config.apiAuthToken).toBeUndefined();
  });

  it('requires API_AUTH_TOKEN when API auth is enabled', () => {
    expect(() => loadLarkDaemonConfig({
      API_URL: 'http://localhost:3000',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      LARK_RECIPIENT_ID: 'user789',
      LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
    })).toThrow('API_AUTH_TOKEN is required');
  });

  it('throws when required env vars are missing', () => {
    expect(() => loadLarkDaemonConfig({ API_URL: 'http://localhost:3000', API_AUTH_TOKEN: 'lark-result-token', LARK_APP_SECRET: 'secret456', LARK_RECIPIENT_ID: 'user789', LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite' })).toThrow(
      'LARK_APP_ID is required',
    );
    expect(() => loadLarkDaemonConfig({ API_URL: 'http://localhost:3000', API_AUTH_TOKEN: 'lark-result-token', LARK_APP_ID: 'app123', LARK_RECIPIENT_ID: 'user789', LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite' })).toThrow(
      'LARK_APP_SECRET is required',
    );
    expect(() => loadLarkDaemonConfig({ API_URL: 'http://localhost:3000', API_AUTH_TOKEN: 'lark-result-token', LARK_APP_ID: 'app123', LARK_APP_SECRET: 'secret456', LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite' })).toThrow(
      'LARK_RECIPIENT_ID is required',
    );
    expect(() => loadLarkDaemonConfig({
      API_URL: 'http://localhost:3000',
      API_AUTH_TOKEN: 'lark-result-token',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      LARK_RECIPIENT_ID: 'user789',
    })).toThrow(
      'LOCAL_AGENT_DB_PATH is required',
    );
  });
});
