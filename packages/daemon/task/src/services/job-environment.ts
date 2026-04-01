import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Job, DEFAULT_SETUP_HOOK_TIMEOUT_MS, createLogger } from '@local-agent/shared';
import { SetupHookRunner } from './setup-hook-runner';

const logger = createLogger('task-daemon:job-environment');

export interface ExecutionEnvironment {
  workDir: string;
  pluginDirs: string[];
}

export class JobEnvironment {
  constructor(
    private readonly debug: boolean,
    private readonly hookRunner: SetupHookRunner = new SetupHookRunner(),
  ) {}

  async setup(job: Job): Promise<ExecutionEnvironment> {
    const workDir = join('/var/tmp/local-agent/session', job.session_id);

    if (existsSync(workDir)) {
      const pluginDirs = this.collectPluginDirs(job, workDir);
      logger.info({ job_id: job.job_id, session_id: job.session_id, workDir, pluginDirs }, 'Reusing session workspace');
      return { workDir, pluginDirs };
    }

    mkdirSync(workDir, { recursive: true });

    try {
      if (job.marketplaces && job.marketplaces.length > 0) {
        const marketplacesDir = join(workDir, 'marketplaces');
        mkdirSync(marketplacesDir, { recursive: true });

        for (const marketplace of job.marketplaces) {
          const repoName = this.deriveRepoName(marketplace.url);
          const cloneDest = join(marketplacesDir, repoName);

          logger.info({ job_id: job.job_id, session_id: job.session_id, url: marketplace.url, dest: cloneDest }, 'Cloning marketplace repo');

          execFileSync('git', ['clone', '--depth', '1', marketplace.url, cloneDest], {
            timeout: 60_000,
          });
        }
      }

      const pluginDirs = this.collectPluginDirs(job, workDir);

      if (job.setup_hook) {
        const timeoutMs = job.setup_hook_timeout_ms ?? DEFAULT_SETUP_HOOK_TIMEOUT_MS;
        await this.hookRunner.run(
          job.setup_hook,
          workDir,
          {
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            session_id: job.session_id,
            payload: job.payload,
          },
          timeoutMs,
        );
      }

      logger.info({ job_id: job.job_id, session_id: job.session_id, workDir, pluginDirs }, 'Job environment ready');
      return { workDir, pluginDirs };
    } catch (error) {
      if (!this.debug) {
        rmSync(workDir, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async teardown(env: ExecutionEnvironment): Promise<void> {
    logger.info({ workDir: env.workDir }, 'Session workspace persists after teardown');
  }

  private collectPluginDirs(job: Job, workDir: string): string[] {
    const pluginDirs: string[] = [];

    for (const marketplace of job.marketplaces ?? []) {
      const repoName = this.deriveRepoName(marketplace.url);

      for (const plugin of marketplace.plugins) {
        const pluginPath = join(workDir, 'marketplaces', repoName, plugin);
        if (!existsSync(pluginPath)) {
          throw new Error(`Plugin directory "${plugin}" not found in cloned repo "${repoName}" at ${pluginPath}`);
        }
        pluginDirs.push(pluginPath);
      }
    }

    return pluginDirs;
  }

  private deriveRepoName(url: string): string {
    const lastSegment = url.split('/').pop() ?? url;
    return lastSegment.replace(/\.git$/, '');
  }
}
