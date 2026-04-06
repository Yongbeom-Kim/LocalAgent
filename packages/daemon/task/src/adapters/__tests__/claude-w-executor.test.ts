import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable, Readable } from 'node:stream';
import { JobAttempt } from '@local-agent/shared';
import { ExecutionEnvironment } from '../../services/job-environment';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

import { ClaudeWExecutor } from '../claude-w-executor';
import { spawn, spawnSync } from 'node:child_process';

const mockSpawn = vi.mocked(spawn);
const mockSpawnSync = vi.mocked(spawnSync);

function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-456',
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'claude-w',
    executor_model: 'gpt-5.4',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    session_id: 'session-1',
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

interface MockChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  stdinData: string;
}

function createMockChild(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  let stdinData = '';
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinData += chunk.toString();
      callback();
    },
  });
  Object.defineProperty(child, 'stdinData', { get: () => stdinData });
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  return child;
}

function emitOutput(child: MockChildProcess, stdout: string, stderr: string, exitCode: number | null) {
  process.nextTick(() => {
    if (stdout) child.stdout.push(Buffer.from(stdout));
    child.stdout.push(null);
    if (stderr) child.stderr.push(Buffer.from(stderr));
    child.stderr.push(null);
    child.emit('close', exitCode);
  });
}

describe('ClaudeWExecutor', () => {
  let executor: ClaudeWExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSync.mockReturnValue({ status: 0 } as any);
    executor = new ClaudeWExecutor();
  });

  it('returns success when the claude-w binary is available in PATH', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 0 } as any);

    await expect(executor.precheck(createEnv())).resolves.toEqual({ ok: true });
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sh',
      ['-lc', 'command -v claude-w >/dev/null 2>&1'],
      { stdio: 'ignore' },
    );
  });

  it('returns failure when the claude-w binary is missing from PATH', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 1 } as any);

    await expect(executor.precheck(createEnv())).resolves.toEqual({
      ok: false,
      stderr: 'Executor "claude-w" unavailable: missing required binaries in PATH: claude-w',
    });
  });

  it('spawns claude-w with correct args and pipes payload via stdin', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, '', '', 0);
    await resultPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude-w',
      ['--dangerously-skip-permissions', '--model', 'gpt-5.4', '-p', '-'],
      { cwd: '/tmp/localagent-job-test', detached: true },
    );
    expect(child.stdinData).toBe('What is 2+2?');
  });

  it('includes repeated --plugin-dir flags', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const env = createEnv({
      workDir: '/tmp/job',
      pluginDirs: ['/tmp/job/repo/plugin-a', '/tmp/job/repo/plugin-b'],
    });

    const resultPromise = executor.execute(createJobAttempt(), env);
    emitOutput(child, '', '', 0);
    await resultPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude-w',
      [
        '--dangerously-skip-permissions',
        '--model', 'gpt-5.4',
        '--plugin-dir', '/tmp/job/repo/plugin-a',
        '--plugin-dir', '/tmp/job/repo/plugin-b',
        '-p', '-',
      ],
      { cwd: '/tmp/job', detached: true },
    );
  });

  it('includes --append-system-prompt when provided', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const job = createJobAttempt({
      system_prompt: 'You are a helpful assistant that speaks like a pirate.',
    });

    const resultPromise = executor.execute(job, createEnv());
    emitOutput(child, '', '', 0);
    await resultPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude-w',
      [
        '--dangerously-skip-permissions',
        '--model', 'gpt-5.4',
        '--append-system-prompt', 'You are a helpful assistant that speaks like a pirate.',
        '-p', '-',
      ],
      { cwd: '/tmp/localagent-job-test', detached: true },
    );
  });

  it('returns failure when payload is empty', async () => {
    const result = await executor.execute(createJobAttempt({ payload: '' }), createEnv());

    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('Job payload is missing or empty');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('returns failure when spawn emits an error', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    child.emit('error', new Error('spawn claude-w ENOENT'));

    const result = await resultPromise;

    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('spawn claude-w ENOENT');
  });

  it('returns failure when claude-w exits with non-zero code', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, 'partial output', 'something went wrong', 1);

    const result = await resultPromise;

    expect(result.status).toBe('failure');
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toBe('partial output');
    expect(result.stderr).toBe('something went wrong');
  });

  it('tries --continue first for existing workspaces and returns on success', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv({ isExistingWorkspace: true }));
    emitOutput(child, 'continued', '', 0);

    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('continued');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude-w',
      ['--dangerously-skip-permissions', '--model', 'gpt-5.4', '--continue', '-p', '-'],
      { cwd: '/tmp/localagent-job-test', detached: true },
    );
    expect(child.stdinData).toBe('What is 2+2?');
  });

  it('falls back to fresh session with thread-context input when continue fails', async () => {
    const continueChild = createMockChild();
    const freshChild = createMockChild();
    mockSpawn.mockReturnValueOnce(continueChild as any).mockReturnValueOnce(freshChild as any);

    const job = createJobAttempt({
      history: 'assistant: previous answer',
      payload: 'new question',
    });

    const resultPromise = executor.execute(job, createEnv({ isExistingWorkspace: true }));
    emitOutput(continueChild, 'partial', 'continue failed', 1);
    await new Promise(resolve => process.nextTick(resolve));
    emitOutput(freshChild, 'fresh result', '', 0);

    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('fresh result');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[0][1]).toEqual([
      '--dangerously-skip-permissions',
      '--model', 'gpt-5.4',
      '--continue',
      '-p', '-',
    ]);
    expect(mockSpawn.mock.calls[1][1]).toEqual([
      '--dangerously-skip-permissions',
      '--model', 'gpt-5.4',
      '-p', '-',
    ]);
    expect(continueChild.stdinData).toBe('new question');
    expect(freshChild.stdinData).toBe('--- Thread Context ---\nassistant: previous answer\n--- Current Message ---\nnew question');
  });

  it('truncates stdout and stderr to MAX_RESULT_OUTPUT_BYTES', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const largeOutput = 'x'.repeat(200 * 1024);

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, largeOutput, largeOutput, 0);

    const result = await resultPromise;

    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
    expect(Buffer.byteLength(result.stderr, 'utf-8')).toBeLessThanOrEqual(100 * 1024);
  });
});
