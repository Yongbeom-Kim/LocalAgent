import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskResult } from '@local-agent/shared';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TelegramNotifier } from '../adapters/telegram-notifier';

function createResult(overrides?: Partial<TaskResult>): TaskResult {
  return {
    result_id: 'res-1',
    job_id: 'job-456',
    task_id: 'task-123',
    task_type: 'generic',
    status: 'success',
    exit_code: 0,
    stdout: 'Task completed successfully',
    stderr: '',
    completed_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('TelegramNotifier', () => {
  let notifier: TelegramNotifier;

  beforeEach(() => {
    vi.clearAllMocks();
    notifier = new TelegramNotifier('bot123:ABC', '456789');
  });

  describe('validate', () => {
    it('calls getMe and returns bot username on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { username: 'test_bot' } }),
      });

      const username = await notifier.validate();

      expect(username).toBe('test_bot');
      expect(mockFetch).toHaveBeenCalledWith('https://api.telegram.org/botbot123:ABC/getMe');
    });

    it('throws when getMe returns ok: false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: false, description: 'Unauthorized' }),
      });

      await expect(notifier.validate()).rejects.toThrow('Telegram bot validation failed: Unauthorized');
    });

    it('throws when fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(notifier.validate()).rejects.toThrow('Network error');
    });
  });

  describe('notify', () => {
    it('sends message via sendMessage endpoint on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      await notifier.notify(createResult());

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.telegram.org/botbot123:ABC/sendMessage',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.chat_id).toBe('456789');
      expect(body.parse_mode).toBe('MarkdownV2');
      expect(body.text).toContain('job-456');
      expect(body.text).toContain('task-123');
      expect(body.text).toContain('success');
    });

    it('truncates long stdout to MAX_MESSAGE_CHARS', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      await notifier.notify(createResult({ stdout: 'x'.repeat(5000) }));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text.length).toBeLessThan(4096);
      expect(body.text).toContain('truncated');
    });

    it('retries up to 3 times on fetch failure then resolves', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'));

      await expect(notifier.notify(createResult())).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('succeeds on retry after initial failure', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        });

      await notifier.notify(createResult());
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws on sendMessage ok: false and retries', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: false, description: 'Bad Request' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: false, description: 'Bad Request' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ ok: false, description: 'Bad Request' }),
        });

      await expect(notifier.notify(createResult())).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('handles result with no output', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      await notifier.notify(createResult({ stdout: '', stderr: '' }));

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.text).toContain('No output');
    });
  });
});
