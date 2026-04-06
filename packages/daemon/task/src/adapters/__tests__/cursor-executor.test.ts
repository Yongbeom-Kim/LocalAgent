import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable, Readable } from 'node:stream';
import { JobAttempt } from '@local-agent/shared';
import { ExecutionEnvironment } from '../../services/job-environment';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

import { CursorExecutor } from '../cursor-executor';
import { spawn, spawnSync } from 'node:child_process';

const mockSpawn = vi.mocked(spawn);
const mockSpawnSync = vi.mocked(spawnSync);

function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-456',
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'cursor',
    executor_model: 'auto',
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
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

function createMockChild(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn();
  child.pid = 1234;
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

describe('CursorExecutor', () => {
  let executor: CursorExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSync.mockReturnValue({ status: 0 } as any);
    executor = new CursorExecutor();
  });

  it('returns success when the agent binary is available in PATH', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 0 } as any);

    await expect(executor.precheck(createEnv())).resolves.toEqual({ ok: true });
    expect(mockSpawnSync).toHaveBeenCalledWith(
      'sh',
      ['-lc', 'command -v agent >/dev/null 2>&1'],
      { stdio: 'ignore' },
    );
  });

  it('returns failure when the agent binary is missing from PATH', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 1 } as any);

    await expect(executor.precheck(createEnv())).resolves.toEqual({
      ok: false,
      stderr: 'Executor "cursor" unavailable: missing required binaries in PATH: agent',
    });
  });

  it('returns success result with stdout and stderr on successful execution', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, 'The answer is 4', 'some warning', 0);

    const result = await resultPromise;

    expect(result.job_id).toBe('job-456');
    expect(result.task_id).toBe('test-123');
    expect(result.status).toBe('success');
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('The answer is 4');
    expect(result.stderr).toBe('some warning');
  });

  it('returns failure result when agent exits with non-zero code', async () => {
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

  it('returns failure result when spawn emits an error', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    child.emit('error', new Error('spawn agent ENOENT'));

    const result = await resultPromise;

    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('spawn agent ENOENT');
  });

  it('returns failure result when payload is empty', async () => {
    const result = await executor.execute(createJobAttempt({ payload: '' }), createEnv());

    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('Job payload is missing or empty');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns agent with correct args and single trailing prompt after --', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, '', '', 0);
    await resultPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'agent',
      [
        '--print',
        '--trust',
        '--force',
        '--workspace',
        '/tmp/localagent-job-test',
        '--model',
        'auto',
        '--output-format',
        'text',
        '--',
        'What is 2+2?',
      ],
      { cwd: '/tmp/localagent-job-test', shell: false, detached: true },
    );
  });

  it('omits --continue when workspace is new', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv({ isExistingWorkspace: false }));
    emitOutput(child, '', '', 0);
    await resultPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--continue');
  });

  it('includes --continue for existing workspaces', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv({ isExistingWorkspace: true }));
    emitOutput(child, 'continued', '', 0);

    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--continue');
    expect(args[args.length - 1]).toBe('What is 2+2?');
  });

  it('falls back to fresh session with history when continue fails', async () => {
    const continueChild = createMockChild();
    const freshChild = createMockChild();
    mockSpawn.mockReturnValueOnce(continueChild as any).mockReturnValueOnce(freshChild as any);

    const job = createJobAttempt({
      history: 'assistant: previous',
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
    expect(mockSpawn.mock.calls[0][1]).toContain('--continue');
    const continueArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(continueArgs[continueArgs.length - 1]).toBe('new question');
    const freshArgs = mockSpawn.mock.calls[1][1] as string[];
    expect(freshArgs).not.toContain('--continue');
    expect(freshArgs[freshArgs.length - 1]).toBe(
      '--- Thread Context ---\nassistant: previous\n--- Current Message ---\nnew question',
    );
  });

  it('prepends system block when system_prompt is set', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const job = createJobAttempt({
      system_prompt: 'Be concise.',
    });

    const resultPromise = executor.execute(job, createEnv());
    emitOutput(child, '', '', 0);
    await resultPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.length - 1]).toBe(
      '--- System ---\nBe concise.\n--- User ---\nWhat is 2+2?',
    );
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

  it('registers cancellation hooks that terminate the spawned process', async () => {
    const child = createMockChild();
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    mockSpawn.mockReturnValue(child as any);

    const cancel = vi.fn();
    const resultPromise = executor.execute(createJobAttempt(), createEnv(), {
      runningJob: {
        attachCancellationHandle: ({ cancel: attachedCancel }) => {
          cancel.mockImplementation(attachedCancel);
        },
        clear: vi.fn(),
        hasCancellationHandle: vi.fn().mockReturnValue(false),
        isCancellationRequested: vi.fn().mockReturnValue(false),
      },
    });

    cancel();
    emitOutput(child, 'partial', '', 0);
    await resultPromise;

    expect(processKill).toHaveBeenCalledWith(-1234, 'SIGTERM');
    processKill.mockRestore();
  });
});
