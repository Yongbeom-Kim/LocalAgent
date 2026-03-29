import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { DEFAULT_API_URL } from '@local-agent/shared';

const mockFetch = vi.fn();

import * as submitModule from '../commands/submit';

describe('submitTask', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns success with taskType and submittedAt on 201', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'test prompt',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    const result = await submitModule.submitTask({
      payload: 'test prompt',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: true,
      taskType: 'generic',
      submittedAt: '2026-03-26T10:00:00.000Z',
    });
  });

  it('sends correct request body and headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_id: 'task-123',
        task_type: 'code-review',
        payload: 'review this',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    await submitModule.submitTask({
      payload: 'review this',
      type: 'code-review',
      apiUrl: 'http://example.com:3000',
    });

    expect(mockFetch).toHaveBeenCalledWith('http://example.com:3000/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_type: 'code-review',
        payload: 'review this',
      }),
    });
  });

  it('returns error on HTTP 503', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => 'server busy',
    });

    const result = await submitModule.submitTask({
      payload: 'test',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: '503 Service Unavailable — server busy',
    });
  });

  it('returns error on HTTP 400', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '',
    });

    const result = await submitModule.submitTask({
      payload: 'test',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: '400 Bad Request',
    });
  });

  it('returns connection error when fetch throws ECONNREFUSED', async () => {
    const cause = { code: 'ECONNREFUSED' };
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed', { cause }));

    const result = await submitModule.submitTask({
      payload: 'test',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: 'connection refused (http://localhost:3000/tasks)',
    });
  });

  it('returns generic network error when fetch throws without ECONNREFUSED', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await submitModule.submitTask({
      payload: 'test',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: 'network error (http://localhost:3000/tasks)',
    });
  });

  it('returns invalid response error when success body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    const result = await submitModule.submitTask({
      payload: 'test',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: 'invalid response from server (non-JSON body)',
    });
  });
});

describe('registerSubmitCommand', () => {
  const originalApiUrl = process.env.API_URL;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.API_URL;
  });

  afterEach(() => {
    if (originalApiUrl === undefined) {
      delete process.env.API_URL;
    } else {
      process.env.API_URL = originalApiUrl;
    }
    vi.restoreAllMocks();
  });

  it('wires explicit apiUrl from CLI options into submitTask', async () => {
    const submitTaskSpy = vi.fn().mockResolvedValue({
      success: true,
      taskType: 'generic',
      submittedAt: '2026-03-26T10:00:00.000Z',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const program = new Command();
    submitModule.registerSubmitCommand(program, submitTaskSpy);

    await program.parseAsync(['submit', '--payload', 'test prompt', '--api-url', 'http://example.com:3000'], {
      from: 'user',
    });

    expect(submitTaskSpy).toHaveBeenCalledWith({
      payload: 'test prompt',
      type: 'generic',
      apiUrl: 'http://example.com:3000',
    });
    expect(logSpy).toHaveBeenCalledWith('Task submitted successfully.');
  });

  it('uses DEFAULT_API_URL when apiUrl option and API_URL env are unset', async () => {
    const submitTaskSpy = vi.fn().mockResolvedValue({
      success: true,
      taskType: 'generic',
      submittedAt: '2026-03-26T10:00:00.000Z',
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const program = new Command();
    submitModule.registerSubmitCommand(program, submitTaskSpy);

    await program.parseAsync(['submit', '--payload', 'test prompt'], {
      from: 'user',
    });

    expect(submitTaskSpy).toHaveBeenCalledWith({
      payload: 'test prompt',
      type: 'generic',
      apiUrl: DEFAULT_API_URL,
    });
  });
});
