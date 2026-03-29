import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Job, TaskResultSubmission } from '@local-agent/shared';
import { ExecutionEnvironment } from '../../services/job-environment';

const mockEnv: ExecutionEnvironment = {
  workDir: '/tmp/localagent-job-test',
  pluginDirs: [],
};

const mockSetup = vi.fn().mockResolvedValue(mockEnv);
const mockTeardown = vi.fn().mockResolvedValue(undefined);

vi.mock('../../services/job-environment', () => ({
  JobEnvironment: vi.fn(function (this: { setup: typeof mockSetup; teardown: typeof mockTeardown }) {
    this.setup = mockSetup;
    this.teardown = mockTeardown;
  }),
}));

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

vi.mock('../../adapters/claude-cli-executor', () => ({
  ClaudeCliExecutor: vi.fn(function (this: { execute: typeof mockClaudeExecute }) {
    this.execute = mockClaudeExecute;
  }),
}));

vi.mock('../../adapters/ttadk-executor', () => ({
  TTADKExecutor: vi.fn(function (this: { execute: typeof mockTTADKExecute }) {
    this.execute = mockTTADKExecute;
  }),
}));

import { ClaudeCliExecutor } from '../../adapters/claude-cli-executor';
import { TTADKExecutor } from '../../adapters/ttadk-executor';
import { TaskOrchestrator } from '../task-orchestrator';
import { JobEnvironment } from '../../services/job-environment';

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
  let jobEnv: JobEnvironment;

  beforeEach(() => {
    mockClaudeExecute.mockClear().mockResolvedValue(mockResultSubmission);
    mockTTADKExecute.mockClear().mockResolvedValue(mockResultSubmission);
    mockSetup.mockClear().mockResolvedValue(mockEnv);
    mockTeardown.mockClear().mockResolvedValue(undefined);
    vi.mocked(ClaudeCliExecutor).mockClear();
    vi.mocked(TTADKExecutor).mockClear();
    jobEnv = new JobEnvironment(false);
    orchestrator = new TaskOrchestrator(jobEnv);
  });

  it('calls setup before execution and teardown after', async () => {
    const job = createJob();
    await orchestrator.handle(job);

    expect(mockSetup).toHaveBeenCalledWith(job);
    expect(mockClaudeExecute).toHaveBeenCalledWith(job, mockEnv);
    expect(mockTeardown).toHaveBeenCalledWith(mockEnv);
  });

  it('returns TaskResultSubmission from Claude executor for claude_code jobs', async () => {
    const job = createJob({ executor: 'claude_code' });
    const result = await orchestrator.handle(job);

    expect(ClaudeCliExecutor).toHaveBeenCalledTimes(1);
    expect(TTADKExecutor).not.toHaveBeenCalled();
    expect(mockClaudeExecute).toHaveBeenCalledWith(job, mockEnv);
    expect(result).toEqual(mockResultSubmission);
  });

  it('returns TaskResultSubmission from TTADK executor for ttadk jobs', async () => {
    const job = createJob({ executor: 'ttadk' });
    const result = await orchestrator.handle(job);

    expect(TTADKExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    expect(mockTTADKExecute).toHaveBeenCalledWith(job, mockEnv);
    expect(result).toEqual(mockResultSubmission);
  });

  it('returns failure result when setup fails', async () => {
    mockSetup.mockRejectedValue(new Error('clone failed'));

    const result = await orchestrator.handle(createJob());

    expect(result.status).toBe('failure');
    expect(result.stderr).toContain('Environment setup failed');
    expect(result.stderr).toContain('clone failed');
    expect(mockClaudeExecute).not.toHaveBeenCalled();
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('calls teardown even when execution fails', async () => {
    mockClaudeExecute.mockRejectedValue(new Error('execution boom'));

    const result = await orchestrator.handle(createJob());

    expect(mockTeardown).toHaveBeenCalledWith(mockEnv);
    expect(result.status).toBe('failure');
    expect(result.stderr).toContain('execution boom');
  });

  it('returns failure for unknown executor', async () => {
    const job = createJob({ executor: 'invalid' as never });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('failure');
    expect(result.stderr).toContain('Unknown job executor: invalid');
    expect(mockTeardown).toHaveBeenCalledWith(mockEnv);
  });
});
