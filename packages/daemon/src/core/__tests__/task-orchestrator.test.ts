import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Task, TaskResultSubmission } from '@local-agent/shared';

const mockResultSubmission: TaskResultSubmission = {
  task_id: 'test-123',
  status: 'success',
  exit_code: 0,
  stdout: 'output',
  stderr: '',
};

const mockClaudeExecute = vi.fn().mockResolvedValue(mockResultSubmission);
const mockTTADKExecute = vi.fn().mockResolvedValue(mockResultSubmission);

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
    executor_model: 'opus',
    submitted_at: '2026-03-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('TaskOrchestrator', () => {
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaudeExecute.mockResolvedValue(mockResultSubmission);
    mockTTADKExecute.mockResolvedValue(mockResultSubmission);
    orchestrator = new TaskOrchestrator();
  });

  it('returns TaskResultSubmission from Claude executor for claude_code tasks', async () => {
    const task = createTask({ executor: 'claude_code' });
    const result = await orchestrator.handle(task);

    expect(ClaudeCliExecutor).toHaveBeenCalledTimes(1);
    expect(TTADKExecutor).not.toHaveBeenCalled();
    expect(mockClaudeExecute).toHaveBeenCalledWith(task);
    expect(result).toEqual(mockResultSubmission);
  });

  it('returns TaskResultSubmission from TTADK executor for ttadk tasks', async () => {
    const task = createTask({ executor: 'ttadk' });
    const result = await orchestrator.handle(task);

    expect(TTADKExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    expect(mockTTADKExecute).toHaveBeenCalledWith(task);
    expect(result).toEqual(mockResultSubmission);
  });

  it('rejects invalid executor values without constructing adapters', async () => {
    const task = createTask({ executor: 'invalid' as never });
    await expect(orchestrator.handle(task)).rejects.toThrow('Unknown task executor: invalid');
    expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    expect(TTADKExecutor).not.toHaveBeenCalled();
  });

  it('propagates unexpected executor rejections so ack does not happen', async () => {
    mockClaudeExecute.mockRejectedValue(new Error('boom'));
    await expect(orchestrator.handle(createTask({ executor: 'claude_code' }))).rejects.toThrow('boom');
  });
});
