import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from '@local-agent/shared';

const { TEST_SESSION_BASE_DIR } = vi.hoisted(() => ({
  TEST_SESSION_BASE_DIR: '/tmp/local-agent-job-environment-test/session',
}));

vi.mock('@local-agent/shared', async () => {
  const actual = await vi.importActual<typeof import('@local-agent/shared')>('@local-agent/shared');
  return {
    ...actual,
    SESSION_BASE_DIR: TEST_SESSION_BASE_DIR,
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../setup-hook-runner', () => ({
  SetupHookRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { execFileSync } from 'node:child_process';
import { SetupHookRunner } from '../setup-hook-runner';
import { JobEnvironment } from '../job-environment';

const mockExecFileSync = vi.mocked(execFileSync);
const MockSetupHookRunner = vi.mocked(SetupHookRunner);
const sessionRootDir = TEST_SESSION_BASE_DIR;

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-test-001',
    task_id: 'task-test-001',
    task_type: 'generic',
    session_id: 'session-test-001',
    payload: 'test payload',
    executors: [{ executor: 'claude', executor_model: 'sonnet' }],
    submitted_at: '2026-03-29T00:00:00.000Z',
    enriched_at: '2026-03-29T00:00:01.000Z',
    ...overrides,
  };
}

describe('JobEnvironment', () => {
  let jobEnv: JobEnvironment;
  let createdDirs: string[];
  let mockRunner: { run: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    createdDirs = [];
    MockSetupHookRunner.mockClear();
    jobEnv = new JobEnvironment(false, new SetupHookRunner());
    mockRunner = MockSetupHookRunner.mock.results[0].value as { run: ReturnType<typeof vi.fn> };

    mockExecFileSync.mockImplementation((_cmd, args) => {
      if (args && Array.isArray(args)) {
        const dest = args[args.length - 1] as string;
        if (typeof dest === 'string' && dest.startsWith(sessionRootDir)) {
          mkdirSync(dest, { recursive: true });
          const url = args[args.length - 2] as string;
          if (url.includes('claude-plugins-official')) {
            mkdirSync(join(dest, 'superpowers'), { recursive: true });
          }
          if (url.includes('personal-claude-code')) {
            mkdirSync(join(dest, 'development'), { recursive: true });
            mkdirSync(join(dest, 'learning'), { recursive: true });
          }
          if (url.includes('my-repo')) {
            mkdirSync(join(dest, 'superpowers'), { recursive: true });
          }
          createdDirs.push(dest);
        }
      }
      return Buffer.from('');
    });
  });

  afterEach(() => {
    for (const dir of createdDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors in tests
      }
    }
  });

  describe('setup', () => {
    it('creates a deterministic session workspace directory', async () => {
      const env = await jobEnv.setup(createJob());
      createdDirs.push(env.workDir);

      expect(env.workDir).toBe(join(sessionRootDir, 'session-test-001'));
      expect(env.isExistingWorkspace).toBe(false);
      expect(existsSync(env.workDir)).toBe(true);
    });

    it('returns empty pluginDirs when job has no marketplaces', async () => {
      const env = await jobEnv.setup(createJob());
      createdDirs.push(env.workDir);

      expect(env.pluginDirs).toEqual([]);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('clones marketplace repos and resolves plugin paths', async () => {
      const job = createJob({
        marketplaces: [
          {
            url: 'https://github.com/anthropics/claude-plugins-official.git',
            plugins: ['superpowers'],
          },
        ],
      });

      const env = await jobEnv.setup(job);
      createdDirs.push(env.workDir);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['clone', '--depth', '1', 'https://github.com/anthropics/claude-plugins-official.git', expect.stringContaining('claude-plugins-official')],
        expect.any(Object),
      );
      expect(env.pluginDirs).toEqual([
        join(sessionRootDir, 'session-test-001', 'marketplaces', 'claude-plugins-official', 'superpowers'),
      ]);
    });

    it('resolves multiple plugins from multiple marketplaces', async () => {
      const job = createJob({
        marketplaces: [
          {
            url: 'https://github.com/anthropics/claude-plugins-official.git',
            plugins: ['superpowers'],
          },
          {
            url: 'https://github.com/Yongbeom-Kim/personal-claude-code.git',
            plugins: ['development', 'learning'],
          },
        ],
      });

      const env = await jobEnv.setup(job);
      createdDirs.push(env.workDir);

      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
      expect(env.pluginDirs).toEqual([
        join(sessionRootDir, 'session-test-001', 'marketplaces', 'claude-plugins-official', 'superpowers'),
        join(sessionRootDir, 'session-test-001', 'marketplaces', 'personal-claude-code', 'development'),
        join(sessionRootDir, 'session-test-001', 'marketplaces', 'personal-claude-code', 'learning'),
      ]);
    });

    it('returns isExistingWorkspace false for a fresh workspace setup', async () => {
      const env = await jobEnv.setup(createJob({ session_id: 'session-fresh-flag-001' }));
      createdDirs.push(env.workDir);

      expect(env.isExistingWorkspace).toBe(false);
    });

    it('reuses an existing session workspace and skips clone and hook execution', async () => {
      const job = createJob({
        setup_hook: 'npm ci',
        marketplaces: [
          {
            url: 'https://github.com/anthropics/claude-plugins-official.git',
            plugins: ['superpowers'],
          },
        ],
      });
      const workDir = join(sessionRootDir, job.session_id);
      const pluginDir = join(workDir, 'marketplaces', 'claude-plugins-official', 'superpowers');
      mkdirSync(pluginDir, { recursive: true });
      createdDirs.push(workDir);

      const env = await jobEnv.setup(job);

      expect(env).toEqual({
        workDir,
        pluginDirs: [pluginDir],
        isExistingWorkspace: true,
      });
      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(mockRunner.run).not.toHaveBeenCalled();
    });

    it('strips .git suffix from repo URL to derive directory name', async () => {
      const job = createJob({
        marketplaces: [
          { url: 'https://github.com/org/my-repo.git', plugins: ['superpowers'] },
        ],
      });

      const env = await jobEnv.setup(job);
      createdDirs.push(env.workDir);

      expect(env.pluginDirs).toEqual([
        join(sessionRootDir, 'session-test-001', 'marketplaces', 'my-repo', 'superpowers'),
      ]);
    });

    it('throws when a plugin directory does not exist in cloned repo', async () => {
      const job = createJob({
        marketplaces: [
          { url: 'https://github.com/anthropics/claude-plugins-official.git', plugins: ['nonexistent-plugin'] },
        ],
      });

      await expect(jobEnv.setup(job)).rejects.toThrow(/Plugin directory.*nonexistent-plugin.*not found/);
      expect(existsSync(join(sessionRootDir, job.session_id))).toBe(false);
    });

    it('throws when git clone fails', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('fatal: repository not found');
      });

      const job = createJob({
        marketplaces: [
          { url: 'https://github.com/nonexistent/repo.git', plugins: ['plugin'] },
        ],
      });

      await expect(jobEnv.setup(job)).rejects.toThrow('fatal: repository not found');
      expect(existsSync(join(sessionRootDir, job.session_id))).toBe(false);
    });

    it('cleans up the session workspace when setup hook fails and debug is false', async () => {
      mockRunner.run.mockRejectedValueOnce(new Error('Setup hook failed: npm not found'));
      const job = createJob({ setup_hook: 'npm ci' });
      const workDir = join(sessionRootDir, job.session_id);

      await expect(jobEnv.setup(job)).rejects.toThrow('Setup hook failed');
      expect(existsSync(workDir)).toBe(false);
    });

    it('preserves the session workspace on setup failure when debug is true', async () => {
      const debugJobEnv = new JobEnvironment(true, new SetupHookRunner());
      const debugRunner = MockSetupHookRunner.mock.results[1].value as { run: ReturnType<typeof vi.fn> };
      debugRunner.run.mockRejectedValueOnce(new Error('Setup hook failed: npm not found'));
      const job = createJob({ session_id: 'session-debug-001', setup_hook: 'npm ci' });
      const workDir = join(sessionRootDir, job.session_id);
      createdDirs.push(workDir);

      await expect(debugJobEnv.setup(job)).rejects.toThrow('Setup hook failed');
      expect(existsSync(workDir)).toBe(true);
    });
  });

  describe('teardown', () => {
    it('is a no-op and preserves the session workspace', async () => {
      const env = await jobEnv.setup(createJob());
      createdDirs.push(env.workDir);

      expect(existsSync(env.workDir)).toBe(true);
      await jobEnv.teardown(env);
      expect(existsSync(env.workDir)).toBe(true);
    });
  });

  describe('setup hook', () => {
    it('does not call runner when job has no setup_hook', async () => {
      const env = await jobEnv.setup(createJob());
      createdDirs.push(env.workDir);

      expect(mockRunner.run).not.toHaveBeenCalled();
    });

    it('calls runner with correct args when job has setup_hook', async () => {
      const job = createJob({ setup_hook: 'npm ci', setup_hook_timeout_ms: 60_000 });
      const env = await jobEnv.setup(job);
      createdDirs.push(env.workDir);

      expect(mockRunner.run).toHaveBeenCalledWith(
        'npm ci',
        env.workDir,
        {
          job_id: job.job_id,
          task_id: job.task_id,
          task_type: job.task_type,
          session_id: job.session_id,
          payload: job.payload,
        },
        60_000,
      );
    });

    it('uses DEFAULT_SETUP_HOOK_TIMEOUT_MS when setup_hook_timeout_ms is absent', async () => {
      const job = createJob({ setup_hook: 'echo hi' });
      const env = await jobEnv.setup(job);
      createdDirs.push(env.workDir);

      const { DEFAULT_SETUP_HOOK_TIMEOUT_MS } = await import('@local-agent/shared');
      expect(mockRunner.run).toHaveBeenCalledWith(
        'echo hi',
        env.workDir,
        expect.objectContaining({
          session_id: job.session_id,
        }),
        DEFAULT_SETUP_HOOK_TIMEOUT_MS,
      );
    });
  });
});
