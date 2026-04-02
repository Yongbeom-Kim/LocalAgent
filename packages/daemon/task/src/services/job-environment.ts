import { mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Job, DEFAULT_SETUP_HOOK_TIMEOUT_MS, SESSION_BASE_DIR, createLogger } from '@local-agent/shared';
import { SetupHookRunner } from './setup-hook-runner';

const logger = createLogger('task-daemon:job-environment');
const WORKSPACE_READY_FILE = '.workspace-ready';
const SESSION_LOCK_FILE = '.lock';

export interface ExecutionEnvironment {
  workDir: string;
  pluginDirs: string[];
  isExistingWorkspace: boolean;
}

export class JobEnvironment {
  constructor(
    private readonly debug: boolean,
    private readonly hookRunner: SetupHookRunner = new SetupHookRunner(),
  ) {}

  async setup(job: Job): Promise<ExecutionEnvironment> {
    const workDir = join(SESSION_BASE_DIR, job.session_id);

    if (this.isWorkspaceReady(workDir)) {
      const pluginDirs = this.collectPluginDirs(job, workDir);
      logger.info({ job_id: job.job_id, session_id: job.session_id, workDir, pluginDirs }, 'Reusing session workspace');
      return { workDir, pluginDirs, isExistingWorkspace: true };
    }

    const workDirExisted = existsSync(workDir);
    mkdirSync(workDir, { recursive: true });

    if (workDirExisted) {
      this.resetUninitializedWorkspace(workDir);
    }

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

      this.markWorkspaceReady(workDir);

      logger.info({ job_id: job.job_id, session_id: job.session_id, workDir, pluginDirs }, 'Job environment ready');
      return { workDir, pluginDirs, isExistingWorkspace: false };
    } catch (error) {
      if (!this.debug) {
        this.cleanupFailedWorkspace(workDir);
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

  private isWorkspaceReady(workDir: string): boolean {
    return existsSync(join(workDir, WORKSPACE_READY_FILE));
  }

  private markWorkspaceReady(workDir: string): void {
    writeFileSync(join(workDir, WORKSPACE_READY_FILE), 'ready\n');
  }

  private cleanupFailedWorkspace(workDir: string): void {
    if (this.hasSessionLock(workDir)) {
      this.resetUninitializedWorkspace(workDir);
      return;
    }

    rmSync(workDir, { recursive: true, force: true });
  }

  private hasSessionLock(workDir: string): boolean {
    return existsSync(join(workDir, SESSION_LOCK_FILE));
  }

  private resetUninitializedWorkspace(workDir: string): void {
    if (!existsSync(workDir)) {
      return;
    }

    for (const entry of readdirSync(workDir)) {
      if (entry === SESSION_LOCK_FILE) {
        continue;
      }

      rmSync(join(workDir, entry), { recursive: true, force: true });
    }
  }

  private deriveRepoName(url: string): string {
    const lastSegment = url.split('/').pop() ?? url;
    return lastSegment.replace(/\.git$/, '');
  }
}
