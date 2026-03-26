import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Task } from '@local-agent/shared';
import { TaskOrchestrator } from '../task-orchestrator';
import { TaskExecutor } from '../../ports/task-executor';

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('TaskOrchestrator', () => {
  let mockExecutor: TaskExecutor;
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    mockExecutor = { execute: vi.fn().mockResolvedValue(undefined) };
    orchestrator = new TaskOrchestrator(mockExecutor);
  });

  it('delegates task execution to the injected executor', async () => {
    const task = createTask();
    await orchestrator.handle(task);
    expect(mockExecutor.execute).toHaveBeenCalledWith(task);
  });

  it('propagates executor errors', async () => {
    const error = new Error('executor failed');
    (mockExecutor.execute as ReturnType<typeof vi.fn>).mockRejectedValue(error);
    await expect(orchestrator.handle(createTask())).rejects.toThrow('executor failed');
  });
});
