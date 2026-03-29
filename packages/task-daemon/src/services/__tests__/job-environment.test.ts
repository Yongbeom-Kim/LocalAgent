import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Job } from '@local-agent/shared';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { JobEnvironment, ExecutionEnvironment } from '../job-environment';

const mockExecFileSync = vi.mocked(execFileSync);

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-test-001',
    task_id: 'task-test-001',
    task_type: 'generic',
    payload: 'test payload',
    executor: 'claude_code',
    executor_model: 'sonnet',
    submitted_at: '2026-03-29T00:00:00.000Z',
    enriched_at: '2026-03-29T00:00:01.000Z',
    ...overrides,
  };
}

describe('JobEnvironment', () => {
  let jobEnv: JobEnvironment;
  let createdDirs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    createdDirs = [];
    jobEnv = new JobEnvironment(false);

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
});
