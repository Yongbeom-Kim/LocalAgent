import { describe, it, expect } from 'vitest';
import { loadTelegramDaemonConfig } from '../config';

describe('loadTelegramDaemonConfig', () => {
  it('returns defaults when required env vars are set', () => {
    const config = loadTelegramDaemonConfig({
      API_URL: 'http://localhost:3000',
      TELEGRAM_BOT_TOKEN: 'bot123:ABC',
      TELEGRAM_FORUM_GROUP_ID: '-100456789',
      LOCAL_AGENT_DB_PATH: '/tmp/local-agent.db',
    });
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
    expect(config.telegramBotToken).toBe('bot123:ABC');
    expect(config.telegramForumGroupId).toBe('-100456789');
    expect(config.dbPath).toBe('/tmp/local-agent.db');
    expect(config.expectedSchemaVersion).toBeUndefined();
  });

  it('reads from env vars', () => {
    const config = loadTelegramDaemonConfig({
      API_URL: 'http://other:4000',
      POLL_INTERVAL_MS: '2000',
      LOG_LEVEL: 'debug',
      TELEGRAM_BOT_TOKEN: 'bot123:ABC',
      TELEGRAM_FORUM_GROUP_ID: '-100456789',
      LOCAL_AGENT_DB_PATH: '/tmp/other.db',
      LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION: '7',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.logLevel).toBe('debug');
    expect(config.telegramBotToken).toBe('bot123:ABC');
    expect(config.telegramForumGroupId).toBe('-100456789');
    expect(config.dbPath).toBe('/tmp/other.db');
    expect(config.expectedSchemaVersion).toBe(7);
  });

  it('throws when required env vars are missing', () => {
    expect(() => loadTelegramDaemonConfig({ API_URL: 'http://localhost:3000', TELEGRAM_FORUM_GROUP_ID: '-100456789', LOCAL_AGENT_DB_PATH: '/tmp/local-agent.db' })).toThrow(
      'TELEGRAM_BOT_TOKEN is required',
    );
    expect(() => loadTelegramDaemonConfig({ API_URL: 'http://localhost:3000', TELEGRAM_BOT_TOKEN: 'bot123:ABC', LOCAL_AGENT_DB_PATH: '/tmp/local-agent.db' })).toThrow(
      'TELEGRAM_FORUM_GROUP_ID is required',
    );
    expect(() => loadTelegramDaemonConfig({ API_URL: 'http://localhost:3000', TELEGRAM_BOT_TOKEN: 'bot123:ABC', TELEGRAM_FORUM_GROUP_ID: '-100456789' })).toThrow(
      'LOCAL_AGENT_DB_PATH is required',
    );
  });
});
