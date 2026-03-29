import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskResult } from '@local-agent/shared';

const mockNotify = vi.fn().mockResolvedValue(undefined);

vi.mock('../adapters/lark-notifier', () => ({
  LarkNotifier: vi.fn().mockImplementation(() => ({
    notify: mockNotify,
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { LarkPoller } from '../lark-poller';
import { LarkNotifier } from '../adapters/lark-notifier';

const sampleResult: TaskResult = {
  result_id: 'res-1',
  job_id: 'job-456',
  task_id: 'task-123',
  status: 'success',
  exit_code: 0,
  stdout: 'output',
  stderr: '',
  completed_at: '2026-03-27T00:00:00.000Z',
};

describe('LarkPoller', () => {
  let poller: LarkPoller;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotify.mockResolvedValue(undefined);
    const notifier = new LarkNotifier('app-id', 'app-secret', 'user-123');
    poller = new LarkPoller('http://localhost:3000', 'lark-messages', notifier);
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches result, sends notification, then acks', async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(sampleResult),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/results/next/lark-messages');
      expect(mockNotify).toHaveBeenCalledWith(sampleResult);
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results/lark-messages/res-1/ack', {
        method: 'POST',
      });
    });

    it('does nothing when queue is empty (204)', async () => {
      mockFetch.mockResolvedValueOnce({ status: 204 });
      await poller.pollOnce();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});
