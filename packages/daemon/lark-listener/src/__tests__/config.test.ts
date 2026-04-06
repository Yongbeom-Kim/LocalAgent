import { describe, it, expect } from 'vitest';
import { loadLarkListenerConfig } from '../config';

describe('loadLarkListenerConfig', () => {
  it('returns defaults when required env vars are set', () => {
    const config = loadLarkListenerConfig({
      API_URL: 'http://localhost:3000',
      API_AUTH_TOKEN: 'listener-token',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
    });
    expect(config.appId).toBe('app123');
    expect(config.appSecret).toBe('secret456');
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.apiAuthEnabled).toBe(true);
    expect(config.apiAuthToken).toBe('listener-token');
    expect(config.logLevel).toBe('info');
    expect(config.dedupTtlMs).toBe(300_000);
  });

  it('reads from env vars', () => {
    const config = loadLarkListenerConfig({
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      API_URL: 'http://other:4000',
      API_AUTH_TOKEN: 'daemon-token',
      LOG_LEVEL: 'debug',
      DEDUP_TTL_MS: '60000',
    });
    expect(config.appId).toBe('app123');
    expect(config.appSecret).toBe('secret456');
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.apiAuthEnabled).toBe(true);
    expect(config.apiAuthToken).toBe('daemon-token');
    expect(config.logLevel).toBe('debug');
    expect(config.dedupTtlMs).toBe(60_000);
  });

  it('allows startup without token when API_AUTH_DISABLED is 1', () => {
    const config = loadLarkListenerConfig({
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      API_URL: 'http://localhost:3000',
      API_AUTH_DISABLED: '1',
    });

    expect(config.apiAuthEnabled).toBe(false);
    expect(config.apiAuthToken).toBeUndefined();
  });

  it('requires API_AUTH_TOKEN when API auth is enabled', () => {
    expect(() =>
      loadLarkListenerConfig({
        LARK_APP_ID: 'app123',
        LARK_APP_SECRET: 'secret456',
        API_URL: 'http://localhost:3000',
      }),
    ).toThrow('API_AUTH_TOKEN is required');
  });

  it('throws when required env vars are missing', () => {
    expect(() =>
      loadLarkListenerConfig({
        API_URL: 'http://localhost:3000',
        API_AUTH_TOKEN: 'secret-token',
        LARK_APP_SECRET: 'secret456',
      }),
    ).toThrow(
      'LARK_APP_ID is required',
    );
    expect(() =>
      loadLarkListenerConfig({
        API_URL: 'http://localhost:3000',
        API_AUTH_TOKEN: 'secret-token',
        LARK_APP_ID: 'app123',
      }),
    ).toThrow(
      'LARK_APP_SECRET is required',
    );
    expect(() =>
      loadLarkListenerConfig({
        LARK_APP_ID: 'app123',
        LARK_APP_SECRET: 'secret456',
        API_AUTH_TOKEN: 'secret-token',
      }),
    ).toThrow(
      'API_URL is required',
    );
  });
});
