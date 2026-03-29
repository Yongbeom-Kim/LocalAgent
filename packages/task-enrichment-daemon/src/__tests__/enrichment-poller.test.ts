import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Task, JobSubmission } from '@local-agent/shared';
import { EnrichmentService } from '../enrichment-service';

const mockEnrich = vi.fn();

vi.mock('../enrichment-service', () => ({
  EnrichmentService: vi.fn().mockImplementation(() => ({
    enrich: mockEnrich,
  })),
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
    executor: 'claude_code',
    executor_model: 'opus',
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
    mockEnrich.mockReturnValue(jobSubmission);

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

  it('acks task and does not post job when enrichment fails (returns null)', async () => {
    const task = createTask();
    mockEnrich.mockReturnValue(null);

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ acknowledged: true }),
      });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('does not ack task when POST /jobs fails', async () => {
    const task = createTask();
    const jobSubmission = createJobSubmission();
    mockEnrich.mockReturnValue(jobSubmission);

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
