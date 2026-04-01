import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { JobAttempt } from '@local-agent/shared';
import { ExecutionEnvironment } from '../../services/job-environment';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { TTADKExecutor } from '../ttadk-executor';
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-456',
    task_id: 'test-456',
    task_type: 'generic',
    payload: 'What is 2+2?',
    session_id: 'session-1',
    executor: 'ttadk',
    executor_model: 'gpt-5.4',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    ...overrides,
  };
}

function createEnv(overrides?: Partial<ExecutionEnvironment>): ExecutionEnvironment {
  return {
    workDir: '/tmp/localagent-job-test',
    pluginDirs: [],
    isExistingWorkspace: false,
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

    const result = await executor.execute(createJobAttempt(), createEnv());

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

    const result = await executor.execute(createJobAttempt(), createEnv());

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

    const result = await executor.execute(createJobAttempt(), createEnv());

    expect(result.job_id).toBe('job-456');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
  });

  it('returns failure result when payload is empty', async () => {
    const result = await executor.execute(createJobAttempt({ payload: '' }), createEnv());

    expect(result.job_id).toBe('job-456');
    expect(result.task_id).toBe('test-456');
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('Job payload is missing or empty');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('spawns ttadk with --bare and plugin flags forwarded via -a', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    await executor.execute(createJobAttempt({ executor: 'ttadk', executor_model: 'glm-5-ttadk' }), createEnv());

    expect(mockExecFile).toHaveBeenCalledWith(
      'ttadk',
      ['code', '-t', 'claude', '-m', 'glm-5-ttadk', '-a', '--bare --dangerously-skip-permissions -p What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024, cwd: '/tmp/localagent-job-test' },
      expect.any(Function),
    );
  });

  it('includes --plugin-dir flags in -a argument', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    const env = createEnv({
      workDir: '/tmp/job',
      pluginDirs: ['/tmp/job/repo/plugin-a', '/tmp/job/repo/plugin-b'],
    });

    await executor.execute(createJobAttempt({ executor: 'ttadk', executor_model: 'glm-5-ttadk' }), env);

    expect(mockExecFile).toHaveBeenCalledWith(
      'ttadk',
      [
        'code', '-t', 'claude', '-m', 'glm-5-ttadk',
        '-a', '--bare --dangerously-skip-permissions --plugin-dir /tmp/job/repo/plugin-a --plugin-dir /tmp/job/repo/plugin-b -p What is 2+2?',
      ],
      { maxBuffer: 50 * 1024 * 1024, cwd: '/tmp/job' },
      expect.any(Function),
    );
  });

  it('truncates stdout and stderr to MAX_RESULT_OUTPUT_BYTES', async () => {
    const largeOutput = 'x'.repeat(200 * 1024);
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, largeOutput, largeOutput);
      return {} as ChildProcess;
    });

    const result = await executor.execute(createJobAttempt(), createEnv());

    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
    expect(Buffer.byteLength(result.stderr, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
  });

  it('includes --append-system-prompt when system_prompt is provided', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    const job = createJobAttempt({
      system_prompt: 'You are a helpful assistant that speaks like a pirate.',
    });

    await executor.execute(job, createEnv());

    expect(mockExecFile).toHaveBeenCalledWith(
      'ttadk',
      [
        'code', '-t', 'claude', '-m', 'gpt-5.4',
        '-a', '--bare --dangerously-skip-permissions --append-system-prompt You are a helpful assistant that speaks like a pirate. -p What is 2+2?',
      ],
      { maxBuffer: 50 * 1024 * 1024, cwd: '/tmp/localagent-job-test' },
      expect.any(Function),
    );
  });

  it('omits --append-system-prompt when system_prompt is not provided', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    const job = createJobAttempt();

    await executor.execute(job, createEnv());

    const callArgs = mockExecFile.mock.calls[0][1] as string[];
    const claudeArgs = callArgs[callArgs.length - 1];
    expect(claudeArgs).not.toContain('--append-system-prompt');
  });

  it('uses fresh session with history and payload for new workspaces', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'Done', '');
      return {} as ChildProcess;
    });

    await executor.execute(
      createJobAttempt({
        history: 'user: previous context',
        payload: 'current payload',
      }),
      createEnv({ isExistingWorkspace: false }),
    );

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      'ttadk',
      [
        'code', '-t', 'claude', '-m', 'gpt-5.4',
        '-a', '--bare --dangerously-skip-permissions -p --- Thread Context ---\nuser: previous context\n--- Current Message ---\ncurrent payload',
      ],
      { maxBuffer: 50 * 1024 * 1024, cwd: '/tmp/localagent-job-test' },
      expect.any(Function),
    );
  });

  it('tries --continue first for existing workspaces and returns on success', async () => {
    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as ExecFileCallback)(null, 'continued', '');
        return {} as ChildProcess;
      });

    const result = await executor.execute(createJobAttempt(), createEnv({ isExistingWorkspace: true }));

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('continued');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      'ttadk',
      ['code', '-t', 'claude', '-m', 'gpt-5.4', '-a', '--bare --dangerously-skip-permissions --continue -p What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024, cwd: '/tmp/localagent-job-test' },
      expect.any(Function),
    );
  });

  it('falls back to fresh session with history and payload when continue fails', async () => {
    const continueError = Object.assign(new Error('continue failed'), {
      code: 1,
      stdout: 'partial',
      stderr: 'continue failed',
    });

    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as ExecFileCallback)(continueError, '', '');
        return {} as ChildProcess;
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as ExecFileCallback)(null, 'fresh result', '');
        return {} as ChildProcess;
      });

    const result = await executor.execute(
      createJobAttempt({
        history: 'assistant: previous answer',
        payload: 'new question',
      }),
      createEnv({ isExistingWorkspace: true }),
    );

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('fresh result');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile.mock.calls[0][1]).toEqual([
      'code',
      '-t', 'claude',
      '-m', 'gpt-5.4',
      '-a', '--bare --dangerously-skip-permissions --continue -p new question',
    ]);
    expect(mockExecFile.mock.calls[1][1]).toEqual([
      'code',
      '-t', 'claude',
      '-m', 'gpt-5.4',
      '-a', '--bare --dangerously-skip-permissions -p --- Thread Context ---\nassistant: previous answer\n--- Current Message ---\nnew question',
    ]);
  });

  it('falls back to fresh session with payload only when continue fails without history', async () => {
    const continueError = Object.assign(new Error('continue failed'), {
      code: 1,
      stdout: '',
      stderr: 'continue failed',
    });

    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as ExecFileCallback)(continueError, '', '');
        return {} as ChildProcess;
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as ExecFileCallback)(null, 'fresh result', '');
        return {} as ChildProcess;
      });

    const result = await executor.execute(
      createJobAttempt({ payload: 'payload only', history: undefined }),
      createEnv({ isExistingWorkspace: true }),
    );

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('fresh result');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile.mock.calls[0][1]).toEqual([
      'code',
      '-t', 'claude',
      '-m', 'gpt-5.4',
      '-a', '--bare --dangerously-skip-permissions --continue -p payload only',
    ]);
    expect(mockExecFile.mock.calls[1][1]).toEqual([
      'code',
      '-t', 'claude',
      '-m', 'gpt-5.4',
      '-a', '--bare --dangerously-skip-permissions -p payload only',
    ]);
  });
});
