import { describe, expect, it } from 'vitest';
import { loadMigratorConfig } from '../config';

describe('loadMigratorConfig', () => {
  it('uses the shared sqlite config and returns db path', () => {
    expect(
      loadMigratorConfig({
        LOCAL_AGENT_DB_PATH: '/tmp/local-agent.db',
      }).dbPath,
    ).toBe('/tmp/local-agent.db');
  });
});

