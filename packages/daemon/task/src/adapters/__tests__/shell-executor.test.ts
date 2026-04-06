import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { JobAttempt } from '@local-agent/shared';
import { ExecutionEnvironment } from '../../services/job-environment';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { ShellExecutor } from '../shell-executor';
import { spawn } from 'node:child_process';

const mockSpawn = vi.mocked(spawn);

function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-shell-001',
    task_id: 'task-shell-001',
    task_type: 'shell_command',
    payload: 'echo hello',
    executor: 'builtin',
    executor_model: 'none',
    submitted_at: '2026-04-01T00:00:00.000Z',
    enriched_at: '2026-04-01T00:00:01.000Z',
    session_id: 'session-shell-001',
    ...overrides,
  };
}

function createEnv(overrides?: Partial<ExecutionEnvironment>): ExecutionEnvironment {
  return {
    workDir: '/tmp/localagent-shell-test',
    pluginDirs: [],
    isExistingWorkspace: false,
    ...overrides,
  };
}

interface MockChildProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
}

function createMockChild(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
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

describe('ShellExecutor', () => {
  let executor: ShellExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new ShellExecutor();
  });

  it('returns success metadata when the shell exits 0', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, 'hello\n', '', 0);

    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('');
    expect(result.session_id).toBe('session-shell-001');
  });

  it('returns failure metadata when the shell exits non-zero', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, 'partial', 'boom', 2);

    const result = await resultPromise;

    expect(result.status).toBe('failure');
    expect(result.exit_code).toBe(2);
    expect(result.stdout).toBe('partial');
    expect(result.stderr).toBe('boom');
  });

  it('executes the command in env.workDir', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const env = createEnv({ workDir: '/tmp/shell-cwd' });
    const resultPromise = executor.execute(createJobAttempt({ payload: 'pwd' }), env);
    emitOutput(child, '', '', 0);
    await resultPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'zsh',
      ['-lc', 'pwd'],
      { cwd: '/tmp/shell-cwd' },
    );
  });
});
