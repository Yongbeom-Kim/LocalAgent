import { describe, it, expect } from 'vitest';
import { loadEnrichmentDaemonConfig } from '../config';

describe('loadEnrichmentDaemonConfig', () => {
  it('returns defaults when required env vars are set', () => {
    const config = loadEnrichmentDaemonConfig({
      API_URL: 'http://localhost:3000',
      TASK_DAEMON_STATUS_URL: 'http://127.0.0.1:7070',
      LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
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
      LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION: '2',
      ENRICHMENT_CONFIG_DIR: '/custom/config/dir',
    });
    expect(config.apiUrl).toBe('http://other:4000');
    expect(config.pollIntervalMs).toBe(2000);
    expect(config.logLevel).toBe('debug');
    expect(config.taskDaemonStatusUrl).toBe('http://task-daemon:7171');
    expect(config.enrichmentConfigDir).toBe('/custom/config/dir');
    expect(config.dbPath).toBe('/tmp/other.sqlite');
    expect(config.expectedSchemaVersion).toBe(2);
  });

  it('throws when required env vars are missing', () => {
    expect(() => loadEnrichmentDaemonConfig({
      API_URL: 'http://localhost:3000',
      TASK_DAEMON_STATUS_URL: 'http://127.0.0.1:7070',
    })).toThrow('LOCAL_AGENT_DB_PATH is required');
  });
});
