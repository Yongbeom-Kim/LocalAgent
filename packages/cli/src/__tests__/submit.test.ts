import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitTask } from '../commands/submit';

const mockFetch = vi.fn();

describe('submitTask', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success with taskType and submittedAt on 201', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_type: 'generic',
        payload: 'test prompt',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    const result = await submitTask({
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
        task_type: 'code-review',
        payload: 'review this',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    await submitTask({
      payload: 'review this',
      type: 'code-review',
      apiUrl: 'http://example.com:3000',
    });

    expect(mockFetch).toHaveBeenCalledWith('http://example.com:3000/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_type: 'code-review', payload: 'review this' }),
    });
  });

  it('returns error on HTTP 503', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const result = await submitTask({
      payload: 'test',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: '503 Service Unavailable',
    });
  });

  it('returns error on HTTP 400', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    });

    const result = await submitTask({
      payload: 'test',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: '400 Bad Request',
    });
  });

  it('returns connection error when fetch throws', async () => {
    const cause = { code: 'ECONNREFUSED' };
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed', { cause }));

    const result = await submitTask({
      payload: 'test',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: 'connection refused (http://localhost:3000/tasks)',
    });
  });
});
