import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Task, JobSubmission } from '@local-agent/shared';
import { EnrichmentService, EnrichmentResult } from '../enrichment-service';
import { ThreadContextFetcher } from '../adapters/thread-context-fetcher';

const mockEnrich = vi.fn();

vi.mock('../enrichment-service', () => ({
  EnrichmentService: vi.fn().mockImplementation(function () {
    this.enrich = mockEnrich;
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this',
    submitted_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

function createJobSubmission(overrides?: Partial<JobSubmission>): JobSubmission {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this',
    executors: [
      { executor: 'claude_code', executor_model: 'opus' },
    ],
    submitted_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

import { EnrichmentPoller } from '../enrichment-poller';

describe('EnrichmentPoller', () => {
  let poller: EnrichmentPoller;

  beforeEach(() => {
    vi.clearAllMocks();
    const service = new EnrichmentService() as any;
    poller = new EnrichmentPoller('http://localhost:3000', service);
  });

  afterEach(() => {
    poller.stop();
  });

  it('fetches task, enriches, posts job, then acks task', async () => {
    const task = createTask();
    const jobSubmission = createJobSubmission();
    const enrichmentResult: EnrichmentResult = { type: 'enriched', job: jobSubmission };
    mockEnrich.mockReturnValue(enrichmentResult);

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      })
      .mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve({ job_id: 'job-456', ...jobSubmission }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ acknowledged: true }),
      });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/tasks/next');
    expect(mockEnrich).toHaveBeenCalledWith(task);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jobSubmission),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('does nothing when queue is empty (204)', async () => {
    mockFetch.mockResolvedValueOnce({ status: 204 });
    await poller.pollOnce();
    expect(mockEnrich).not.toHaveBeenCalled();
  });

  it('publishes failed result and acks task when enrichment rejects (no task_source)', async () => {
    const task = createTask();
    const rejectedResult: EnrichmentResult = { type: 'rejected', reason: 'Unknown task type "code_review"' };
    mockEnrich.mockReturnValue(rejectedResult);

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      })
      .mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve({ result_id: 'res-1' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ acknowledged: true }),
      });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        status: 'failure',
        exit_code: null,
        stdout: 'Unknown task type "code_review"',
        stderr: '',
      }),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('publishes failed result and acks task when enrichment rejects', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockEnrich.mockReturnValue({
      type: 'rejected',
      reason: 'Unknown task type "bad". Available types: generic, code_review',
    });

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      })
      .mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve({ result_id: 'res-1' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ acknowledged: true }),
      });

    await poller.pollOnce();

    // Verify POST /results with failure
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        status: 'failure',
        exit_code: null,
        stdout: 'Unknown task type "bad". Available types: generic, code_review',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
    // Verify task is acked
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('does not ack task when POST /jobs fails', async () => {
    const task = createTask();
    const jobSubmission = createJobSubmission();
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      })
      .mockResolvedValueOnce({
        status: 500,
      });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('handles fetch errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    await expect(poller.pollOnce()).resolves.toBeUndefined();
  });
});

describe('EnrichmentPoller with ThreadContextFetcher', () => {
  let poller: EnrichmentPoller;
  let mockThreadFetcher: { fetchThreadContext: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    const service = new EnrichmentService() as any;
    mockThreadFetcher = { fetchThreadContext: vi.fn() };
    poller = new EnrichmentPoller(
      'http://localhost:3000',
      service,
      mockThreadFetcher as unknown as ThreadContextFetcher,
    );
  });

  afterEach(() => {
    poller.stop();
  });

  it('prepends thread context to payload when task has lark source and thread exists', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'now fix the tests',
    });
    const jobSubmission = createJobSubmission({ payload: '--- Thread Context ---\nuser: fix CI\n--- Current Message ---\nnow fix the tests' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue('user: fix CI');

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockThreadFetcher.fetchThreadContext).toHaveBeenCalledWith('om_msg1');
    expect(mockEnrich).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: '--- Thread Context ---\nuser: fix CI\n--- Current Message ---\nnow fix the tests',
      }),
    );
  });

  it('does not modify payload when task has no task_source', async () => {
    const task = createTask({ payload: 'hello' });
    const jobSubmission = createJobSubmission({ payload: 'hello' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockThreadFetcher.fetchThreadContext).not.toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }));
  });

  it('does not modify payload when fetchThreadContext returns null', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'hello',
    });
    const jobSubmission = createJobSubmission({ payload: 'hello' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue(null);

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }));
  });
});
