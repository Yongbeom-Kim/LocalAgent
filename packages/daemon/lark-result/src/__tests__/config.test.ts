import { describe, it, expect } from 'vitest';
import { loadLarkDaemonConfig } from '../config';

describe('loadLarkDaemonConfig', () => {
  it('returns defaults when required env vars are set', () => {
    const config = loadLarkDaemonConfig({
      API_URL: 'http://localhost:3000',
      LARK_APP_ID: 'app123',
      LARK_APP_SECRET: 'secret456',
      LARK_RECIPIENT_ID: 'user789',
    });
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
    expect(config.larkAppId).toBe('app123');
    expect(config.larkAppSecret).toBe('secret456');
    expect(config.larkRecipientId).toBe('user789');
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

  it('throws when required env vars are missing', () => {
    expect(() => loadLarkDaemonConfig({ API_URL: 'http://localhost:3000', LARK_APP_SECRET: 'secret456', LARK_RECIPIENT_ID: 'user789' })).toThrow(
      'LARK_APP_ID is required',
    );
    expect(() => loadLarkDaemonConfig({ API_URL: 'http://localhost:3000', LARK_APP_ID: 'app123', LARK_RECIPIENT_ID: 'user789' })).toThrow(
      'LARK_APP_SECRET is required',
    );
    expect(() => loadLarkDaemonConfig({ API_URL: 'http://localhost:3000', LARK_APP_ID: 'app123', LARK_APP_SECRET: 'secret456' })).toThrow(
      'LARK_RECIPIENT_ID is required',
    );
  });
});
