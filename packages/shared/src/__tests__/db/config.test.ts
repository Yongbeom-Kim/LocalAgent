import { describe, it, expect } from 'vitest';
import { loadSqliteConfig } from '../../db/config';

describe('loadSqliteConfig', () => {
  it('throws when LOCAL_AGENT_DB_PATH is missing', () => {
    expect(() => loadSqliteConfig({})).toThrow('LOCAL_AGENT_DB_PATH is required');
  });

  it('returns db path when required env vars are provided', () => {
    expect(
      loadSqliteConfig({
        LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
      }),
    ).toEqual({
      dbPath: '/tmp/local-agent.sqlite',
      expectedSchemaVersion: undefined,
    });
  });

  it('parses LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION', () => {
    expect(
      loadSqliteConfig({
        LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
        LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION: '12',
      }),
    ).toEqual({
      dbPath: '/tmp/local-agent.sqlite',
      expectedSchemaVersion: 12,
    });
  });

  it('throws when LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION is not a non-negative integer', () => {
    expect(() =>
      loadSqliteConfig({
        LOCAL_AGENT_DB_PATH: '/tmp/local-agent.sqlite',
        LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION: 'abc',
      }),
    ).toThrow('LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION must be a non-negative integer when provided');
  });
});
