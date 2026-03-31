import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('posts TaskSubmission and returns task_id on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () =>
        Promise.resolve({ task_id: 'task-abc', task_type: 'generic', payload: 'hello' }),
    });

    const result = await submitter.submit('hello');
    expect(result).toBe('task-abc');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/tasks',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_type: 'generic', payload: 'hello' }),
      }),
    );
  });

  it('retries on failure with exponential backoff and returns null after max retries', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'));

    const promise = submitter.submit('hello');

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

    const promise = submitter.submit('retry test');
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

    const promise = submitter.submit('fail');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    const result = await promise;

    expect(result).toBeNull();
  });
});
