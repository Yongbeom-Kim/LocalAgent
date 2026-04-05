import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskResult } from '@local-agent/shared';

const mockNotify = vi.fn().mockResolvedValue(undefined);

vi.mock('../adapters/telegram-notifier', () => ({
  TelegramNotifier: vi.fn().mockImplementation(() => ({
    notify: mockNotify,
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TelegramPoller } from '../telegram-poller';
import { TelegramNotifier } from '../adapters/telegram-notifier';

const sampleResult: TaskResult = {
  result_id: 'res-1',
  job_id: 'job-456',
  task_id: 'task-123',
  task_type: 'generic',
  status: 'success',
  exit_code: 0,
  stdout: 'output',
  stderr: '',
  completed_at: '2026-03-29T00:00:00.000Z',
};

describe('TelegramPoller', () => {
  let poller: TelegramPoller;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotify.mockResolvedValue(undefined);
    const notifier = new TelegramNotifier('bot123:ABC', '456789');
    poller = new TelegramPoller('http://localhost:3000', 'telegram-messages', notifier);
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches result, sends notification, then acks', async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ event_kind: 'result', event: sampleResult }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/results/next/telegram-messages');
      expect(mockNotify).toHaveBeenCalledWith(sampleResult);
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results/telegram-messages/res-1/ack', {
        method: 'POST',
      });
    });

    it('ignores phase events and acks by event_id', async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({
            event_kind: 'phase',
            event: {
              event_id: 'evt-1',
              task_id: 'task-123',
              phase: 'queued',
            },
          }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results/telegram-messages/evt-1/ack', {
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
