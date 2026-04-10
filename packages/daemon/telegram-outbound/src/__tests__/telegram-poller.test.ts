import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskResult } from '@local-agent/shared';

const mockNotify = vi.fn().mockResolvedValue(undefined);
const mockNotifyStatus = vi.fn().mockResolvedValue(undefined);

vi.mock('../adapters/telegram-notifier', () => ({
  TelegramNotifier: vi.fn().mockImplementation(() => ({
    notify: mockNotify,
    notifyStatus: mockNotifyStatus,
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
    const notifier = new TelegramNotifier('bot123:ABC', '-100456789');
    poller = new TelegramPoller('http://localhost:3000', 'telegram-messages', notifier, 'secret');
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

      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/results/next/telegram-messages', {
        headers: { Authorization: 'Bearer secret' },
      });
      expect(mockNotify).toHaveBeenCalledWith(sampleResult);
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results/telegram-messages/res-1/ack', {
        headers: { Authorization: 'Bearer secret' },
        method: 'POST',
      });
    });

    it('routes phase events to status notifier with session_id only and acks by event_id', async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({
            event_kind: 'phase',
            event: {
              event_id: 'evt-1',
              task_id: 'task-123',
              session_id: 'session-123',
              phase: 'queued',
            },
          }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockNotifyStatus).toHaveBeenCalledWith({
        sessionId: 'session-123',
        text: '*Status:* queued',
      });
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results/telegram-messages/evt-1/ack', {
        headers: { Authorization: 'Bearer secret' },
        method: 'POST',
      });
    });

    it('routes all result events through notifier.notify', async () => {
      const bridgedResult: TaskResult = {
        ...sampleResult,
        session_id: 'session-123',
        task_source: { source: 'lark', message_id: 'om_1' },
      };

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ event_kind: 'result', event: bridgedResult }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockNotify).toHaveBeenCalledWith(bridgedResult);
    });

    it('does nothing when queue is empty (204)', async () => {
      mockFetch.mockResolvedValueOnce({ status: 204 });
      await poller.pollOnce();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('bursts on backlog and stops after a 204', async () => {
      const nextResult: TaskResult = {
        ...sampleResult,
        result_id: 'res-2',
        job_id: 'job-457',
        task_id: 'task-124',
      };

      (poller as unknown as { running: boolean }).running = true;
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ event_kind: 'result', event: sampleResult }),
        })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ event_kind: 'result', event: nextResult }),
        })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
        .mockResolvedValueOnce({ status: 204 });

      await poller.runBurstCycle();

      expect(mockNotify).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/results/next/telegram-messages', {
        headers: { Authorization: 'Bearer secret' },
      });
      expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/results/next/telegram-messages', {
        headers: { Authorization: 'Bearer secret' },
      });
      expect(mockFetch).toHaveBeenNthCalledWith(5, 'http://localhost:3000/results/next/telegram-messages', {
        headers: { Authorization: 'Bearer secret' },
      });
    });

    it('continues the burst after a fetched result even if downstream delivery fails', async () => {
      const nextResult: TaskResult = {
        ...sampleResult,
        result_id: 'res-2',
        job_id: 'job-457',
        task_id: 'task-124',
      };

      (poller as unknown as { running: boolean }).running = true;
      mockNotify.mockRejectedValueOnce(new Error('delivery failed'));
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ event_kind: 'result', event: sampleResult }),
        })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ event_kind: 'result', event: nextResult }),
        })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
        .mockResolvedValueOnce({ status: 204 });

      await poller.runBurstCycle();

      expect(mockNotify).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/results/next/telegram-messages', {
        headers: { Authorization: 'Bearer secret' },
      });
      expect(mockFetch).toHaveBeenNthCalledWith(5, 'http://localhost:3000/results/next/telegram-messages', {
        headers: { Authorization: 'Bearer secret' },
      });
    });

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});
