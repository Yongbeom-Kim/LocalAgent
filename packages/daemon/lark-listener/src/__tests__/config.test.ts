import { describe, it, expect } from 'vitest';
import { loadLarkListenerConfig } from '../config';

describe('loadLarkListenerConfig', () => {
  it('returns defaults when required env vars are set', () => {
    const config = loadLarkListenerConfig({
      API_URL: 'http://localhost:3000',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
    });
    expect(config.appId).toBe('app123');
    expect(config.appSecret).toBe('secret456');
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.logLevel).toBe('info');
    expect(config.dedupTtlMs).toBe(300_000);
  });

  it('reads from env vars', () => {
    const config = loadLarkListenerConfig({
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      API_URL: 'http://other:4000',
      LOG_LEVEL: 'debug',
      DEDUP_TTL_MS: '60000',
    });
    expect(config.appId).toBe('app123');
    expect(config.appSecret).toBe('secret456');
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.logLevel).toBe('debug');
    expect(config.dedupTtlMs).toBe(60_000);
  });

  it('throws when required env vars are missing', () => {
    expect(() =>
      loadLarkListenerConfig({
        API_URL: 'http://localhost:3000',
        LARK_APP_SECRET: 'secret456',
      }),
    ).toThrow(
      'LARK_APP_ID is required',
    );
    expect(() =>
      loadLarkListenerConfig({
        API_URL: 'http://localhost:3000',
        LARK_APP_ID: 'app123',
      }),
    ).toThrow(
      'LARK_APP_SECRET is required',
    );
    expect(() =>
      loadLarkListenerConfig({
        LARK_APP_ID: 'app123',
        LARK_APP_SECRET: 'secret456',
      }),
    ).toThrow(
      'API_URL is required',
    );
  });
});
