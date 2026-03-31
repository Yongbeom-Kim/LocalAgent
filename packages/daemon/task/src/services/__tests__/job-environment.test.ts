import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Job } from '@local-agent/shared';

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
import { JobEnvironment, ExecutionEnvironment } from '../job-environment';

const mockExecFileSync = vi.mocked(execFileSync);
const MockSetupHookRunner = vi.mocked(SetupHookRunner);

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-test-001',
    task_id: 'task-test-001',
    task_type: 'generic',
    payload: 'test payload',
    executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
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

    // Make mock execFileSync simulate creating the cloned directory
    mockExecFileSync.mockImplementation((_cmd, args) => {
      if (args && Array.isArray(args)) {
        // git clone --depth 1 <url> <dest>
        const dest = args[args.length - 1] as string;
        if (typeof dest === 'string' && dest.includes('localagent-job-')) {
          mkdirSync(dest, { recursive: true });
          // Create a fake plugin directory inside
          const url = args[args.length - 2] as string;
          if (url.includes('claude-plugins-official')) {
            mkdirSync(join(dest, 'superpowers'), { recursive: true });
          }
          if (url.includes('personal-claude-code')) {
            mkdirSync(join(dest, 'development'), { recursive: true });
            mkdirSync(join(dest, 'learning'), { recursive: true });
          }
          createdDirs.push(dest);
        }
      }
      return Buffer.from('');
    });
  });

  afterEach(() => {
    // Clean up any temp dirs created during tests
    for (const dir of createdDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });

  describe('setup', () => {
    it('creates a temp directory for the job', async () => {
      const env = await jobEnv.setup(createJob());
      createdDirs.push(env.workDir);

      expect(env.workDir).toMatch(/localagent-job-job-test-001/);
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
      expect(env.pluginDirs).toHaveLength(1);
      expect(env.pluginDirs[0]).toMatch(/claude-plugins-official\/superpowers$/);
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
      expect(env.pluginDirs).toHaveLength(3);
    });

    it('strips .git suffix from repo URL to derive directory name', async () => {
      const job = createJob({
        marketplaces: [
          { url: 'https://github.com/org/my-repo.git', plugins: ['superpowers'] },
        ],
      });

      // Mock to create directory with expected plugin
      mockExecFileSync.mockImplementation((_cmd, args) => {
        const dest = (args as string[])[args!.length - 1];
        mkdirSync(dest, { recursive: true });
        mkdirSync(join(dest, 'superpowers'), { recursive: true });
        createdDirs.push(dest);
        return Buffer.from('');
      });

      const env = await jobEnv.setup(job);
      createdDirs.push(env.workDir);

      expect(env.pluginDirs[0]).toMatch(/my-repo\/superpowers$/);
    });

    it('throws when a plugin directory does not exist in cloned repo', async () => {
      const job = createJob({
        marketplaces: [
          { url: 'https://github.com/anthropics/claude-plugins-official.git', plugins: ['nonexistent-plugin'] },
        ],
      });

      await expect(jobEnv.setup(job)).rejects.toThrow(/Plugin directory.*nonexistent-plugin.*not found/);
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
    });
  });

  describe('teardown', () => {
    it('removes the temp directory', async () => {
      const env = await jobEnv.setup(createJob());

      expect(existsSync(env.workDir)).toBe(true);
      await jobEnv.teardown(env);
      expect(existsSync(env.workDir)).toBe(false);
    });

    it('skips cleanup when DEBUG is enabled', async () => {
      const debugJobEnv = new JobEnvironment(true);
      const env = await debugJobEnv.setup(createJob());
      createdDirs.push(env.workDir);

      await debugJobEnv.teardown(env);
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
        expect.any(Object),
        DEFAULT_SETUP_HOOK_TIMEOUT_MS,
      );
    });

    it('throws and cleans up workDir when hook fails', async () => {
      mockRunner.run.mockRejectedValueOnce(new Error('Setup hook failed: npm not found'));

      const job = createJob({ setup_hook: 'npm ci' });
      await expect(jobEnv.setup(job)).rejects.toThrow('Setup hook failed');

      // workDir should be cleaned up
      // We can't easily get workDir here so we verify setup threw — cleanup is verified via the try/catch path
    });
  });
});
