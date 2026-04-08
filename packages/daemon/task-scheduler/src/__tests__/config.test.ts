import { describe, expect, it } from 'vitest';
import { loadSchedulerConfig } from '../config';

describe('loadSchedulerConfig', () => {
  it('requires API_URL', () => {
    expect(() => loadSchedulerConfig({
      API_AUTH_TOKEN: 'scheduler-token',
    })).toThrow('API_URL is required');
  });

  it('requires API auth token unless auth is disabled', () => {
    expect(() => loadSchedulerConfig({
      API_URL: 'http://localhost:3000',
    })).toThrow('API_AUTH_TOKEN is required');

    const config = loadSchedulerConfig({
      API_URL: 'http://localhost:3000',
      API_AUTH_DISABLED: '1',
    });

    expect(config.apiAuthEnabled).toBe(false);
    expect(config.apiAuthToken).toBeUndefined();
  });

  it('exposes schedule config directory and artifact paths', () => {
    const config = loadSchedulerConfig({
      API_URL: 'http://localhost:3000',
      API_AUTH_TOKEN: 'scheduler-token',
    });

    expect(config.scheduleConfigDir).toMatch(/config$/);
    expect(config.crontabPath).toContain('crontab');
    expect(config.configSnapshotPath).toContain('config.snapshot.json');
    expect(config.distEntryPath).toBe('dist/index.js');
  });
});
