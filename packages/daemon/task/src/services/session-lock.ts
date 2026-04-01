import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_BASE_DIR, createLogger } from '@local-agent/shared';

const logger = createLogger('task-daemon:session-lock');

interface LockInfo {
  pid: number;
  job_id: string;
  locked_at: string;
}

export class SessionLockManager {
  private lockFileName = '.lock';

  private lockPath(sessionId: string): string {
    return join(SESSION_BASE_DIR, sessionId, this.lockFileName);
  }

  /**
   * Acquire a lock for the given session.
   * Returns true if the lock was acquired, false if the session is busy.
   * Breaks stale locks (PID no longer alive).
   */
  acquire(sessionId: string, jobId: string): boolean {
    const filePath = this.lockPath(sessionId);
    const sessionDir = join(SESSION_BASE_DIR, sessionId);

    // If session dir doesn't exist, no lock file → unlocked.
    // Create the dir so we can place the lock file.
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    if (existsSync(filePath)) {
      try {
        const existing: LockInfo = JSON.parse(readFileSync(filePath, 'utf-8'));

        // Same PID — lock is ours (shouldn't happen, but safe)
        if (existing.pid === process.pid) {
          logger.warn({ sessionId, jobId, existing }, 'Re-acquiring own lock');
        } else if (this.isPidAlive(existing.pid)) {
          // Different PID and alive → session is busy
          logger.debug({ sessionId, jobId, lockedBy: existing }, 'Session locked by another job');
          return false;
        } else {
          // PID is dead → stale lock, break it
          logger.warn({ sessionId, jobId, staleLock: existing }, 'Breaking stale lock (PID dead)');
        }
      } catch (err) {
        logger.warn({ sessionId, jobId, err }, 'Corrupt lock file, overwriting');
      }
    }

    const lockInfo: LockInfo = {
      pid: process.pid,
      job_id: jobId,
      locked_at: new Date().toISOString(),
    };

    writeFileSync(filePath, JSON.stringify(lockInfo, null, 2));
    logger.info({ sessionId, jobId }, 'Session lock acquired');
    return true;
  }

  /**
   * Release the lock for the given session.
   * Errors are swallowed so a failed release never propagates out of the
   * executeJob finally-block (which would cause drain() to reject and leave
   * the inFlightJobs map in an inconsistent state).
   */
  release(sessionId: string): void {
    const filePath = this.lockPath(sessionId);
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath);
        logger.info({ sessionId }, 'Session lock released');
      } catch (err) {
        logger.error({ sessionId, err }, 'Failed to release session lock — lock file may remain');
      }
    }
  }

  /**
   * Check if a session is locked by a live process.
   * Used by GC to skip actively-locked sessions.
   */
  isLockedByLiveProcess(sessionId: string): boolean {
    const filePath = this.lockPath(sessionId);
    if (!existsSync(filePath)) return false;

    try {
      const info: LockInfo = JSON.parse(readFileSync(filePath, 'utf-8'));
      return this.isPidAlive(info.pid);
    } catch {
      return false;
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      // EPERM means the process exists but we lack permission to signal it → alive.
      // ESRCH means no such process → dead.
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPERM') {
        return true;
      }
      return false;
    }
  }
}
