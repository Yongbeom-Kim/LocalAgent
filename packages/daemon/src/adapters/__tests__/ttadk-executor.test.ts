import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { Task } from '@local-agent/shared';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { TTADKExecutor } from '../ttadk-executor';
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'ttadk',
    executor_model: 'gpt-5.4',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

describe('TTADKExecutor', () => {
  let executor: TTADKExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new TTADKExecutor();
  });

  it('spawns ttadk with the exact task payload arguments and resolves on success', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'The answer is 4', '');
      return {} as ChildProcess;
    });

    await expect(executor.execute(createTask())).resolves.toBeUndefined();

    expect(mockExecFile).toHaveBeenCalledWith(
      'ttadk',
      ['code', '-t', 'claude', '-m', 'gpt-5.4', '-a', '--dangerously-skip-permissions -p What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024 },
      expect.any(Function),
    );
  });

  it('resolves without throwing when ttadk exits with non-zero code', async () => {
    const error = Object.assign(new Error('Process exited with code 1'), {
      code: 1,
      stdout: 'partial output',
      stderr: 'something went wrong',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    await expect(executor.execute(createTask())).resolves.toBeUndefined();
  });

  it('resolves without throwing when ttadk binary is not found', async () => {
    const error = Object.assign(new Error('spawn ttadk ENOENT'), {
      code: 'ENOENT',
      stdout: '',
      stderr: '',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    await expect(executor.execute(createTask())).resolves.toBeUndefined();
  });

  it('skips spawning when payload is empty', async () => {
    await expect(executor.execute(createTask({ payload: '' }))).resolves.toBeUndefined();

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('passes executor_model to -m flag instead of hardcoded value', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'ok', '');
      return {} as ChildProcess;
    });

    await executor.execute(createTask({ executor_model: 'kimi-k2.5' }));

    expect(mockExecFile).toHaveBeenCalledWith(
      'ttadk',
      ['code', '-t', 'claude', '-m', 'kimi-k2.5', '-a', '--dangerously-skip-permissions -p What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024 },
      expect.any(Function),
    );
  });
});
