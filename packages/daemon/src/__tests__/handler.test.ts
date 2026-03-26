import { describe, it, expect, vi } from 'vitest';
import { handleTask } from '../handler';
import { Task } from '@local-agent/shared';

describe('handleTask', () => {
  it('logs the task and returns without error', async () => {
    const task: Task = {
      task_id: 'test-123',
      task_type: 'generic',
      payload: 'hello world',
      submitted_at: '2026-03-26T00:00:00.000Z',
    };
    // Should not throw
    await expect(handleTask(task)).resolves.toBeUndefined();
  });
});
