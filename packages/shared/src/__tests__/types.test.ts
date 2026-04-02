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

  it('defines claude-w models', () => {
    expect(EXECUTOR_MODELS['claude-w']).toEqual([
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.2-codex',
      'gpt-5.2',
      'glm-5',
      'glm-4.7',
      'kimi-k2.5',
      'minimax-2.5',
      'minimax-2.7',
    ]);
  });

  it('defines builtin models', () => {
    expect(EXECUTOR_MODELS.builtin).toEqual(['none']);
  });

  it('defines cursor_agent example models', () => {
    expect(EXECUTOR_MODELS.cursor_agent).toEqual(['auto', 'composer-2-fast', 'gpt-5.4-medium']);
  });
});

describe('isValidExecutorModel', () => {
  it('returns true for valid claude_code model', () => {
    expect(isValidExecutorModel('claude_code', 'opus')).toBe(true);
    expect(isValidExecutorModel('claude_code', 'sonnet')).toBe(true);
    expect(isValidExecutorModel('claude_code', 'haiku')).toBe(true);
  });

  it('returns true for valid claude-w model', () => {
    expect(isValidExecutorModel('claude-w', 'gpt-5.4')).toBe(true);
    expect(isValidExecutorModel('claude-w', 'glm-5')).toBe(true);
  });

  it('returns true for valid builtin model', () => {
    expect(isValidExecutorModel('builtin', 'none')).toBe(true);
  });

  it('returns false for invalid builtin model', () => {
    expect(isValidExecutorModel('builtin', 'opus')).toBe(false);
  });

  it('returns false for cross-executor mismatch', () => {
    expect(isValidExecutorModel('claude_code', 'gpt-5.4')).toBe(false);
    expect(isValidExecutorModel('claude-w', 'opus')).toBe(false);
  });

  it('returns false for removed ttadk executor and model names', () => {
    expect(isValidExecutorPreferences([
      { executor: 'ttadk', executor_model: 'gpt-5.4' },
    ])).toBe(false);
    expect(isValidExecutorModel('claude-w', 'glm-5-ttadk')).toBe(false);
  });

  it('returns false for unknown model strings', () => {
    expect(isValidExecutorModel('claude_code', 'gpt-4o')).toBe(false);
    expect(isValidExecutorModel('claude-w', 'unknown')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isValidExecutorModel('claude_code', 123)).toBe(false);
    expect(isValidExecutorModel('claude_code', undefined)).toBe(false);
    expect(isValidExecutorModel('claude_code', null)).toBe(false);
  });

  it('validates cursor_agent model ids by pattern', () => {
    expect(isValidExecutorModel('cursor_agent', 'auto')).toBe(true);
    expect(isValidExecutorModel('cursor_agent', 'gpt-5.3-codex-high-fast')).toBe(true);
    expect(isValidExecutorModel('cursor_agent', 'claude-4.6-sonnet-medium-thinking')).toBe(true);
    expect(isValidExecutorModel('cursor_agent', '')).toBe(false);
    expect(isValidExecutorModel('cursor_agent', 'bad id')).toBe(false);
    expect(isValidExecutorModel('cursor_agent', 'x'.repeat(200))).toBe(false);
  });
});

describe('getExecutorModelOptions', () => {
  it('returns comma-separated list for claude_code', () => {
    expect(getExecutorModelOptions('claude_code')).toBe('opus, sonnet, haiku');
  });

  it('returns comma-separated list for claude-w', () => {
    expect(getExecutorModelOptions('claude-w')).toBe(
      'gpt-5.4, gpt-5.3-codex, gpt-5.2-codex, gpt-5.2, glm-5, glm-4.7, kimi-k2.5, minimax-2.5, minimax-2.7',
    );
  });

  it('returns comma-separated list for builtin', () => {
    expect(getExecutorModelOptions('builtin')).toBe('none');
  });

  it('returns descriptive options string for cursor_agent', () => {
    expect(getExecutorModelOptions('cursor_agent')).toContain('auto');
    expect(getExecutorModelOptions('cursor_agent')).toMatch(/agent models/i);
  });
});

describe('MarketplaceConfig', () => {
  it('accepts marketplaces field on Job', () => {
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
      session_id: 's1',
      marketplaces: [{ url: 'https://github.com/example/repo.git', plugins: ['my-plugin'] }],
    };
    expect(job.marketplaces).toHaveLength(1);
    expect(job.marketplaces![0].url).toBe('https://github.com/example/repo.git');
    expect(job.marketplaces![0].plugins).toEqual(['my-plugin']);
    expect(marketplaces).toHaveLength(1);
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
      session_id: 's1',
    };
    expect(job.marketplaces).toBeUndefined();
  });
});

describe('isValidExecutorPreferences', () => {
  it('returns true for valid non-empty array', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude_code', executor_model: 'sonnet' },
      { executor: 'claude-w', executor_model: 'gpt-5.4' },
    ])).toBe(true);
  });

  it('returns true for single-element array', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude_code', executor_model: 'opus' },
    ])).toBe(true);
  });

  it('returns true for builtin executor with none model', () => {
    expect(isValidExecutorPreferences([
      { executor: 'builtin', executor_model: 'none' },
    ])).toBe(true);
  });

  it('returns true for cursor_agent with pattern-valid model', () => {
    expect(isValidExecutorPreferences([
      { executor: 'cursor_agent', executor_model: 'auto' },
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
    expect(isValidExecutorPreferences([
      { executor: 'ttadk', executor_model: 'gpt-5.4' },
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
