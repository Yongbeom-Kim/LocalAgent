import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Job, TaskResultSubmission } from '@local-agent/shared';

const mockResultSubmission: TaskResultSubmission = {
  job_id: 'job-456',
  task_id: 'test-123',
  status: 'success',
  exit_code: 0,
  stdout: 'output',
  stderr: '',
};

const mockClaudeExecute = vi.fn().mockResolvedValue(mockResultSubmission);
const mockTTADKExecute = vi.fn().mockResolvedValue(mockResultSubmission);

vi.mock('../../adapters/claude-cli-executor', () => {
  return {
    ClaudeCliExecutor: vi.fn(function (this: { execute: typeof mockClaudeExecute }) {
      this.execute = mockClaudeExecute;
    }),
  };
});

vi.mock('../../adapters/ttadk-executor', () => {
  return {
    TTADKExecutor: vi.fn(function (this: { execute: typeof mockTTADKExecute }) {
      this.execute = mockTTADKExecute;
    }),
  };
});

import { ClaudeCliExecutor } from '../../adapters/claude-cli-executor';
import { TTADKExecutor } from '../../adapters/ttadk-executor';
import { TaskOrchestrator } from '../task-orchestrator';

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'claude_code',
    executor_model: 'opus',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    ...overrides,
  };
}

describe('TaskOrchestrator', () => {
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    mockClaudeExecute.mockClear().mockResolvedValue(mockResultSubmission);
    mockTTADKExecute.mockClear().mockResolvedValue(mockResultSubmission);
    vi.mocked(ClaudeCliExecutor).mockClear();
    vi.mocked(TTADKExecutor).mockClear();
    orchestrator = new TaskOrchestrator();
  });

  it('returns TaskResultSubmission from Claude executor for claude_code jobs', async () => {
    const job = createJob({ executor: 'claude_code' });
    const result = await orchestrator.handle(job);

    expect(ClaudeCliExecutor).toHaveBeenCalledTimes(1);
    expect(TTADKExecutor).not.toHaveBeenCalled();
    expect(mockClaudeExecute).toHaveBeenCalledWith(job);
    expect(result).toEqual(mockResultSubmission);
  });

  it('returns TaskResultSubmission from TTADK executor for ttadk jobs', async () => {
    const job = createJob({ executor: 'ttadk' });
    const result = await orchestrator.handle(job);

    expect(TTADKExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    expect(mockTTADKExecute).toHaveBeenCalledWith(job);
    expect(result).toEqual(mockResultSubmission);
  });

  it('rejects invalid executor values without constructing adapters', async () => {
    const job = createJob({ executor: 'invalid' as never });
    await expect(orchestrator.handle(job)).rejects.toThrow('Unknown job executor: invalid');
    expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    expect(TTADKExecutor).not.toHaveBeenCalled();
  });

  it('propagates unexpected executor rejections so ack does not happen', async () => {
    mockClaudeExecute.mockRejectedValue(new Error('boom'));
    await expect(orchestrator.handle(createJob({ executor: 'claude_code' }))).rejects.toThrow('boom');
  });
});
