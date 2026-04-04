import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MachineLockManager } from '../machine-lock';

const TEST_BASE_DIR = `/tmp/local-agent-machine-lock-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

describe('MachineLockManager', () => {
  let lockPath: string;

  beforeEach(() => {
    rmSync(TEST_BASE_DIR, { recursive: true, force: true });
    lockPath = join(TEST_BASE_DIR, 'task-daemon.lock');
  });

  afterEach(() => {
    rmSync(TEST_BASE_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('acquires when no lock file exists', () => {
    const manager = new MachineLockManager({ lockPath, env: {} });

    expect(manager.acquire()).toEqual({ acquired: true });
    expect(existsSync(lockPath)).toBe(true);

    const lockInfo = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lockInfo.pid).toBe(process.pid);
    expect(lockInfo.locked_at).toBeDefined();
  });

  it('creates the parent directory when missing', () => {
    const nestedLockPath = join(TEST_BASE_DIR, 'nested', 'task-daemon.lock');
    const manager = new MachineLockManager({ lockPath: nestedLockPath, env: {} });

    expect(manager.acquire()).toEqual({ acquired: true });
    expect(existsSync(nestedLockPath)).toBe(true);
  });

  it('returns duplicate-start failure for a live foreign pid', () => {
    mkdirSync(TEST_BASE_DIR, { recursive: true });
    const otherPid = process.pid + 1000;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: otherPid, locked_at: new Date().toISOString() }),
    );

    const originalKill = process.kill;
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (pid === otherPid && (signal === 0 || signal === undefined)) {
        return true;
      }
      return originalKill.call(process, pid, signal);
    });

    const manager = new MachineLockManager({ lockPath, env: {} });

    expect(manager.acquire()).toEqual({ acquired: false, holderPid: otherPid, lockPath });
  });

  it('overwrites stale lock files when pid is dead', () => {
    mkdirSync(TEST_BASE_DIR, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, locked_at: new Date().toISOString() }),
    );

    const manager = new MachineLockManager({ lockPath, env: {} });

    expect(manager.acquire()).toEqual({ acquired: true });

    const lockInfo = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lockInfo.pid).toBe(process.pid);
  });

  it('overwrites corrupt lock files', () => {
    mkdirSync(TEST_BASE_DIR, { recursive: true });
    writeFileSync(lockPath, 'not-json');
    const manager = new MachineLockManager({ lockPath, env: {} });

    expect(manager.acquire()).toEqual({ acquired: true });

    const lockInfo = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(lockInfo.pid).toBe(process.pid);
  });

  it('is idempotent for the same pid', () => {
    const manager = new MachineLockManager({ lockPath, env: {} });

    expect(manager.acquire()).toEqual({ acquired: true });
    expect(manager.acquire()).toEqual({ acquired: true });
  });

  it('bypasses lock operations when TASK_DAEMON_DISABLE_MACHINE_LOCK=1', () => {
    const manager = new MachineLockManager({
      lockPath,
      env: { TASK_DAEMON_DISABLE_MACHINE_LOCK: '1' },
    });

    expect(manager.acquire()).toEqual({ acquired: true });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('removes the lock file on release when enabled', () => {
    const manager = new MachineLockManager({ lockPath, env: {} });
    manager.acquire();

    manager.release();

    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not remove a lock file owned by another process', () => {
    mkdirSync(TEST_BASE_DIR, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid + 1000, locked_at: new Date().toISOString() }),
    );
    const manager = new MachineLockManager({ lockPath, env: {} });

    manager.release();

    expect(existsSync(lockPath)).toBe(true);
  });

  it('removes a corrupt lock file during release best-effort', () => {
    mkdirSync(TEST_BASE_DIR, { recursive: true });
    writeFileSync(lockPath, 'not-json');
    const manager = new MachineLockManager({ lockPath, env: {} });

    manager.release();

    expect(existsSync(lockPath)).toBe(false);
  });

  it('is a no-op on release when disabled', () => {
    const manager = new MachineLockManager({
      lockPath,
      env: { TASK_DAEMON_DISABLE_MACHINE_LOCK: '1' },
    });

    expect(() => manager.release()).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);
  });
});
