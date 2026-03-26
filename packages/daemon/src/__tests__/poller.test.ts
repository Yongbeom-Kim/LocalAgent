import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Poller } from '../poller';
import { Task } from '@local-agent/shared';
import { TaskOrchestrator } from '../core/task-orchestrator';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';

const mockClaudeExecute = vi.fn();

vi.mock('../adapters/claude-cli-executor', () => ({
  ClaudeCliExecutor: vi.fn().mockImplementation(() => ({
    execute: mockClaudeExecute,
  })),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'abc-123',
    task_type: 'generic',
    payload: 'hello',
    executor: 'claude_code',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('Poller', () => {
  let poller: Poller;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaudeExecute.mockResolvedValue(undefined);
    poller = new Poller('http://localhost:3000', new TaskOrchestrator());
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches next task and calls orchestrator + ack when task available', async () => {
      const task = createTask();

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
      expect(ClaudeCliExecutor).toHaveBeenCalledTimes(1);
      expect(mockClaudeExecute).toHaveBeenCalledWith(task);
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks/abc-123/ack', {
        method: 'POST',
      });
    });

    it('does nothing when queue is empty (204)', async () => {
      mockFetch.mockResolvedValueOnce({ status: 204 });
      await poller.pollOnce();
      expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    });

    it('does not ack when task executor is unknown', async () => {
      const task = createTask({ executor: 'invalid' as never });

      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(ClaudeCliExecutor).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalledWith('http://localhost:3000/tasks/abc-123/ack', {
        method: 'POST',
      });
    });

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});
