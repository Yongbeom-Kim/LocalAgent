import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Poller } from '../poller';
import { Task } from '@local-agent/shared';
import { TaskOrchestrator } from '../core/task-orchestrator';
import { TaskExecutor } from '../ports/task-executor';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Poller', () => {
  let poller: Poller;
  let mockExecutor: TaskExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutor = { execute: vi.fn().mockResolvedValue(undefined) };
    const orchestrator = new TaskOrchestrator(mockExecutor);
    poller = new Poller('http://localhost:3000', orchestrator);
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches next task and calls orchestrator + ack when task available', async () => {
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
      expect(mockExecutor.execute).toHaveBeenCalledWith(task);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks/abc-123/ack', {
        method: 'POST',
      });
    });

    it('does nothing when queue is empty (204)', async () => {
      mockFetch.mockResolvedValueOnce({ status: 204 });
      await poller.pollOnce();
      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      // Should not throw
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});
