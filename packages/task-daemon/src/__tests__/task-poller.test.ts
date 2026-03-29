import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Job, TaskResultSubmission } from '@local-agent/shared';
import { TaskOrchestrator } from '../core/task-orchestrator';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';

const mockResultSubmission: TaskResultSubmission = {
  job_id: 'job-456',
  task_id: 'abc-123',
  status: 'success',
  exit_code: 0,
  stdout: 'result output',
  stderr: '',
};

const mockClaudeExecute = vi.fn().mockResolvedValue(mockResultSubmission);

vi.mock('../adapters/claude-cli-executor', () => {
  return {
    ClaudeCliExecutor: vi.fn(function (this: { execute: typeof mockClaudeExecute }) {
      this.execute = mockClaudeExecute;
    }),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'abc-123',
    task_type: 'generic',
    payload: 'hello',
    executor: 'claude_code',
    executor_model: 'opus',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    ...overrides,
  };
}

import { TaskPoller } from '../task-poller';

describe('TaskPoller', () => {
  let poller: TaskPoller;

  beforeEach(() => {
    mockFetch.mockClear();
    mockClaudeExecute.mockClear().mockResolvedValue(mockResultSubmission);
    vi.mocked(ClaudeCliExecutor).mockClear();
    poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator());
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches job, executes, posts result, then acks', async () => {
      const job = createJob();

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job),
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

      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/jobs/next');
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mockResultSubmission),
      });
      expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/jobs/job-456/ack', {
        method: 'POST',
      });
    });

    it('still acks job even if result POST fails', async () => {
      const job = createJob();

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job),
        })
        .mockResolvedValueOnce({
          status: 500,
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/jobs/job-456/ack', {
        method: 'POST',
      });
    });

    it('still acks job even if result POST throws', async () => {
      const job = createJob();

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job),
        })
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/jobs/job-456/ack', {
        method: 'POST',
      });
    });

    it('does nothing when queue is empty (204)', async () => {
      mockFetch.mockResolvedValueOnce({ status: 204 });
      await poller.pollOnce();
      expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    });

    it('does not post result or ack when executor is unknown', async () => {
      const job = createJob({ executor: 'invalid' as never });
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(job),
      });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});
