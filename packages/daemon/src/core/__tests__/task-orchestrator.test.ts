import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Task } from '@local-agent/shared';

const mockClaudeExecute = vi.fn();
const mockTTADKExecute = vi.fn();

vi.mock('../../adapters/claude-cli-executor', () => ({
  ClaudeCliExecutor: vi.fn().mockImplementation(() => ({
    execute: mockClaudeExecute,
  })),
}));

vi.mock('../../adapters/ttadk-executor', () => ({
  TTADKExecutor: vi.fn().mockImplementation(() => ({
    execute: mockTTADKExecute,
  })),
}));

import { ClaudeCliExecutor } from '../../adapters/claude-cli-executor';
import { TTADKExecutor } from '../../adapters/ttadk-executor';
import { TaskOrchestrator } from '../task-orchestrator';

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'claude_code',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('TaskOrchestrator', () => {
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaudeExecute.mockResolvedValue(undefined);
    mockTTADKExecute.mockResolvedValue(undefined);
    orchestrator = new TaskOrchestrator();
  });

  it('creates Claude executor for claude_code tasks only', async () => {
    const task = createTask({ executor: 'claude_code' });

    await orchestrator.handle(task);

    expect(ClaudeCliExecutor).toHaveBeenCalledTimes(1);
    expect(TTADKExecutor).not.toHaveBeenCalled();
    expect(mockClaudeExecute).toHaveBeenCalledWith(task);
    expect(mockTTADKExecute).not.toHaveBeenCalled();
  });

  it('creates TTADK executor for ttadk tasks only', async () => {
    const task = createTask({ executor: 'ttadk' });

    await orchestrator.handle(task);

    expect(TTADKExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    expect(mockTTADKExecute).toHaveBeenCalledWith(task);
    expect(mockClaudeExecute).not.toHaveBeenCalled();
  });

  it('rejects invalid executor values without constructing adapters', async () => {
    const task = createTask({ executor: 'invalid' as never });

    await expect(orchestrator.handle(task)).rejects.toThrow('Unknown task executor: invalid');

    expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    expect(TTADKExecutor).not.toHaveBeenCalled();
    expect(mockClaudeExecute).not.toHaveBeenCalled();
    expect(mockTTADKExecute).not.toHaveBeenCalled();
  });

  it('propagates unexpected executor rejections so ack does not happen', async () => {
    mockClaudeExecute.mockRejectedValue(new Error('boom'));

    await expect(orchestrator.handle(createTask({ executor: 'claude_code' }))).rejects.toThrow('boom');

    expect(ClaudeCliExecutor).toHaveBeenCalledTimes(1);
    expect(mockClaudeExecute).toHaveBeenCalledTimes(1);
  });
});
