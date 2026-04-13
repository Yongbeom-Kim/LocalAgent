import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TaskSubmitter } from '../adapters/task-submitter';

describe('TaskSubmitter', () => {
  let submitter: TaskSubmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    submitter = new TaskSubmitter('http://localhost:3000', 'listener-token');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts canonical TaskSubmission and returns task_id on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ task_id: 'task-abc', task_type: 'generic', payload: 'hello' }),
    });

    const result = await submitter.submit(
      'generic',
      'hello',
      { sessionId: 'sess-1', contextRef: { platform: 'lark', root_key: 'om_root1' } },
      { source: 'lark', message_id: 'om_msg1' },
      'claude',
      'sonnet',
    );
    expect(result).toBe('task-abc');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/tasks',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer listener-token',
        },
        body: JSON.stringify({
          task_type: 'generic',
          payload: 'hello',
          executor: 'claude',
          executor_model: 'sonnet',
          task_source: { source: 'lark', message_id: 'om_msg1' },
          session_id: 'sess-1',
          context_ref: { platform: 'lark', root_key: 'om_root1' },
        }),
      }),
    );
  });

  it('retries on failure with exponential backoff and returns null after max retries', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'));

    const promise = submitter.submit('generic', 'hello', { sessionId: 'sess-1' }, undefined, 'claude', 'sonnet');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    const result = await promise;
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry task submissions on auth failures (401/403)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) });

    const result = await submitter.submit('generic', 'hello', { sessionId: 'sess-1' });

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends bearer auth header when publishing task phase to /results', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

    await submitter.publishPhase({
      task_id: 'task-123',
      task_type: 'code_review',
      session_id: 'session-1',
      phase: 'queued',
      metadata: { emitted_by: 'lark-listener' },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/results',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer listener-token',
        },
      }),
    );
  });
});
