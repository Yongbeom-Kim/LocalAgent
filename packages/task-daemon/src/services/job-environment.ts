import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Job, createLogger } from '@local-agent/shared';

const logger = createLogger('task-daemon:job-environment');

export interface ExecutionEnvironment {
  workDir: string;
  pluginDirs: string[];
}

export class JobEnvironment {
  constructor(private readonly debug: boolean) {}

  async setup(job: Job): Promise<ExecutionEnvironment> {
    const workDir = join(tmpdir(), `localagent-job-${job.job_id}`);
    mkdirSync(workDir, { recursive: true });

    const pluginDirs: string[] = [];

    try {
      if (job.marketplaces && job.marketplaces.length > 0) {
        const marketplacesDir = join(workDir, 'marketplaces');
        mkdirSync(marketplacesDir, { recursive: true });

        for (const marketplace of job.marketplaces) {
          const repoName = this.deriveRepoName(marketplace.url);
          const cloneDest = join(marketplacesDir, repoName);

          logger.info({ job_id: job.job_id, url: marketplace.url, dest: cloneDest }, 'Cloning marketplace repo');

          execFileSync('git', ['clone', '--depth', '1', marketplace.url, cloneDest], {
            timeout: 60_000,
          });

          for (const plugin of marketplace.plugins) {
            const pluginPath = join(cloneDest, plugin);
            if (!existsSync(pluginPath)) {
              throw new Error(`Plugin directory "${plugin}" not found in cloned repo "${repoName}" at ${pluginPath}`);
            }
            pluginDirs.push(pluginPath);
          }
        }
      }
    } catch (error) {
      if (!this.debug) {
        rmSync(workDir, { recursive: true, force: true });
      }
      throw error;
    }

    logger.info({ job_id: job.job_id, workDir, pluginDirs }, 'Job environment ready');
    return { workDir, pluginDirs };
  }

  async teardown(env: ExecutionEnvironment): Promise<void> {
    if (this.debug) {
      logger.info({ workDir: env.workDir }, 'DEBUG mode — preserving job temp directory');
      return;
    }

    rmSync(env.workDir, { recursive: true, force: true });
    logger.info({ workDir: env.workDir }, 'Cleaned up job temp directory');
  }

  private deriveRepoName(url: string): string {
    const lastSegment = url.split('/').pop() ?? url;
    return lastSegment.replace(/\.git$/, '');
  }
}
