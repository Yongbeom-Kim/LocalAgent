import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { Job } from '@local-agent/shared';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { TTADKExecutor } from '../ttadk-executor';
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'test-456',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'ttadk',
    executor_model: 'gpt-5.4',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
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

  it('returns success result with stdout and stderr on successful execution', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'The answer is 4', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createJob());

    expect(result.job_id).toBe('job-456');
    expect(result.task_id).toBe('test-456');
    expect(result.status).toBe('success');
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('The answer is 4');
    expect(result.stderr).toBe('');
  });

  it('returns failure result when ttadk exits with non-zero code', async () => {
    const error = Object.assign(new Error('Process exited with code 1'), {
      code: 1,
      stdout: 'partial',
      stderr: 'error output',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createJob());

    expect(result.job_id).toBe('job-456');
    expect(result.task_id).toBe('test-456');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toBe('partial');
    expect(result.stderr).toBe('error output');
  });

  it('returns failure result with null exit_code when ttadk binary not found', async () => {
    const error = Object.assign(new Error('spawn ttadk ENOENT'), {
      code: 'ENOENT',
      stdout: '',
      stderr: '',
    });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(error, '', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(createJob());

    expect(result.job_id).toBe('job-456');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
  });

  it('returns failure result when payload is empty', async () => {
    const result = await executor.execute(createJob({ payload: '' }));

    expect(result.job_id).toBe('job-456');
    expect(result.task_id).toBe('test-456');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('Job payload is missing or empty');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('spawns ttadk with correct arguments', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    await executor.execute(createJob());

    expect(mockExecFile).toHaveBeenCalledWith(
      'ttadk',
      ['code', '-t', 'claude', '-m', 'gpt-5.4', '-a', '--dangerously-skip-permissions -p What is 2+2?'],
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

    const result = await executor.execute(createJob());

    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
    expect(Buffer.byteLength(result.stderr, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
  });
});
