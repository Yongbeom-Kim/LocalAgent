import { describe, it, expect } from 'vitest';
import { loadLarkDaemonConfig } from '../config';

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
