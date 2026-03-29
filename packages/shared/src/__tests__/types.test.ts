import { describe, it, expect } from 'vitest';
import {
  EXECUTOR_MODELS,
  isValidExecutorModel,
  getExecutorModelOptions,
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
  it('is exported from the package', async () => {
    const types = await import('../types');
    // MarketplaceConfig is a type-only export, so we verify
    // that Job and JobSubmission accept the marketplaces field
    const job: types.Job = {
      job_id: 'j1',
      task_id: 't1',
      task_type: 'test',
      payload: 'p',
      executor: 'claude_code',
      executor_model: 'sonnet',
      submitted_at: '2026-01-01T00:00:00Z',
      enriched_at: '2026-01-01T00:00:01Z',
      marketplaces: [{ url: 'https://github.com/example/repo.git', plugins: ['my-plugin'] }],
    };
    expect(job.marketplaces).toHaveLength(1);
    expect(job.marketplaces![0].url).toBe('https://github.com/example/repo.git');
    expect(job.marketplaces![0].plugins).toEqual(['my-plugin']);
  });

  it('allows Job without marketplaces field', async () => {
    const types = await import('../types');
    const job: types.Job = {
      job_id: 'j1',
      task_id: 't1',
      task_type: 'test',
      payload: 'p',
      executor: 'claude_code',
      executor_model: 'sonnet',
      submitted_at: '2026-01-01T00:00:00Z',
      enriched_at: '2026-01-01T00:00:01Z',
    };
    expect(job.marketplaces).toBeUndefined();
  });
});
