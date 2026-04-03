import { afterEach, describe, expect, it } from 'vitest';
import { AddressInfo } from 'node:net';
import { createStatusServer } from '../task-daemon';

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
