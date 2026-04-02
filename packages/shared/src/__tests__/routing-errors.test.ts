import { describe, expect, it } from 'vitest';
import {
  TASK_COMMAND_USAGE,
  formatMissingTaskTypeMessage,
  formatUnknownTaskTypeMessage,
  formatMissingExecutorMessage,
  formatMissingModelMessage,
  formatMissingPayloadMessage,
  formatInvalidExecutorMessage,
  formatInvalidModelMessage,
  type TaskSubmission,
} from '../index';
import {
  formatThreadOnlyCommandMessage,
  formatThreadReplyHelpMessage,
  formatThreadTaskCommandRejectedMessage,
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

describe('progressive /task help', () => {
  it('formats missing task type help', () => {
    expect(formatMissingTaskTypeMessage(['generic', 'localagent'])).toBe(
      `Usage: ${TASK_COMMAND_USAGE}\nAvailable task types: generic, localagent`,
    );
  });

  it('formats unknown task type help', () => {
    expect(formatUnknownTaskTypeMessage('foo', ['generic', 'localagent'])).toBe(
      'Invalid task type "foo". Available task types: generic, localagent',
    );
  });

  it('formats missing executor help', () => {
    expect(formatMissingExecutorMessage('localagent')).toBe(
      `Missing executor for task type "localagent". Available executors: ${TASK_EXECUTOR_OPTIONS}`,
    );
  });

  it('formats missing model help', () => {
    expect(formatMissingModelMessage('cursor')).toBe(
      `Missing model for executor "cursor". Available models: ${getExecutorModelOptions('cursor')}`,
    );
  });

  it('formats missing payload help', () => {
    expect(formatMissingPayloadMessage()).toBe(
      `Usage: ${TASK_COMMAND_USAGE}\nPayload is required.`,
    );
  });

  it('allows partial normal-task submissions to carry raw executor strings', () => {
    const task: TaskSubmission = {
      task_type: 'localagent',
      payload: '',
      executor: 'foo',
    };
    expect(task.executor).toBe('foo');
  });
});

describe('thread routing guidance messages', () => {
  it('formats thread reply help message', () => {
    expect(formatThreadReplyHelpMessage()).toBe(
      'Thread replies must be natural language, /new, or /end.',
    );
  });

  it('formats /task rejected in thread message', () => {
    expect(formatThreadTaskCommandRejectedMessage()).toBe(
      'Cannot use /task in a thread. Reply with natural language, /new, or /end.\nUse /task only as a new root message.',
    );
  });

  it('formats thread-only command message', () => {
    expect(formatThreadOnlyCommandMessage('/new')).toBe(
      'The /new command can only be used inside a thread.',
    );
  });
});
