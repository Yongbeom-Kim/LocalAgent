import { describe, it, expect } from 'vitest';
import { loadTelegramDaemonConfig } from '../config';

describe('loadTelegramDaemonConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadTelegramDaemonConfig({});
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
    expect(config.telegramBotToken).toBe('');
    expect(config.telegramChatId).toBe('');
  });

  it('reads from env vars', () => {
    const config = loadTelegramDaemonConfig({
      API_URL: 'http://other:4000',
      POLL_INTERVAL_MS: '2000',
      LOG_LEVEL: 'debug',
      TELEGRAM_BOT_TOKEN: 'bot123:ABC',
      TELEGRAM_CHAT_ID: '456789',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.logLevel).toBe('debug');
    expect(config.telegramBotToken).toBe('bot123:ABC');
    expect(config.telegramChatId).toBe('456789');
  });
});