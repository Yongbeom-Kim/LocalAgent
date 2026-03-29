import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { Task } from '@local-agent/shared';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { ClaudeCliExecutor } from '../claude-cli-executor';
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'claude_code',
    executor_model: 'opus',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

describe('ClaudeCliExecutor', () => {
  let executor: ClaudeCliExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new ClaudeCliExecutor();
  });

  it('returns success result with stdout and stderr on successful execution', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'The answer is 4', 'some warning');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(result.task_id).toBe('test-123');
    expect(result.status).toBe('success');
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('The answer is 4');
    expect(result.stderr).toBe('some warning');
  });

  it('returns failure result when claude exits with non-zero code', async () => {
    const error = Object.assign(new Error('Process exited with code 1'), {
      code: 1,
      stdout: 'partial output',
      stderr: 'something went wrong',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(result.task_id).toBe('test-123');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toBe('partial output');
    expect(result.stderr).toBe('something went wrong');
  });

  it('returns failure result with null exit_code when claude binary is not found', async () => {
    const error = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
      stdout: '',
      stderr: '',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(result.task_id).toBe('test-123');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('');
  });

  it('returns failure result when payload is empty', async () => {
    const result = await executor.execute(createTask({ payload: '' }));

    expect(result.task_id).toBe('test-123');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('Task payload is missing or empty');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('spawns claude with correct arguments', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    await executor.execute(createTask());

    expect(mockExecFile).toHaveBeenCalledWith(
      'claude',
      ['--dangerously-skip-permissions', '--model', 'opus', '-p', 'What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024 },
      expect.any(Function),
    );
  });

  it('truncates stdout and stderr to MAX_RESULT_OUTPUT_BYTES', async () => {
    const largeOutput = 'x'.repeat(200 * 1024);
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, largeOutput, largeOutput);
      return {} as ChildProcess;
    });

    const result = await executor.execute(createTask());

    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
    expect(Buffer.byteLength(result.stderr, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
  });
});
