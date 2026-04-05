import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskResult } from '@local-agent/shared';

const mockNotify = vi.fn().mockResolvedValue(undefined);
const mockPhaseNotify = vi.fn().mockResolvedValue(undefined);

vi.mock('../adapters/lark-notifier', () => ({
  LarkNotifier: vi.fn().mockImplementation(() => ({
    notify: mockNotify,
  })),
}));

vi.mock('../adapters/lark-phase-notifier', () => ({
  LarkPhaseNotifier: vi.fn().mockImplementation(() => ({
    notify: mockPhaseNotify,
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { LarkPoller } from '../lark-poller';
import { LarkNotifier } from '../adapters/lark-notifier';
import { LarkPhaseNotifier } from '../adapters/lark-phase-notifier';

const sampleResult: TaskResult = {
  result_id: 'res-1',
  job_id: 'job-456',
  task_id: 'task-123',
  task_type: 'generic',
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
    mockPhaseNotify.mockResolvedValue(undefined);
    const notifier = new LarkNotifier('app-id', 'app-secret', 'user-123');
    const phaseNotifier = new LarkPhaseNotifier({
      getTenantAccessToken: vi.fn().mockResolvedValue('token'),
    });
    poller = new LarkPoller('http://localhost:3000', 'lark-messages', notifier, phaseNotifier);
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches result event, sends final notification, then acks', async () => {
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

      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/results/next/lark-messages');
      expect(mockNotify).toHaveBeenCalledWith(sampleResult);
      expect(mockPhaseNotify).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results/lark-messages/res-1/ack', {
        method: 'POST',
      });
    });

    it('dispatches phase events and acks by event_id', async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({
            event_kind: 'phase',
            event: {
              event_id: 'evt-1',
              task_id: 'task-123',
              phase: 'received',
              task_source: { source: 'lark', message_id: 'om_1' },
            },
          }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      expect(mockPhaseNotify).toHaveBeenCalledWith(expect.objectContaining({
        event_id: 'evt-1',
        phase: 'received',
      }));
      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results/lark-messages/evt-1/ack', {
        method: 'POST',
      });
    });

    it('ignores obvious phase regressions while still acking', async () => {
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({
            event_kind: 'phase',
            event: {
              event_id: 'evt-exec',
              task_id: 'task-123',
              phase: 'executing',
              task_source: { source: 'lark', message_id: 'om_1' },
            },
          }),
        })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({
            event_kind: 'phase',
            event: {
              event_id: 'evt-queued',
              task_id: 'task-123',
              phase: 'queued',
              task_source: { source: 'lark', message_id: 'om_1' },
            },
          }),
        })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

      await poller.pollOnce();
      await poller.pollOnce();

      expect(mockPhaseNotify).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenNthCalledWith(4, 'http://localhost:3000/results/lark-messages/evt-queued/ack', {
        method: 'POST',
      });
    });

    it('does nothing when queue is empty (204)', async () => {
      mockFetch.mockResolvedValueOnce({ status: 204 });
      await poller.pollOnce();
      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockPhaseNotify).not.toHaveBeenCalled();
    });

    it('handles fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(poller.pollOnce()).resolves.toBeUndefined();
    });
  });
});

