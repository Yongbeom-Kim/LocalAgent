import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Task, JobSubmission } from '@local-agent/shared';
import { EnrichmentService, EnrichmentResult } from '../enrichment-service';
import { ThreadContextFetcher } from '../adapters/thread-context-fetcher';

const mockEnrich = vi.fn();
const mockGetValidTaskTypes = vi.fn().mockReturnValue(new Set(['deploy', 'code_review', 'default']));

vi.mock('../enrichment-service', () => ({
  EnrichmentService: vi.fn().mockImplementation(function () {
    this.enrich = mockEnrich;
    this.getValidTaskTypes = mockGetValidTaskTypes;
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
        task_type: 'code_review',
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
        task_type: 'code_review',
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
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({ threadContext: 'user: fix CI', inheritedTaskType: null });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockThreadFetcher.fetchThreadContext).toHaveBeenCalledWith('om_msg1', expect.any(Set));
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

  it('overrides task_type to inherited value when current is generic', async () => {
    const task = createTask({
      task_type: 'generic',
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'follow up',
    });
    const jobSubmission = createJobSubmission({
      task_type: 'deploy',
      payload: '--- Thread Context ---\nuser: deploy the app\nassistant: Job abc — success\n--- Current Message ---\nfollow up',
    });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: deploy the app\nassistant: Job abc — success',
      inheritedTaskType: 'deploy',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).toHaveBeenCalledWith(
      expect.objectContaining({ task_type: 'deploy' }),
    );
  });

  it('does not override task_type when current is not generic', async () => {
    const task = createTask({
      task_type: 'code_review',
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'review this',
    });
    const jobSubmission = createJobSubmission({ task_type: 'code_review' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: review code\nassistant: Job abc — success',
      inheritedTaskType: 'deploy',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).toHaveBeenCalledWith(
      expect.objectContaining({ task_type: 'code_review' }),
    );
  });

  it('keeps generic task_type when no inherited type found', async () => {
    const task = createTask({
      task_type: 'generic',
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'hello',
    });
    const jobSubmission = createJobSubmission({ task_type: 'generic' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: hello\nassistant: Job abc — success',
      inheritedTaskType: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).toHaveBeenCalledWith(
      expect.objectContaining({ task_type: 'generic' }),
    );
  });
});
