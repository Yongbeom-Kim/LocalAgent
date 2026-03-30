import { describe, it, expect } from 'vitest';
import {
  EXECUTOR_MODELS,
  isValidExecutorModel,
  getExecutorModelOptions,
  type Job,
  type MarketplaceConfig,
  isValidExecutorPreferences,
} from '../types';

describe('EXECUTOR_MODELS', () => {
  it('defines claude_code models', () => {
    expect(EXECUTOR_MODELS.claude_code).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('defines ttadk models', () => {
    expect(EXECUTOR_MODELS.ttadk).toEqual([
      'glm-5-ttadk', 'kimi-k2.5', 'glm-4.7-ttadk', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.2-codex',
    ]);
  });
});

describe('isValidExecutorModel', () => {
  it('returns true for valid claude_code model', () => {
    expect(isValidExecutorModel('claude_code', 'opus')).toBe(true);
    expect(isValidExecutorModel('claude_code', 'sonnet')).toBe(true);
    expect(isValidExecutorModel('claude_code', 'haiku')).toBe(true);
  });

  it('returns true for valid ttadk model', () => {
    expect(isValidExecutorModel('ttadk', 'gpt-5.4')).toBe(true);
    expect(isValidExecutorModel('ttadk', 'kimi-k2.5')).toBe(true);
  });

  it('returns false for cross-executor mismatch', () => {
    expect(isValidExecutorModel('claude_code', 'gpt-5.4')).toBe(false);
    expect(isValidExecutorModel('ttadk', 'opus')).toBe(false);
  });

  it('returns false for unknown model strings', () => {
    expect(isValidExecutorModel('claude_code', 'gpt-4o')).toBe(false);
    expect(isValidExecutorModel('ttadk', 'unknown')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isValidExecutorModel('claude_code', 123)).toBe(false);
    expect(isValidExecutorModel('claude_code', undefined)).toBe(false);
    expect(isValidExecutorModel('claude_code', null)).toBe(false);
  });
});

describe('getExecutorModelOptions', () => {
  it('returns comma-separated list for claude_code', () => {
    expect(getExecutorModelOptions('claude_code')).toBe('opus, sonnet, haiku');
  });

  it('returns comma-separated list for ttadk', () => {
    expect(getExecutorModelOptions('ttadk')).toBe(
      'glm-5-ttadk, kimi-k2.5, glm-4.7-ttadk, gpt-5.3-codex, gpt-5.4, gpt-5.2-codex',
    );
  });
});

describe('MarketplaceConfig', () => {
  it('accepts marketplaces field on Job', () => {
    // This test verifies the MarketplaceConfig type and the marketplaces
    // field are correctly defined by exercising them at compile time
    // and asserting the runtime values.
    const marketplaces: MarketplaceConfig[] = [
      { url: 'https://github.com/example/repo.git', plugins: ['my-plugin'] },
    ];
    const job: Job = {
      job_id: 'j1',
      task_id: 't1',
      task_type: 'test',
      payload: 'p',
      executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
      submitted_at: '2026-01-01T00:00:00Z',
      enriched_at: '2026-01-01T00:00:01Z',
      marketplaces: [{ url: 'https://github.com/example/repo.git', plugins: ['my-plugin'] }],
    };
    expect(job.marketplaces).toHaveLength(1);
    expect(job.marketplaces![0].url).toBe('https://github.com/example/repo.git');
    expect(job.marketplaces![0].plugins).toEqual(['my-plugin']);
  });

  it('allows Job without marketplaces field', () => {
    const job: Job = {
      job_id: 'j1',
      task_id: 't1',
      task_type: 'test',
      payload: 'p',
      executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
      submitted_at: '2026-01-01T00:00:00Z',
      enriched_at: '2026-01-01T00:00:01Z',
    };
    expect(job.marketplaces).toBeUndefined();
  });
});

describe('isValidExecutorPreferences', () => {
  it('returns true for valid non-empty array', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude_code', executor_model: 'sonnet' },
      { executor: 'ttadk', executor_model: 'gpt-5.4' },
    ])).toBe(true);
  });

  it('returns true for single-element array', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude_code', executor_model: 'opus' },
    ])).toBe(true);
  });

  it('returns false for empty array', () => {
    expect(isValidExecutorPreferences([])).toBe(false);
  });

  it('returns false for non-array', () => {
    expect(isValidExecutorPreferences('claude_code')).toBe(false);
    expect(isValidExecutorPreferences(null)).toBe(false);
    expect(isValidExecutorPreferences(undefined)).toBe(false);
  });

  it('returns false when any pair has invalid executor', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude_code', executor_model: 'sonnet' },
      { executor: 'nonexistent', executor_model: 'opus' },
    ])).toBe(false);
  });

  it('returns false when any pair has invalid model for its executor', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude_code', executor_model: 'gpt-5.4' },
    ])).toBe(false);
  });

  it('returns false for array with non-object elements', () => {
    expect(isValidExecutorPreferences(['claude_code'])).toBe(false);
  });
});
