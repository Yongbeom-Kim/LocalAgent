import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { TEST_SESSION_BASE_DIR } = vi.hoisted(() => ({
  TEST_SESSION_BASE_DIR: '/tmp/local-agent-session-lock-test/session',
}));

vi.mock('@local-agent/shared', async () => {
  const actual = await vi.importActual<typeof import('@local-agent/shared')>('@local-agent/shared');
  return {
    ...actual,
    SESSION_BASE_DIR: TEST_SESSION_BASE_DIR,
  };
});

import { SessionLockManager } from '../session-lock';

describe('SessionLockManager', () => {
  let manager: SessionLockManager;

  beforeEach(() => {
    manager = new SessionLockManager();
    rmSync(TEST_SESSION_BASE_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TEST_SESSION_BASE_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('acquire()', () => {
    it('succeeds when no lock exists and creates lock file with correct JSON', () => {
      const sessionId = 'sess-001';
      const jobId = 'job-001';

      const result = manager.acquire(sessionId, jobId);

      expect(result).toBe(true);

      const lockPath = join(TEST_SESSION_BASE_DIR, sessionId, '.lock');
      expect(existsSync(lockPath)).toBe(true);

      const lockInfo = JSON.parse(readFileSync(lockPath, 'utf-8'));
      expect(lockInfo.pid).toBe(process.pid);
      expect(lockInfo.job_id).toBe(jobId);
      expect(lockInfo.locked_at).toBeDefined();
    });

    it('returns false when session is locked by a live PID', () => {
      const sessionId = 'sess-002';
      const sessionDir = join(TEST_SESSION_BASE_DIR, sessionId);
      mkdirSync(sessionDir, { recursive: true });

      const otherPid = process.pid + 1000;
      const lockPath = join(sessionDir, '.lock');
      writeFileSync(lockPath, JSON.stringify({
        pid: otherPid,
        job_id: 'job-other',
        locked_at: new Date().toISOString(),
      }));

      // Mock process.kill so the other PID appears alive
      const originalKill = process.kill;
      vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
        if (pid === otherPid && (signal === 0 || signal === undefined)) {
          return true;
        }
        return originalKill.call(process, pid, signal);
      });

      const result = manager.acquire(sessionId, 'job-002');

      expect(result).toBe(false);
    });

    it('breaks stale lock when PID is dead and returns true', () => {
      const sessionId = 'sess-003';
      const sessionDir = join(TEST_SESSION_BASE_DIR, sessionId);
      mkdirSync(sessionDir, { recursive: true });

      const deadPid = 999999;
      const lockPath = join(sessionDir, '.lock');
      writeFileSync(lockPath, JSON.stringify({
        pid: deadPid,
        job_id: 'job-dead',
        locked_at: new Date().toISOString(),
      }));

      const result = manager.acquire(sessionId, 'job-003');

      expect(result).toBe(true);

      const lockInfo = JSON.parse(readFileSync(lockPath, 'utf-8'));
      expect(lockInfo.pid).toBe(process.pid);
      expect(lockInfo.job_id).toBe('job-003');
    });

    it('creates session dir if it does not exist', () => {
      const sessionId = 'sess-new';
      const sessionDir = join(TEST_SESSION_BASE_DIR, sessionId);

      expect(existsSync(sessionDir)).toBe(false);

      const result = manager.acquire(sessionId, 'job-new');

      expect(result).toBe(true);
      expect(existsSync(sessionDir)).toBe(true);
    });
  });

  describe('release()', () => {
    it('removes the lock file', () => {
      const sessionId = 'sess-release';
      manager.acquire(sessionId, 'job-release');

      const lockPath = join(TEST_SESSION_BASE_DIR, sessionId, '.lock');
      expect(existsSync(lockPath)).toBe(true);

      manager.release(sessionId);

      expect(existsSync(lockPath)).toBe(false);
    });

    it('is a no-op when no lock file exists', () => {
      const sessionId = 'sess-no-lock';
      // Should not throw
      expect(() => manager.release(sessionId)).not.toThrow();
    });
  });

  describe('isLockedByLiveProcess()', () => {
    it('returns true for a live PID', () => {
      const sessionId = 'sess-live';
      // Acquire with current process PID (which is alive)
      manager.acquire(sessionId, 'job-live');

      const result = manager.isLockedByLiveProcess(sessionId);

      expect(result).toBe(true);
    });

    it('returns false for a dead PID', () => {
      const sessionId = 'sess-dead';
      const sessionDir = join(TEST_SESSION_BASE_DIR, sessionId);
      mkdirSync(sessionDir, { recursive: true });

      const deadPid = 999999;
      writeFileSync(join(sessionDir, '.lock'), JSON.stringify({
        pid: deadPid,
        job_id: 'job-dead',
        locked_at: new Date().toISOString(),
      }));

      const result = manager.isLockedByLiveProcess(sessionId);

      expect(result).toBe(false);
    });

    it('returns false when no lock file exists', () => {
      const sessionId = 'sess-none';

      const result = manager.isLockedByLiveProcess(sessionId);

      expect(result).toBe(false);
    });
  });
});
