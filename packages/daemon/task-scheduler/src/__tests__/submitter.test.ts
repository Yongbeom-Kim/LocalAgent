import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitScheduleByName } from '../submitter';

function makeSnapshotPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-submit-test-'));
  return join(dir, 'config.snapshot.json');
}

function writeSnapshot(snapshotPath: string): void {
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      schedules: [
        {
          name: 'daily-summary',
          cron: '0 9 * * 1-5',
          task: {
            task_type: 'generic',
            executor: 'claude',
            executor_model: 'sonnet',
            payload: 'daily summary payload',
          },
        },
      ],
    }),
  );
}

describe('submitScheduleByName', () => {
  const uuidMock = vi.hoisted(() => vi.fn(() => 'session-fixed-uuid'));

  vi.mock('uuid', () => ({
    v4: uuidMock,
  }));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads named schedule from snapshot and posts canonical /tasks with auth and fallback metadata', async () => {
    const snapshotPath = makeSnapshotPath();
    writeSnapshot(snapshotPath);

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ task_id: 'task-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await submitScheduleByName(
      {
        apiUrl: 'http://api:3000',
        apiAuthEnabled: true,
        apiAuthToken: 'scheduler-token',
        configSnapshotPath: snapshotPath,
      },
      'daily-summary',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api:3000/tasks');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer scheduler-token',
    });

    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.task_type).toBe('generic');
    expect(body.executor).toBe('claude');
    expect(body.executor_model).toBe('sonnet');
    expect(body.payload).toBe('daily summary payload');
    expect(body.session_id).toBe('session-fixed-uuid');
    expect(body.session).toEqual({
      fallbackSeedText: 'daily summary payload',
      fallbackOrigin: 'scheduler',
    });
  });

  it('omits auth header when api auth is disabled', async () => {
    const snapshotPath = makeSnapshotPath();
    writeSnapshot(snapshotPath);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await submitScheduleByName(
      {
        apiUrl: 'http://api:3000',
        apiAuthEnabled: false,
        configSnapshotPath: snapshotPath,
      },
      'daily-summary',
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(init.headers).not.toMatchObject({ Authorization: expect.any(String) });
  });

  it('throws when schedule is not found', async () => {
    const snapshotPath = makeSnapshotPath();
    writeSnapshot(snapshotPath);
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      submitScheduleByName(
        {
          apiUrl: 'http://api:3000',
          apiAuthEnabled: true,
          apiAuthToken: 'scheduler-token',
          configSnapshotPath: snapshotPath,
        },
        'missing',
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('throws on non-success API response', async () => {
    const snapshotPath = makeSnapshotPath();
    writeSnapshot(snapshotPath);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 500, statusText: 'Internal Server Error' })));

    await expect(
      submitScheduleByName(
        {
          apiUrl: 'http://api:3000',
          apiAuthEnabled: true,
          apiAuthToken: 'scheduler-token',
          configSnapshotPath: snapshotPath,
        },
        'daily-summary',
      ),
    ).rejects.toThrow(/failed to submit scheduled task/i);
  });
});
