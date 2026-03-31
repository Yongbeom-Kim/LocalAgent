import { describe, it, expect } from 'vitest';
import { loadEnrichmentDaemonConfig } from '../config';

describe('loadEnrichmentDaemonConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadEnrichmentDaemonConfig({});
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
    expect(config.larkAppId).toBeUndefined();
    expect(config.larkAppSecret).toBeUndefined();
  });

  it('reads from env vars', () => {
    const config = loadEnrichmentDaemonConfig({
      API_URL: 'http://other:4000',
      POLL_INTERVAL_MS: '2000',
      LOG_LEVEL: 'debug',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.logLevel).toBe('debug');
    expect(config.larkAppId).toBe('app123');
    expect(config.larkAppSecret).toBe('secret456');
  });

  it('returns undefined for larkAppId when not set', () => {
    const config = loadEnrichmentDaemonConfig({
      LARK_APP_SECRET: 'secret456',
    });
    expect(config.larkAppId).toBeUndefined();
    expect(config.larkAppSecret).toBe('secret456');
  });

  it('returns undefined for larkAppSecret when not set', () => {
    const config = loadEnrichmentDaemonConfig({
      LARK_APP_ID: 'app123',
    });
    expect(config.larkAppId).toBe('app123');
    expect(config.larkAppSecret).toBeUndefined();
  });
});
