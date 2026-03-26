import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Poller } from '../poller';
import { Task } from '@local-agent/shared';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Poller', () => {
  let poller: Poller;
  const mockHandler = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    poller = new Poller('http://localhost:3000', mockHandler);
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches next task and calls handler + ack when task available', async () => {
      const task: Task = {
        task_id: 'abc-123',
        task_type: 'generic',
        payload: 'hello',
        submitted_at: '2026-03-26T00:00:00.000Z',
      };

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

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks/next');
      expect(mockHandler).toHaveBeenCalledWith(task);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks/abc-123/ack', {
        method: 'POST',
      });
    });

    it('does nothing when queue is empty (204)', async () => {
      mockFetch.mockResolvedValueOnce({ status: 204 });
      await poller.pollOnce();
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      // Should not throw
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});
