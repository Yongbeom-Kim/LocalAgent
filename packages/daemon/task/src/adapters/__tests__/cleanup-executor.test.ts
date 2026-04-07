import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobAttempt } from '@local-agent/shared';
import { ExecutionEnvironment } from '../../services/job-environment';
import { CleanupExecutor } from '../cleanup-executor';

function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-cleanup-001',
    task_id: 'task-cleanup-001',
    task_type: 'cleanup',
    payload: 'cleanup session workspace',
    executor: 'builtin',
    executor_model: 'none',
    submitted_at: '2026-04-01T00:00:00.000Z',
    enriched_at: '2026-04-01T00:00:01.000Z',
    session_id: 'session-cleanup-001',
    ...overrides,
  };
}

function createEnv(overrides?: Partial<ExecutionEnvironment>): ExecutionEnvironment {
  return {
    workDir: '/tmp/unused-workdir',
    pluginDirs: [],
    isExistingWorkspace: false,
    ...overrides,
  };
}

describe('CleanupExecutor', () => {
  let tempBaseDir: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    tempBaseDir = mkdtempSync(join(tmpdir(), 'cleanup-executor-'));
    originalDbPath = process.env.LOCAL_AGENT_DB_PATH;
  });

  afterEach(() => {
    rmSync(tempBaseDir, { recursive: true, force: true });
    if (originalDbPath === undefined) {
      delete process.env.LOCAL_AGENT_DB_PATH;
    } else {
      process.env.LOCAL_AGENT_DB_PATH = originalDbPath;
    }
    vi.restoreAllMocks();
  });

  it('removes an existing session directory', async () => {
    const job = createJobAttempt();
    const sessionDir = join(tempBaseDir, job.session_id);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'artifact.txt'), 'temporary artifact');

    const executor = new CleanupExecutor(tempBaseDir);
    const result = await executor.execute(job, createEnv());

    expect(result).toEqual({
      job_id: 'job-cleanup-001',
      task_id: 'task-cleanup-001',
      task_type: 'cleanup',
      session_id: 'session-cleanup-001',
      status: 'success',
      exit_code: 0,
      stdout: `Removed session workspace at ${sessionDir}`,
      stderr: '',
    });
    expect(existsSync(sessionDir)).toBe(false);
  });

  it('returns success from precheck without inspecting PATH', async () => {
    const executor = new CleanupExecutor(tempBaseDir);

    await expect(executor.precheck(createEnv())).resolves.toEqual({ ok: true });
  });

  it('returns success with a not-found note when the session directory is missing', async () => {
    const job = createJobAttempt({ session_id: 'session-missing-001' });
    const sessionDir = join(tempBaseDir, job.session_id);

    const executor = new CleanupExecutor(tempBaseDir);
    const result = await executor.execute(job, createEnv());

    expect(result).toEqual({
      job_id: 'job-cleanup-001',
      task_id: 'task-cleanup-001',
      task_type: 'cleanup',
      session_id: 'session-missing-001',
      status: 'success',
      exit_code: 0,
      stdout: `Session workspace not found at ${sessionDir}; nothing to remove`,
      stderr: '',
    });
  });

  it('returns failure metadata when rmSync throws', async () => {
    const job = createJobAttempt({ session_id: 'session-error-001' });
    const sessionDir = join(tempBaseDir, job.session_id);
    mkdirSync(sessionDir, { recursive: true });
    const error = new Error('rm failed');
    const removeDirectory = vi.fn((pathToRemove: string) => {
      if (pathToRemove === sessionDir) {
        throw error;
      }
    });
    const executor = new CleanupExecutor(tempBaseDir, removeDirectory);

    const result = await executor.execute(job, createEnv());

    expect(removeDirectory).toHaveBeenCalledWith(sessionDir);
    expect(result).toEqual({
      job_id: 'job-cleanup-001',
      task_id: 'task-cleanup-001',
      task_type: 'cleanup',
      session_id: 'session-error-001',
      status: 'failure',
      exit_code: null,
      stdout: '',
      stderr: 'rm failed',
    });
  });

  it('removes nested directory structures recursively', async () => {
    const job = createJobAttempt({ session_id: 'session-nested-001' });
    const sessionDir = join(tempBaseDir, job.session_id);
    const nestedDir = join(sessionDir, 'marketplaces', 'repo', 'plugin', 'deep');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'nested.txt'), 'nested content');

    const executor = new CleanupExecutor(tempBaseDir);
    const result = await executor.execute(job, createEnv());

    expect(result.status).toBe('success');
    expect(result.stdout).toBe(`Removed session workspace at ${sessionDir}`);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it('does not require database configuration and still succeeds', async () => {
    const job = createJobAttempt({ session_id: 'session-no-db-001' });
    delete process.env.LOCAL_AGENT_DB_PATH;

    const executor = new CleanupExecutor(tempBaseDir);
    const result = await executor.execute(job, createEnv());

    expect(result.status).toBe('success');
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('nothing to remove');
  });

  it('only touches the workspace directory and never opens channel repositories', async () => {
    const job = createJobAttempt({ session_id: 'session-only-workspace-001' });
    const sessionDir = join(tempBaseDir, job.session_id);
    mkdirSync(sessionDir, { recursive: true });

    const directoryExists = vi.fn().mockReturnValue(true);
    const removeDirectory = vi.fn();
    const executor = new CleanupExecutor(tempBaseDir, removeDirectory, directoryExists);

    await executor.execute(job, createEnv());

    expect(directoryExists).toHaveBeenCalledTimes(1);
    expect(directoryExists).toHaveBeenCalledWith(sessionDir);
    expect(removeDirectory).toHaveBeenCalledTimes(1);
    expect(removeDirectory).toHaveBeenCalledWith(sessionDir);
  });
});
