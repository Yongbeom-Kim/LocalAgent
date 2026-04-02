import { describe, it, expect } from 'vitest';
import {
  EXECUTOR_MODELS,
  isValidExecutorModel,
  getExecutorModelOptions,
  type Job,
  type MarketplaceConfig,
  isValidExecutorPreferences,
  isTaskExecutorType,
  type TaskResultSubmission,
  isControlTaskType,
  type TaskSubmission,
} from '../types';

/** Exact static allowlist order for `cursor` (must match `EXECUTOR_MODELS.cursor`). */
const CURSOR_AGENT_MODELS_EXPECTED = [
  'auto',
  'composer-2-fast',
  'composer-2',
  'composer-1.5',
  'gpt-5.3-codex-low',
  'gpt-5.3-codex-low-fast',
  'gpt-5.3-codex',
  'gpt-5.3-codex-fast',
  'gpt-5.3-codex-high',
  'gpt-5.3-codex-high-fast',
  'gpt-5.3-codex-xhigh',
  'gpt-5.3-codex-xhigh-fast',
  'gpt-5.2',
  'gpt-5.3-codex-spark-preview-low',
  'gpt-5.3-codex-spark-preview',
  'gpt-5.3-codex-spark-preview-high',
  'gpt-5.3-codex-spark-preview-xhigh',
  'gpt-5.2-codex-low',
  'gpt-5.2-codex-low-fast',
  'gpt-5.2-codex',
  'gpt-5.2-codex-fast',
  'gpt-5.2-codex-high',
  'gpt-5.2-codex-high-fast',
  'gpt-5.2-codex-xhigh',
  'gpt-5.2-codex-xhigh-fast',
  'gpt-5.1-codex-max-low',
  'gpt-5.1-codex-max-low-fast',
  'gpt-5.1-codex-max-medium',
  'gpt-5.1-codex-max-medium-fast',
  'gpt-5.1-codex-max-high',
  'gpt-5.1-codex-max-high-fast',
  'gpt-5.1-codex-max-xhigh',
  'gpt-5.1-codex-max-xhigh-fast',
  'gpt-5.4-high',
  'gpt-5.4-high-fast',
  'gpt-5.4-xhigh-fast',
  'claude-4.6-opus-high-thinking',
  'gpt-5.4-low',
  'gpt-5.4-medium',
  'gpt-5.4-medium-fast',
  'gpt-5.4-xhigh',
  'claude-4.6-sonnet-medium',
  'claude-4.6-sonnet-medium-thinking',
  'claude-4.6-opus-high',
  'claude-4.6-opus-max',
  'claude-4.6-opus-max-thinking',
  'claude-4.5-opus-high',
  'claude-4.5-opus-high-thinking',
  'gpt-5.2-low',
  'gpt-5.2-low-fast',
  'gpt-5.2-fast',
  'gpt-5.2-high',
  'gpt-5.2-high-fast',
  'gpt-5.2-xhigh',
  'gpt-5.2-xhigh-fast',
  'gemini-3.1-pro',
  'gpt-5.4-mini-none',
  'gpt-5.4-mini-low',
  'gpt-5.4-mini-medium',
  'gpt-5.4-mini-high',
  'gpt-5.4-mini-xhigh',
  'gpt-5.4-nano-none',
  'gpt-5.4-nano-low',
  'gpt-5.4-nano-medium',
  'gpt-5.4-nano-high',
  'gpt-5.4-nano-xhigh',
  'grok-4-20',
  'grok-4-20-thinking',
  'claude-4.5-sonnet',
  'claude-4.5-sonnet-thinking',
  'gpt-5.1-low',
  'gpt-5.1',
  'gpt-5.1-high',
  'gemini-3-flash',
  'gpt-5.1-codex-mini-low',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-mini-high',
  'claude-4-sonnet',
  'claude-4-sonnet-1m',
  'claude-4-sonnet-thinking',
  'claude-4-sonnet-1m-thinking',
  'gpt-5-mini',
  'kimi-k2.5',
] as const;

describe('EXECUTOR_MODELS', () => {
  it('defines claude models', () => {
    expect(EXECUTOR_MODELS.claude).toEqual(['opus', 'sonnet', 'haiku']);
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

  it('defines cursor static allowlist', () => {
    expect(EXECUTOR_MODELS.cursor).toEqual(CURSOR_AGENT_MODELS_EXPECTED);
  });
});

describe('isTaskExecutorType', () => {
  it('accepts canonical executor names', () => {
    expect(isTaskExecutorType('claude')).toBe(true);
    expect(isTaskExecutorType('claude-w')).toBe(true);
    expect(isTaskExecutorType('builtin')).toBe(true);
    expect(isTaskExecutorType('cursor')).toBe(true);
  });

  it('rejects legacy executor names', () => {
    expect(isTaskExecutorType('claude_code')).toBe(false);
    expect(isTaskExecutorType('cursor_agent')).toBe(false);
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isTaskExecutorType('ttadk')).toBe(false);
    expect(isTaskExecutorType('')).toBe(false);
    expect(isTaskExecutorType(null)).toBe(false);
    expect(isTaskExecutorType(undefined)).toBe(false);
  });
});

describe('isValidExecutorModel', () => {
  it('returns true for valid claude model', () => {
    expect(isValidExecutorModel('claude', 'opus')).toBe(true);
    expect(isValidExecutorModel('claude', 'sonnet')).toBe(true);
    expect(isValidExecutorModel('claude', 'haiku')).toBe(true);
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
    expect(isValidExecutorModel('claude', 'gpt-5.4')).toBe(false);
    expect(isValidExecutorModel('claude-w', 'opus')).toBe(false);
  });

  it('returns false for removed ttadk executor and model names', () => {
    expect(isValidExecutorPreferences([
      { executor: 'ttadk', executor_model: 'gpt-5.4' },
    ])).toBe(false);
    expect(isValidExecutorModel('claude-w', 'glm-5-ttadk')).toBe(false);
  });

  it('returns false for unknown model strings', () => {
    expect(isValidExecutorModel('claude', 'gpt-4o')).toBe(false);
    expect(isValidExecutorModel('claude-w', 'unknown')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isValidExecutorModel('claude', 123)).toBe(false);
    expect(isValidExecutorModel('claude', undefined)).toBe(false);
    expect(isValidExecutorModel('claude', null)).toBe(false);
  });

  it('validates cursor models against the static allowlist', () => {
    expect(isValidExecutorModel('cursor', 'auto')).toBe(true);
    expect(isValidExecutorModel('cursor', 'gpt-5.4-medium-fast')).toBe(true);
    expect(isValidExecutorModel('cursor', 'claude-4.6-sonnet-medium-thinking')).toBe(true);
    expect(isValidExecutorModel('cursor', 'not-a-real-model')).toBe(false);
    expect(isValidExecutorModel('cursor', 'bad id with spaces')).toBe(false);
    expect(isValidExecutorModel('cursor', 'gpt-5.4-medium-ultra')).toBe(false);
  });
});

describe('getExecutorModelOptions', () => {
  it('returns comma-separated list for claude', () => {
    expect(getExecutorModelOptions('claude')).toBe('opus, sonnet, haiku');
  });

  it('returns comma-separated list for claude-w', () => {
    expect(getExecutorModelOptions('claude-w')).toBe(
      'gpt-5.4, gpt-5.3-codex, gpt-5.2-codex, gpt-5.2, glm-5, glm-4.7, kimi-k2.5, minimax-2.5, minimax-2.7',
    );
  });

  it('returns comma-separated list for builtin', () => {
    expect(getExecutorModelOptions('builtin')).toBe('none');
  });

  it('returns comma-separated list for cursor', () => {
    expect(getExecutorModelOptions('cursor')).toBe(EXECUTOR_MODELS.cursor.join(', '));
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
      executors: [{ executor: 'claude', executor_model: 'sonnet' }],
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
      executors: [{ executor: 'claude', executor_model: 'sonnet' }],
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
      { executor: 'claude', executor_model: 'sonnet' },
      { executor: 'claude-w', executor_model: 'gpt-5.4' },
    ])).toBe(true);
  });

  it('returns true for single-element array', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude', executor_model: 'opus' },
    ])).toBe(true);
  });

  it('returns true for builtin executor with none model', () => {
    expect(isValidExecutorPreferences([
      { executor: 'builtin', executor_model: 'none' },
    ])).toBe(true);
  });

  it('returns true for cursor with allowlisted model', () => {
    expect(isValidExecutorPreferences([
      { executor: 'cursor', executor_model: 'auto' },
    ])).toBe(true);
  });

  it('returns false for cursor with unlisted model', () => {
    expect(isValidExecutorPreferences([
      { executor: 'cursor', executor_model: 'not-a-real-model' },
    ])).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(isValidExecutorPreferences([])).toBe(false);
  });

  it('returns false for non-array', () => {
    expect(isValidExecutorPreferences('claude')).toBe(false);
    expect(isValidExecutorPreferences(null)).toBe(false);
    expect(isValidExecutorPreferences(undefined)).toBe(false);
  });

  it('returns false when any pair has invalid executor', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude', executor_model: 'sonnet' },
      { executor: 'nonexistent', executor_model: 'opus' },
    ])).toBe(false);
    expect(isValidExecutorPreferences([
      { executor: 'ttadk', executor_model: 'gpt-5.4' },
    ])).toBe(false);
  });

  it('returns false when any pair has invalid model for its executor', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude', executor_model: 'gpt-5.4' },
    ])).toBe(false);
  });

  it('returns false for array with non-object elements', () => {
    expect(isValidExecutorPreferences(['claude'])).toBe(false);
  });
});

describe('TaskResultSubmission executor metadata', () => {
  it('accepts optional executor metadata on TaskResultSubmission shape', () => {
    const result: TaskResultSubmission = {
      job_id: 'job-1',
      task_id: 'task-1',
      task_type: 'generic',
      status: 'success',
      exit_code: 0,
      stdout: 'done',
      stderr: '',
      executor: 'claude',
      executor_model: 'sonnet',
    };

    expect(result.executor).toBe('claude');
    expect(result.executor_model).toBe('sonnet');
  });
});

describe('isControlTaskType', () => {
  it('returns true for control task types', () => {
    expect(isControlTaskType('new_instance')).toBe(true);
    expect(isControlTaskType('gc')).toBe(true);
    expect(isControlTaskType('cleanup')).toBe(true);
  });

  it('returns false for normal task types', () => {
    expect(isControlTaskType('code_review')).toBe(false);
    expect(isControlTaskType('generic')).toBe(false);
  });
});

describe('TaskSubmission routing fields', () => {
  it('allows explicit routing fields on TaskSubmission', () => {
    const task: TaskSubmission = {
      task_type: 'code_review',
      payload: 'review this diff',
      executor: 'claude',
      executor_model: 'sonnet',
    };
    expect(task.executor_model).toBe('sonnet');
  });

  it('allows control-task submissions without executor fields', () => {
    const task: TaskSubmission = {
      task_type: 'cleanup',
      payload: '',
    };
    expect(task.executor).toBeUndefined();
  });
});
