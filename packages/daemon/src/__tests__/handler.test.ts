import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Task } from '@local-agent/shared';

// Mock child_process before importing handler
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { handleTask } from '../handler';
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('handleTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns claude with the task payload and resolves on success', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(null, { stdout: 'The answer is 4', stderr: '' });
      return {} as any;
    });

    await expect(handleTask(createTask())).resolves.toBeUndefined();

    expect(mockExecFile).toHaveBeenCalledWith(
      'claude',
      ['-p', 'What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024 },
      expect.any(Function),
    );
  });

  it('resolves without throwing when claude exits with non-zero code', async () => {
    const error = Object.assign(new Error('Process exited with code 1'), {
      code: 1,
      stdout: 'partial output',
      stderr: 'something went wrong',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(error);
      return {} as any;
    });

    await expect(handleTask(createTask())).resolves.toBeUndefined();
  });

  it('resolves without throwing when claude binary is not found', async () => {
    const error = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
      stdout: '',
      stderr: '',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as Function)(error);
      return {} as any;
    });

    await expect(handleTask(createTask())).resolves.toBeUndefined();
  });
});
