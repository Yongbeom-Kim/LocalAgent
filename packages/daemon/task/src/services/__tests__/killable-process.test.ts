import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { killProcessTree } from '../killable-process';

class MockChild extends EventEmitter {
  pid?: number;
  kill = vi.fn().mockReturnValue(true);

  constructor(pid = 4321) {
    super();
    this.pid = pid;
  }
}

describe('killProcessTree', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SIGTERM immediately and resolves when the child exits during the grace window', async () => {
    const child = new MockChild();
    const sendSignal = vi.fn((_pid: number, _signal: 'SIGTERM' | 'SIGKILL') => {});

    const resultPromise = killProcessTree({
      child,
      graceMs: 15_000,
      getStdout: () => 'partial stdout',
      getStderr: () => 'partial stderr',
      sendSignal,
      now: () => 100,
    });

    child.emit('close', 143, 'SIGTERM');
    const result = await resultPromise;

    expect(sendSignal).toHaveBeenCalledWith(-4321, 'SIGTERM');
    expect(result.signalPath).toBe('SIGTERM -> exited');
    expect(result.stdout).toBe('partial stdout');
    expect(result.stderr).toBe('partial stderr');
  });

  it('escalates to SIGKILL after the grace timeout', async () => {
    let now = 100;
    const child = new MockChild();
    const sendSignal = vi.fn((_pid: number, _signal: 'SIGTERM' | 'SIGKILL') => {});

    const resultPromise = killProcessTree({
      child,
      graceMs: 15_000,
      getStdout: () => 'stdout before kill',
      getStderr: () => '',
      sendSignal,
      now: () => now,
    });

    now = 15_100;
    await vi.advanceTimersByTimeAsync(15_000);
    child.emit('close', null, 'SIGKILL');

    const result = await resultPromise;

    expect(sendSignal).toHaveBeenNthCalledWith(1, -4321, 'SIGTERM');
    expect(sendSignal).toHaveBeenNthCalledWith(2, -4321, 'SIGKILL');
    expect(result.signalPath).toBe('SIGTERM -> SIGKILL');
    expect(result.waitDurationMs).toBe(15000);
  });

  it('falls back to child.kill on platforms without process-group signaling', async () => {
    const child = new MockChild(4321);
    child.pid = undefined;

    const resultPromise = killProcessTree({
      child,
      graceMs: 15_000,
      getStdout: () => '',
      getStderr: () => '',
      sendSignal: vi.fn(),
      now: () => 0,
    });

    child.emit('close', 143, 'SIGTERM');
    const result = await resultPromise;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.signalPath).toBe('SIGTERM -> exited');
  });
});
