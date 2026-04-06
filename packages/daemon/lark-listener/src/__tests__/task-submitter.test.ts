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
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer listener-token',
        },
        body: JSON.stringify({
          task_type: 'generic',
          payload: 'hello',
          executor: 'claude',
          executor_model: 'sonnet',
        }),
      }),
    );
  });

  it('does not include executor routing for lark_inbound tasks', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ task_id: 'task-abc' }),
    });

    await submitter.submit('lark_inbound', '{"hello":true}', { source: 'lark', message_id: 'om_msg1' }, 'claude', 'sonnet');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      task_type: 'lark_inbound',
      payload: '{"hello":true}',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
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

  it('posts raw executor and model tokens for partial routing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ task_id: 'task-abc' }),
    });

    await submitter.submit('localagent', '', undefined, 'foo', 'bar');

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      task_type: 'localagent',
      payload: '',
      executor: 'foo',
      executor_model: 'bar',
    });
  });

  it('sends bearer auth header when publishing task phase to /results', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });

    await submitter.publishPhase({
      task_id: 'task-123',
      task_type: 'lark_inbound',
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

  it('does not retry task submissions on auth failures (401/403)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) });

    const result = await submitter.submit('generic', 'hello');

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, json: () => Promise.resolve({}) });

    const secondResult = await submitter.submit('generic', 'hello-again');

    expect(secondResult).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
