import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger, DEFAULT_TASK_DAEMON_MACHINE_LOCK_PATH } from '@local-agent/shared';

const logger = createLogger('task-daemon:machine-lock');

interface MachineLockInfo {
  pid: number;
  locked_at: string;
}

export interface MachineLockManagerOptions {
  lockPath?: string;
}

export type MachineLockAcquireResult =
  | { acquired: true }
  | { acquired: false; holderPid: number; lockPath: string };

export interface MachineLockLike {
  acquire(): MachineLockAcquireResult;
  release(): void;
}

export class NoopMachineLock implements MachineLockLike {
  acquire(): MachineLockAcquireResult {
    return { acquired: true };
  }

  release(): void {}
}

export class MachineLockManager implements MachineLockLike {
  private readonly filePath: string;

  constructor(options: MachineLockManagerOptions = {}) {
    this.filePath = options.lockPath ?? DEFAULT_TASK_DAEMON_MACHINE_LOCK_PATH;
  }

  acquire(): MachineLockAcquireResult {
    mkdirSync(dirname(this.filePath), { recursive: true });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return this.tryCreateLock();
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw err;
        }

        const existing = this.readExistingLock();
        if (existing?.pid === process.pid) {
          logger.info({ lockPath: this.filePath }, 'Machine lock already held by current process');
          return { acquired: true };
        }

        if (existing && this.isPidAlive(existing.pid)) {
          logger.error({ holderPid: existing.pid, lockPath: this.filePath }, 'Machine lock held by another live process');
          return { acquired: false, holderPid: existing.pid, lockPath: this.filePath };
        }

        if (existing) {
          logger.warn({ staleLock: existing, lockPath: this.filePath }, 'Breaking stale machine lock');
        } else {
          logger.warn({ lockPath: this.filePath }, 'Corrupt machine lock file, overwriting');
        }

        try {
          unlinkSync(this.filePath);
        } catch (unlinkErr: unknown) {
          const unlinkCode = (unlinkErr as NodeJS.ErrnoException).code;
          if (unlinkCode !== 'ENOENT') {
            throw unlinkErr;
          }
        }
      }
    }

    throw new Error(`Unable to acquire machine lock at ${this.filePath}`);
  }

  release(): void {
    if (!existsSync(this.filePath)) {
      return;
    }

    const existing = this.readExistingLock();

    if (existing && existing.pid !== process.pid) {
      logger.warn({ lockPath: this.filePath, holderPid: existing.pid }, 'Skipping release for machine lock owned by another process');
      return;
    }

    if (!existing) {
      logger.warn({ lockPath: this.filePath }, 'Machine lock file is corrupt during release; removing it best-effort');
    }

    try {
      unlinkSync(this.filePath);
      logger.info({ lockPath: this.filePath }, 'Machine lock released');
    } catch (err) {
      logger.error({ err, lockPath: this.filePath }, 'Failed to release machine lock');
    }
  }

  private tryCreateLock(): MachineLockAcquireResult {
    const fd = openSync(this.filePath, 'wx');
    try {
      writeFileSync(
        fd,
        JSON.stringify(
          {
            pid: process.pid,
            locked_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } finally {
      closeSync(fd);
    }

    logger.info({ lockPath: this.filePath }, 'Machine lock acquired');
    return { acquired: true };
  }

  private readExistingLock(): MachineLockInfo | null {
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8')) as MachineLockInfo;
    } catch {
      return null;
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return true;
      }
      return false;
    }
  }
}
