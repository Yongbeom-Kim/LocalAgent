import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable, Readable } from 'node:stream';
import { JobAttempt } from '@local-agent/shared';
import { ExecutionEnvironment } from '../../services/job-environment';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

import { TTCodexExecutor } from '../ttcodex-executor';
import { spawn, spawnSync } from 'node:child_process';

const mockSpawn = vi.mocked(spawn);
const mockSpawnSync = vi.mocked(spawnSync);

function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-456',
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'ttcodex',
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
  stdinEnd: ReturnType<typeof vi.fn>;
  stdinWrite: ReturnType<typeof vi.fn>;
}

function createMockChild(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  const stdinEnd = vi.fn();
  const stdinWrite = vi.fn((_chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
    if (typeof callback === 'function') callback();
    return true;
  });
  child.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  child.stdin.write = stdinWrite as any;
  child.stdin.end = stdinEnd as any;
  child.stdinEnd = stdinEnd;
  child.stdinWrite = stdinWrite;
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

describe('TTCodexExecutor', () => {
  let executor: TTCodexExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnSync.mockReturnValue({ status: 0 } as any);
    executor = new TTCodexExecutor();
  });

  it('returns success when both ttadk and codex binaries are available in PATH', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 0 } as any).mockReturnValueOnce({ status: 0 } as any);

    await expect(executor.precheck(createEnv())).resolves.toEqual({ ok: true });
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      1,
      'sh',
      ['-lc', 'command -v ttadk >/dev/null 2>&1'],
      { stdio: 'ignore' },
    );
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      2,
      'sh',
      ['-lc', 'command -v codex >/dev/null 2>&1'],
      { stdio: 'ignore' },
    );
  });

  it('returns failure when the ttadk binary is missing from PATH', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 1 } as any).mockReturnValueOnce({ status: 0 } as any);

    await expect(executor.precheck(createEnv())).resolves.toEqual({
      ok: false,
      stderr: 'Executor "ttcodex" unavailable: missing required binaries in PATH: ttadk',
    });
  });

  it('returns failure when the codex binary is missing from PATH', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 0 } as any).mockReturnValueOnce({ status: 1 } as any);

    await expect(executor.precheck(createEnv())).resolves.toEqual({
      ok: false,
      stderr: 'Executor "ttcodex" unavailable: missing required binaries in PATH: codex',
    });
  });

  it('reports all missing binaries when ttadk and codex are both missing from PATH', async () => {
    mockSpawnSync.mockReturnValueOnce({ status: 1 } as any).mockReturnValueOnce({ status: 1 } as any);

    await expect(executor.precheck(createEnv())).resolves.toEqual({
      ok: false,
      stderr: 'Executor "ttcodex" unavailable: missing required binaries in PATH: ttadk, codex',
    });
  });

  it('spawns ttadk with fresh exec command', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, 'ok', '', 0);
    await resultPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      'ttadk',
      [
        'code',
        '-m',
        'gpt-5.4',
        '-t',
        'codex',
        '-a',
        'exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check',
      ],
      { cwd: '/tmp/localagent-job-test', shell: false, detached: true },
    );
    expect(child.stdinWrite).toHaveBeenCalledWith('What is 2+2?');
  });

  it('closes stdin immediately after spawn', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, 'ok', '', 0);
    await resultPromise;

    expect(child.stdinWrite).toHaveBeenCalledTimes(1);
    expect(child.stdinEnd).toHaveBeenCalledTimes(1);
  });

  it('spawns ttadk with resume --last for existing workspace', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv({ isExistingWorkspace: true }));
    emitOutput(child, 'continued', '', 0);
    await resultPromise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      'ttadk',
      [
        'code',
        '-m',
        'gpt-5.4',
        '-t',
        'codex',
        '-a',
        'exec resume --last --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check',
      ],
      { cwd: '/tmp/localagent-job-test', shell: false, detached: true },
    );
    expect(child.stdinWrite).toHaveBeenCalledWith('What is 2+2?');
  });

  it('falls back to fresh when resume fails', async () => {
    const continueChild = createMockChild();
    const freshChild = createMockChild();
    mockSpawn.mockReturnValueOnce(continueChild as any).mockReturnValueOnce(freshChild as any);

    const resultPromise = executor.execute(createJobAttempt(), createEnv({ isExistingWorkspace: true }));
    emitOutput(continueChild, 'partial', 'resume failed', 1);
    await new Promise(resolve => process.nextTick(resolve));
    emitOutput(freshChild, 'fresh ok', '', 0);

    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('fresh ok');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[0][1]).toContain('exec resume --last --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check');
    expect(mockSpawn.mock.calls[1][1]).toContain('exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check');
    expect(continueChild.stdinWrite).toHaveBeenCalledWith('What is 2+2?');
    expect(freshChild.stdinWrite).toHaveBeenCalledWith('What is 2+2?');
  });

  it('prepends system prompt delimiters', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const job = createJobAttempt({
      system_prompt: 'You are concise.',
      payload: 'Solve this',
    });

    const resultPromise = executor.execute(job, createEnv());
    emitOutput(child, 'ok', '', 0);
    await resultPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check');
    expect(child.stdinWrite).toHaveBeenCalledWith('--- System ---\nYou are concise.\n--- User ---\nSolve this');
  });

  it('wraps history on fresh fallback', async () => {
    const continueChild = createMockChild();
    const freshChild = createMockChild();
    mockSpawn.mockReturnValueOnce(continueChild as any).mockReturnValueOnce(freshChild as any);

    const job = createJobAttempt({
      history: 'assistant: previous answer',
      payload: 'new question',
    });

    const resultPromise = executor.execute(job, createEnv({ isExistingWorkspace: true }));
    emitOutput(continueChild, 'partial', 'resume failed', 1);
    await new Promise(resolve => process.nextTick(resolve));
    emitOutput(freshChild, 'fresh ok', '', 0);
    await resultPromise;

    const freshArgs = mockSpawn.mock.calls[1][1] as string[];
    expect(freshArgs).toContain('exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check');
    expect(freshChild.stdinWrite).toHaveBeenCalledWith(
      '--- Thread Context ---\nassistant: previous answer\n--- Current Message ---\nnew question',
    );
  });

  it('ignores pluginDirs and does not forward them', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(
      createJobAttempt(),
      createEnv({ pluginDirs: ['/tmp/job/plugin-a', '/tmp/job/plugin-b'] }),
    );
    emitOutput(child, 'ok', '', 0);
    await resultPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.join(' ')).not.toContain('--plugin-dir');
    expect(args.join(' ')).not.toContain('/tmp/job/plugin-a');
    expect(args.join(' ')).not.toContain('/tmp/job/plugin-b');
  });

  it('strips known TTADK stdout wrapper lines', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const wrappedStdout = [
      '====================',
      'TikTok AI-Driven Development Kit',
      'Version 1.2.3',
      'Team: LocalAgent',
      'Launching Codex CLI now...',
      'Login successful',
      'codebase repo: /tmp/localagent-job-test',
      'Real output line',
    ].join('\n');

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, wrappedStdout, '', 0);

    const result = await resultPromise;
    expect(result.stdout).toBe('Real output line');
  });

  it('strips the observed TTADK ascii banner lines that include dots and apostrophes', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const wrappedStdout = [
      '  _____ _____  _    ____  _  __',
      ' |_   _|_   _|/ \\  |  _ \\| |/ /',
      "   | |   | | / _ \\ | | | | ' / ",
      '   | |   | |/ ___ \\| |_| | . \\ ',
      '   |_|   |_/_/   \\_\\____/|_|\\_\\',
      'TikTok AI-Driven Development Kit',
      'Version 0.3.13',
      'Team: TikTok ENG AI2D Project',
      '',
      'Clean result',
    ].join('\n');

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, wrappedStdout, '', 0);

    const result = await resultPromise;
    expect(result.stdout).toBe('Clean result');
  });

  it('preserves non-wrapper decorative output', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const stdout = ['TikTok AI-Driven Development Kit', '⣿⣿⣿⣿', 'Real output line'].join('\n');

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, stdout, '', 0);

    const result = await resultPromise;
    expect(result.stdout).toBe('⣿⣿⣿⣿\nReal output line');
  });

  it('promotes sanitized stderr to stdout when stdout becomes empty after sanitization', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const stdoutWrapperOnly = [
      '====================',
      'TikTok AI-Driven Development Kit',
      'Version 1.2.3',
    ].join('\n');
    const stderrReal = 'real error stream output';

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, stdoutWrapperOnly, stderrReal, 0);

    const result = await resultPromise;
    expect(result.stdout).toBe(stderrReal);
  });

  it('includes bypass and git-check flags in both fresh and resume action args', async () => {
    const freshChild = createMockChild();
    const resumeChild = createMockChild();

    mockSpawn.mockReturnValueOnce(freshChild as any);
    const freshPromise = executor.execute(createJobAttempt(), createEnv({ isExistingWorkspace: false }));
    emitOutput(freshChild, 'ok', '', 0);
    await freshPromise;

    mockSpawn.mockReturnValueOnce(resumeChild as any);
    const resumePromise = executor.execute(createJobAttempt(), createEnv({ isExistingWorkspace: true }));
    emitOutput(resumeChild, 'ok', '', 0);
    await resumePromise;

    const freshArgs = mockSpawn.mock.calls[0][1] as string[];
    const resumeArgs = mockSpawn.mock.calls[1][1] as string[];
    const freshActionArg = freshArgs[freshArgs.indexOf('-a') + 1];
    const resumeActionArg = resumeArgs[resumeArgs.indexOf('-a') + 1];
    expect(freshActionArg).toBe('exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check');
    expect(resumeActionArg).toBe('exec resume --last --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check');
  });

  it('writes prompts starting with dashes to stdin instead of embedding them in action args', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(
      createJobAttempt({ payload: '--help' }),
      createEnv(),
    );
    emitOutput(child, 'ok', '', 0);
    await resultPromise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    const actionArg = args[args.indexOf('-a') + 1];
    expect(actionArg).toBe('exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check');
    expect(child.stdinWrite).toHaveBeenCalledWith('--help');
  });

  it('preserves sanitized stderr when promoting stderr to stdout', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const stdoutWrapperOnly = 'Team: LocalAgent';
    const stderrMixed = ['Version 1.2.3', 'actual stderr content'].join('\n');

    const resultPromise = executor.execute(createJobAttempt(), createEnv());
    emitOutput(child, stdoutWrapperOnly, stderrMixed, 0);

    const result = await resultPromise;
    expect(result.stdout).toBe('actual stderr content');
    expect(result.stderr).toBe('actual stderr content');
  });

  it('returns failure immediately when payload is empty', async () => {
    const result = await executor.execute(createJobAttempt({ payload: '' }), createEnv());

    expect(result.status).toBe('failure');
    expect(result.exit_code).toBeNull();
    expect(result.stderr).toBe('Job payload is missing or empty');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
