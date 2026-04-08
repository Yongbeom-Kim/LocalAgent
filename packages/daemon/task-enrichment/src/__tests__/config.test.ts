import { describe, it, expect } from 'vitest';
import { loadEnrichmentDaemonConfig } from '../config';

describe('loadEnrichmentDaemonConfig', () => {
  it('returns defaults when required env vars are set', () => {
    const config = loadEnrichmentDaemonConfig({
      API_URL: 'http://localhost:3000',
      TASK_DAEMON_STATUS_URL: 'http://127.0.0.1:7070',
      LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
      API_AUTH_TOKEN: 'daemon-token',
    });
    expect(config.apiUrl).toBe('http://localhost:3000');
    expect(config.pollIntervalMs).toBe(5000);
    expect(config.logLevel).toBe('info');
    expect(config.taskDaemonStatusUrl).toBe('http://127.0.0.1:7070');
    expect(config.enrichmentConfigDir).toMatch(/config$/);
    expect(config.dbPath).toBe('/tmp/local-agent.sqlite');
    expect(config.expectedSchemaVersion).toBeUndefined();
  });

  it('reads from env vars', () => {
    const config = loadEnrichmentDaemonConfig({
      API_URL: 'http://other:4000',
      POLL_INTERVAL_MS: '2000',
      LOG_LEVEL: 'debug',
      TASK_DAEMON_STATUS_URL: 'http://task-daemon:7171',
      LOCAL_AGENT_DB_PATH: '/tmp/other.sqlite',
      LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION: '13',
      ENRICHMENT_CONFIG_DIR: '/custom/config/dir',
      API_AUTH_TOKEN: 'daemon-token',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.logLevel).toBe('debug');
    expect(config.taskDaemonStatusUrl).toBe('http://task-daemon:7171');
    expect(config.enrichmentConfigDir).toBe('/custom/config/dir');
    expect(config.dbPath).toBe('/tmp/other.sqlite');
    expect(config.expectedSchemaVersion).toBe(13);
  });

  it('throws when required env vars are missing', () => {
    expect(() => loadEnrichmentDaemonConfig({
      API_URL: 'http://localhost:3000',
      TASK_DAEMON_STATUS_URL: 'http://127.0.0.1:7070',
      API_AUTH_TOKEN: 'daemon-token',
    })).toThrow('LOCAL_AGENT_DB_PATH is required');

    expect(() => loadEnrichmentDaemonConfig({
      API_URL: 'http://localhost:3000',
      TASK_DAEMON_STATUS_URL: 'http://127.0.0.1:7070',
      LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
    })).toThrow('API_AUTH_TOKEN is required');
  });

  it('requires API_AUTH_TOKEN when API auth is enabled', () => {
    expect(() => loadEnrichmentDaemonConfig({
      API_URL: 'http://localhost:3000',
      TASK_DAEMON_STATUS_URL: 'http://127.0.0.1:7070',
      LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
    })).toThrow('API_AUTH_TOKEN is required');
  });

  it('allows startup without token when API_AUTH_DISABLED is 1', () => {
    const config = loadEnrichmentDaemonConfig({
      API_URL: 'http://localhost:3000',
      TASK_DAEMON_STATUS_URL: 'http://127.0.0.1:7070',
      LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
      API_AUTH_DISABLED: '1',
    });

    expect(config.apiAuthEnabled).toBe(false);
    expect(config.apiAuthToken).toBeUndefined();
  });

  it('exposes api auth token for HTTP request builders', () => {
    const config = loadEnrichmentDaemonConfig({
      API_URL: 'http://localhost:3000',
      TASK_DAEMON_STATUS_URL: 'http://127.0.0.1:7070',
      LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
      API_AUTH_TOKEN: '  daemon-token  ',
    });

    expect(config.apiAuthEnabled).toBe(true);
    expect(config.apiAuthToken).toBe('daemon-token');
  });
});
