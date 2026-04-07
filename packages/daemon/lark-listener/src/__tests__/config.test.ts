import { describe, it, expect } from 'vitest';
import { loadLarkListenerConfig } from '../config';

describe('loadLarkListenerConfig', () => {
  it('returns defaults when required env vars are set', () => {
    const config = loadLarkListenerConfig({
      API_URL: 'http://localhost:3000',
      API_AUTH_TOKEN: 'test-token',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
    });
    expect(config.appId).toBe('app123');
    expect(config.appSecret).toBe('secret456');
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.logLevel).toBe('info');
    expect(config.dedupTtlMs).toBe(300_000);
    expect(config.dbPath).toBe('/tmp/local-agent.sqlite');
    expect(config.expectedSchemaVersion).toBeUndefined();
  });

  it('reads from env vars', () => {
    const config = loadLarkListenerConfig({
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      API_URL: 'http://other:4000',
      API_AUTH_TOKEN: 'test-token',
      LOCAL_AGENT_DB_PATH: '/tmp/other.sqlite',
      LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION: '8',
      LOG_LEVEL: 'debug',
      DEDUP_TTL_MS: '60000',
    });
    expect(config.appId).toBe('app123');
    expect(config.appSecret).toBe('secret456');
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.logLevel).toBe('debug');
    expect(config.dedupTtlMs).toBe(60_000);
    expect(config.dbPath).toBe('/tmp/other.sqlite');
    expect(config.expectedSchemaVersion).toBe(8);
  });

  it('throws when required env vars are missing', () => {
    expect(() =>
      loadLarkListenerConfig({
        API_URL: 'http://localhost:3000',
        API_AUTH_TOKEN: 'test-token',
        LARK_APP_SECRET: 'secret456',
        LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
      }),
    ).toThrow(
      'LARK_APP_ID is required',
    );
    expect(() =>
      loadLarkListenerConfig({
        API_URL: 'http://localhost:3000',
        API_AUTH_TOKEN: 'test-token',
        LARK_APP_ID: 'app123',
        LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
      }),
    ).toThrow(
      'LARK_APP_SECRET is required',
    );
    expect(() =>
      loadLarkListenerConfig({
        API_AUTH_TOKEN: 'test-token',
        LARK_APP_ID: 'app123',
        LARK_APP_SECRET: 'secret456',
        LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
      }),
    ).toThrow(
      'API_URL is required',
    );
  });
});
