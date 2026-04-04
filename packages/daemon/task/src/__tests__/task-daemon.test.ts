import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import { createStatusServer, startTaskDaemon } from '../task-daemon';

const servers: Array<ReturnType<typeof createStatusServer>> = [];

async function startServer(activeSessions: Set<string>) {
  const server = createStatusServer({
    isSessionActive: (sessionId: string) => activeSessions.has(sessionId),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

class FakeServer extends EventEmitter {
  listen = vi.fn((_port?: number, cb?: () => void) => {
    queueMicrotask(() => {
      this.emit('listening');
      cb?.();
    });
    return this;
  });

  close = vi.fn((cb?: (err?: Error) => void) => {
    cb?.();
    return this;
  });
}

describe('createStatusServer', () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
      ),
    );
  });

  it('returns running false for an unknown session', async () => {
    const { baseUrl } = await startServer(new Set());

    const res = await fetch(`${baseUrl}/status/session-missing`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      session_id: 'session-missing',
      running: false,
    });
  });

  it('returns running true for an active session', async () => {
    const { baseUrl } = await startServer(new Set(['session-active']));

    const res = await fetch(`${baseUrl}/status/session-active`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      session_id: 'session-active',
      running: true,
    });
  });
});

describe('startTaskDaemon', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a noop machine lock when the disable env var is enabled', async () => {
    const fakeServer = new FakeServer();
    const fakePoller = {
      start: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
      isSessionActive: vi.fn().mockReturnValue(false),
    };
    const createMachineLock = vi.fn(() => ({
      acquire: vi.fn().mockReturnValue({ acquired: true }),
      release: vi.fn(),
    }));

    const running = await startTaskDaemon({
      loadConfig: () => ({
        apiUrl: 'http://localhost:3000',
        pollIntervalMs: 5000,
        logLevel: 'info',
        statusPort: 7070,
      }),
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }) as never,
      createJobEnvironment: vi.fn(() => ({})) as never,
      createOrchestrator: vi.fn(() => ({})) as never,
      createSessionLock: vi.fn(() => ({})) as never,
      createMachineLock,
      createPoller: vi.fn(() => fakePoller) as never,
      createStatusServer: vi.fn(() => fakeServer) as never,
      processObject: { env: { TASK_DAEMON_DISABLE_MACHINE_LOCK: '1' }, on: vi.fn() },
      exit: vi.fn() as never,
    });

    expect(createMachineLock).not.toHaveBeenCalled();
    expect(fakeServer.listen).toHaveBeenCalledTimes(1);
    expect(fakePoller.start).toHaveBeenCalledTimes(1);

    await running.shutdown();
  });

  it('does not start status server or poller when machine lock is already held', async () => {
    const fakeServer = new FakeServer();
    const fakePoller = {
      start: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
      isSessionActive: vi.fn().mockReturnValue(false),
    };

    await expect(
      startTaskDaemon({
        loadConfig: () => ({
          apiUrl: 'http://localhost:3000',
          pollIntervalMs: 5000,
          logLevel: 'info',
          statusPort: 7070,
        }),
        createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }) as never,
        createJobEnvironment: vi.fn() as never,
        createOrchestrator: vi.fn() as never,
        createSessionLock: vi.fn() as never,
        createMachineLock: () => ({
          acquire: vi.fn().mockReturnValue({ acquired: false, holderPid: 4321, lockPath: '/tmp/task-daemon.lock' }),
          release: vi.fn(),
        }),
        createPoller: vi.fn(() => fakePoller) as never,
        createStatusServer: vi.fn(() => fakeServer) as never,
        processObject: { env: {}, on: vi.fn() },
        exit: vi.fn() as never,
      }),
    ).rejects.toThrow(/only one task-daemon/i);

    expect(fakeServer.listen).not.toHaveBeenCalled();
    expect(fakePoller.start).not.toHaveBeenCalled();
  });

  it('releases machine lock if startup fails after acquisition', async () => {
    const fakeServer = new FakeServer();
    fakeServer.listen.mockImplementationOnce(() => {
      queueMicrotask(() => fakeServer.emit('error', new Error('bind failed')));
      return fakeServer;
    });

    const fakePoller = {
      start: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
      isSessionActive: vi.fn().mockReturnValue(false),
    };
    const machineLock = {
      acquire: vi.fn().mockReturnValue({ acquired: true }),
      release: vi.fn(),
    };

    await expect(
      startTaskDaemon({
        loadConfig: () => ({
          apiUrl: 'http://localhost:3000',
          pollIntervalMs: 5000,
          logLevel: 'info',
          statusPort: 7070,
        }),
        createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }) as never,
        createJobEnvironment: vi.fn(() => ({})) as never,
        createOrchestrator: vi.fn(() => ({})) as never,
        createSessionLock: vi.fn(() => ({})) as never,
        createMachineLock: () => machineLock,
        createPoller: vi.fn(() => fakePoller) as never,
        createStatusServer: vi.fn(() => fakeServer) as never,
        processObject: { env: {}, on: vi.fn() },
        exit: vi.fn() as never,
      }),
    ).rejects.toThrow(/bind failed/);

    expect(machineLock.release).toHaveBeenCalledTimes(1);
    expect(fakePoller.start).not.toHaveBeenCalled();
  });

  it('releases machine lock on normal shutdown and shutdown is idempotent', async () => {
    const fakeServer = new FakeServer();
    const fakePoller = {
      start: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
      isSessionActive: vi.fn().mockReturnValue(false),
    };
    const machineLock = {
      acquire: vi.fn().mockReturnValue({ acquired: true }),
      release: vi.fn(),
    };

    const running = await startTaskDaemon({
      loadConfig: () => ({
        apiUrl: 'http://localhost:3000',
        pollIntervalMs: 5000,
        logLevel: 'info',
        statusPort: 7070,
      }),
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }) as never,
      createJobEnvironment: vi.fn(() => ({})) as never,
      createOrchestrator: vi.fn(() => ({})) as never,
      createSessionLock: vi.fn(() => ({})) as never,
      createMachineLock: () => machineLock,
      createPoller: vi.fn(() => fakePoller) as never,
      createStatusServer: vi.fn(() => fakeServer) as never,
      processObject: { env: {}, on: vi.fn() },
      exit: vi.fn() as never,
    });

    await running.shutdown();
    await running.shutdown();

    expect(fakeServer.close).toHaveBeenCalledTimes(1);
    expect(fakePoller.drain).toHaveBeenCalledTimes(1);
    expect(machineLock.release).toHaveBeenCalledTimes(1);
  });
});
