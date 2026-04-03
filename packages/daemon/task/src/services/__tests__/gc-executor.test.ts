import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from '@local-agent/shared';

const { TEST_SESSION_BASE_DIR, TEST_SESSION_DIR_TTL_DAYS } = vi.hoisted(() => ({
  TEST_SESSION_BASE_DIR: '/tmp/local-agent-gc-test/session',
  TEST_SESSION_DIR_TTL_DAYS: 7,
}));

vi.mock('@local-agent/shared', async () => {
  const actual = await vi.importActual<typeof import('@local-agent/shared')>('@local-agent/shared');
  return {
    ...actual,
    SESSION_BASE_DIR: TEST_SESSION_BASE_DIR,
    SESSION_DIR_TTL_DAYS: TEST_SESSION_DIR_TTL_DAYS,
  };
});
import { GcExecutor } from '../gc-executor';

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-gc-001',
    task_id: 'task-gc-001',
    task_type: 'gc',
    session_id: 'session-gc-001',
    payload: '',
    executors: [{ executor: 'claude', executor_model: 'sonnet' }],
    submitted_at: '2026-03-29T00:00:00.000Z',
    enriched_at: '2026-03-29T00:00:01.000Z',
    ...overrides,
  };
}

function makeDir(name: string): string {
  const dirPath = join(TEST_SESSION_BASE_DIR, name);
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function setDirAge(dirPath: string, ageDays: number): void {
  const timestamp = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(dirPath, timestamp, timestamp);
}

describe('GcExecutor', () => {
  let executor: GcExecutor;

  beforeEach(() => {
    executor = new GcExecutor();
    rmSync(TEST_SESSION_BASE_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TEST_SESSION_BASE_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns success when base dir is missing', () => {
    const result = executor.execute(createJob());

    expect(result).toEqual({
      job_id: 'job-gc-001',
      task_id: 'task-gc-001',
      task_type: 'gc',
      status: 'success',
      exit_code: 0,
      stdout: 'GC complete: no session directories found.',
      stderr: '',
    });
  });

  it('returns zero counts for empty session dir', () => {
    mkdirSync(TEST_SESSION_BASE_DIR, { recursive: true });

    const result = executor.execute(createJob());

    expect(result.stdout).toBe('GC complete: removed 0 session(s), retained 0.');
  });

  it('removes stale directories', () => {
    const staleDir = makeDir('stale-session');
    setDirAge(staleDir, TEST_SESSION_DIR_TTL_DAYS + 1);

    const result = executor.execute(createJob());

    expect(result.stdout).toBe('GC complete: removed 1 session(s), retained 0.');
    expect(() => rmSync(staleDir, { recursive: true, force: true })).not.toThrow();
  });

  it('retains fresh directories', () => {
    const freshDir = makeDir('fresh-session');
    setDirAge(freshDir, 1);

    const result = executor.execute(createJob());

    expect(result.stdout).toBe('GC complete: removed 0 session(s), retained 1.');
  });

  it('handles mixed stale and fresh directories', () => {
    const staleDir = makeDir('stale-session');
    const freshDir = makeDir('fresh-session');
    setDirAge(staleDir, TEST_SESSION_DIR_TTL_DAYS + 1);
    setDirAge(freshDir, 1);

    const result = executor.execute(createJob());

    expect(result.stdout).toBe('GC complete: removed 1 session(s), retained 1.');
  });

  it('propagates task_source when present', () => {
    const result = executor.execute(createJob({
      task_source: { source: 'lark', message_id: 'om_msg1' },
    }));

    expect(result.task_source).toEqual({ source: 'lark', message_id: 'om_msg1' });
  });

  it('ignores non-directory entries', () => {
    mkdirSync(TEST_SESSION_BASE_DIR, { recursive: true });
    writeFileSync(join(TEST_SESSION_BASE_DIR, 'note.txt'), 'hello');

    const result = executor.execute(createJob());

    expect(result.stdout).toBe('GC complete: removed 0 session(s), retained 0.');
  });

  describe('lock-aware GC', () => {
    it('skips a stale session directory that has a live PID lock file', () => {
      const sessionDir = makeDir('locked-session');

      // Write a lock file with the current (live) PID
      const lockInfo = {
        pid: process.pid,
        job_id: 'job-live-001',
        locked_at: new Date().toISOString(),
      };
      writeFileSync(join(sessionDir, '.lock'), JSON.stringify(lockInfo, null, 2));

      // Set age after writing the lock file so directory mtime is old
      setDirAge(sessionDir, TEST_SESSION_DIR_TTL_DAYS + 1);

      const result = executor.execute(createJob());

      // Locked session should be retained, not removed
      expect(result.stdout).toBe('GC complete: removed 0 session(s), retained 1.');
    });

    it('removes a stale session directory with a dead PID lock file', () => {
      const sessionDir = makeDir('stale-locked-session');

      // Use max signed 32-bit PID as a deterministic non-existent PID.
      // This avoids flaky assumptions like "999999 is always dead".
      const lockInfo = {
        pid: 2147483647,
        job_id: 'job-dead-001',
        locked_at: new Date().toISOString(),
      };
      writeFileSync(join(sessionDir, '.lock'), JSON.stringify(lockInfo, null, 2));

      // Set age after writing the lock file so directory mtime is old
      setDirAge(sessionDir, TEST_SESSION_DIR_TTL_DAYS + 1);

      const result = executor.execute(createJob());

      // Stale lock (dead PID) should not protect the directory
      expect(result.stdout).toBe('GC complete: removed 1 session(s), retained 0.');
    });

    it('removes a stale session directory with no lock file (normal age-based behavior unchanged)', () => {
      const sessionDir = makeDir('no-lock-session');
      setDirAge(sessionDir, TEST_SESSION_DIR_TTL_DAYS + 1);

      const result = executor.execute(createJob());

      expect(result.stdout).toBe('GC complete: removed 1 session(s), retained 0.');
    });
  });

});
