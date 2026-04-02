import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TaskSubmitter } from '../adapters/task-submitter';

describe('TaskSubmitter', () => {
  let submitter: TaskSubmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    submitter = new TaskSubmitter('http://localhost:3000');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts TaskSubmission and returns task_id on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({ task_id: 'task-abc', task_type: 'generic', payload: 'hello' }),
    });

    const result = await submitter.submit('generic', 'hello', undefined, 'claude', 'sonnet');
    expect(result).toBe('task-abc');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/tasks',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_type: 'generic',
          payload: 'hello',
          executor: 'claude',
          executor_model: 'sonnet',
        }),
      }),
    );
  });

  it('retries on failure with exponential backoff and returns null after max retries', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'));

    const promise = submitter.submit('generic', 'hello', undefined, 'claude', 'sonnet');

    // Advance through retry delays: 1s, 2s, 4s
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    const result = await promise;
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('succeeds on second attempt after first failure', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ task_id: 'task-xyz' }),
      });

    const promise = submitter.submit('generic', 'retry test', undefined, 'claude', 'sonnet');
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe('task-xyz');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns null on non-ok response after retries', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) });

    const promise = submitter.submit('generic', 'fail', undefined, 'claude', 'sonnet');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    const result = await promise;

    expect(result).toBeNull();
  });

  it('sends the provided task_type in the request body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ task_id: 'task-abc' }),
    });

    await submitter.submit('code_review', 'review this code', undefined, 'cursor', 'auto');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.task_type).toBe('code_review');
    expect(body.payload).toBe('review this code');
    expect(body.executor).toBe('cursor');
    expect(body.executor_model).toBe('auto');
  });
});
