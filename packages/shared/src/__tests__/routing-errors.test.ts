import { describe, expect, it } from 'vitest';
import {
  formatInvalidExecutorMessage,
  formatInvalidModelMessage,
} from '../routing-errors';
import { TASK_EXECUTOR_OPTIONS, getExecutorModelOptions } from '../types';

describe('formatInvalidExecutorMessage', () => {
  it('formats /task invalid executor message', () => {
    expect(formatInvalidExecutorMessage('/task', 'foo')).toBe(
      `Invalid executor "foo". Available executors: ${TASK_EXECUTOR_OPTIONS}`,
    );
  });

  it('formats /new invalid executor message', () => {
    expect(formatInvalidExecutorMessage('/new', 'foo')).toBe(
      `Invalid executor "foo" for /new. Available executors: ${TASK_EXECUTOR_OPTIONS}`,
    );
  });
});

describe('formatInvalidModelMessage', () => {
  it('formats /task invalid model message', () => {
    expect(formatInvalidModelMessage('/task', 'cursor', 'xyz')).toBe(
      `Invalid model "xyz" for executor "cursor". Available models: ${getExecutorModelOptions('cursor')}`,
    );
  });

  it('formats /new invalid model message', () => {
    expect(formatInvalidModelMessage('/new', 'cursor', 'xyz')).toBe(
      `Invalid model "xyz" for /new executor "cursor". Available models: ${getExecutorModelOptions('cursor')}`,
    );
  });
});
