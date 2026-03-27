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
