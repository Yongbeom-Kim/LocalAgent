import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Job, JobAttempt, TaskResultSubmission } from '@local-agent/shared';
import { ExecutionEnvironment } from '../../services/job-environment';

const mockEnv: ExecutionEnvironment = {
  workDir: '/tmp/localagent-job-test',
  pluginDirs: [],
  isExistingWorkspace: false,
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
  task_type: 'generic',
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
    session_id: 'session-789',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executors: [{ executor: 'claude_code', executor_model: 'opus' }],
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

  it('calls setup once before execution and never tears down', async () => {
    const job = createJob();
    await orchestrator.handle(job);

    const expectedAttempt: JobAttempt = {
      job_id: 'job-456',
      task_id: 'test-123',
      session_id: 'session-789',
      task_type: 'generic',
      payload: 'What is 2+2?',
      executor: 'claude_code',
      executor_model: 'opus',
      submitted_at: '2026-03-26T00:00:00.000Z',
      enriched_at: '2026-03-26T00:00:01.000Z',
    };

    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockSetup).toHaveBeenCalledWith(job);
    expect(mockClaudeExecute).toHaveBeenCalledWith(expectedAttempt, mockEnv);
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('returns TaskResultSubmission from Claude executor for claude_code jobs', async () => {
    const job = createJob({
      executors: [{ executor: 'claude_code', executor_model: 'opus' }],
    });
    const result = await orchestrator.handle(job);

    expect(ClaudeCliExecutor).toHaveBeenCalledTimes(1);
    expect(TTADKExecutor).not.toHaveBeenCalled();
    expect(mockClaudeExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        executor: 'claude_code',
        executor_model: 'opus',
      }),
      mockEnv,
    );
    expect(result).toEqual(mockResultSubmission);
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('returns TaskResultSubmission from TTADK executor for ttadk jobs', async () => {
    const job = createJob({
      executors: [{ executor: 'ttadk', executor_model: 'gpt-5.4' }],
    });
    const result = await orchestrator.handle(job);

    expect(TTADKExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    expect(mockTTADKExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        executor: 'ttadk',
        executor_model: 'gpt-5.4',
      }),
      mockEnv,
    );
    expect(result).toEqual(mockResultSubmission);
    expect(mockTeardown).not.toHaveBeenCalled();
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

  it('returns failure when execution fails without teardown', async () => {
    mockClaudeExecute.mockRejectedValue(new Error('execution boom'));

    const result = await orchestrator.handle(createJob());

    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockTeardown).not.toHaveBeenCalled();
    expect(result.status).toBe('failure');
    expect(result.stderr).toContain('execution boom');
  });

  it('returns failure for unknown executor without teardown', async () => {
    const job = createJob({
      executors: [{ executor: 'invalid' as never, executor_model: 'test' }],
    });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('failure');
    expect(result.stderr).toContain('Unknown executor: invalid');
    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('falls back to second executor using shared environment', async () => {
    const failResult: TaskResultSubmission = {
      job_id: 'job-456',
      task_id: 'test-123',
      task_type: 'generic',
      status: 'failure',
      exit_code: 1,
      stdout: '',
      stderr: 'model unavailable',
    };
    const successResult: TaskResultSubmission = {
      job_id: 'job-456',
      task_id: 'test-123',
      task_type: 'generic',
      status: 'success',
      exit_code: 0,
      stdout: 'fallback output',
      stderr: '',
    };

    mockClaudeExecute.mockResolvedValueOnce(failResult);
    mockTTADKExecute.mockResolvedValueOnce(successResult);

    const job = createJob({
      executors: [
        { executor: 'claude_code', executor_model: 'opus' },
        { executor: 'ttadk', executor_model: 'gpt-5.4' },
      ],
    });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('fallback output');
    expect(mockClaudeExecute).toHaveBeenCalledTimes(1);
    expect(mockTTADKExecute).toHaveBeenCalledTimes(1);
    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockClaudeExecute).toHaveBeenCalledWith(expect.anything(), mockEnv);
    expect(mockTTADKExecute).toHaveBeenCalledWith(expect.anything(), mockEnv);
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('returns last failure when all executors fail', async () => {
    const failResult1: TaskResultSubmission = {
      job_id: 'job-456',
      task_id: 'test-123',
      task_type: 'generic',
      status: 'failure',
      exit_code: 1,
      stdout: '',
      stderr: 'first failure',
    };
    const failResult2: TaskResultSubmission = {
      job_id: 'job-456',
      task_id: 'test-123',
      task_type: 'generic',
      status: 'failure',
      exit_code: 1,
      stdout: '',
      stderr: 'second failure',
    };

    mockClaudeExecute.mockResolvedValueOnce(failResult1);
    mockTTADKExecute.mockResolvedValueOnce(failResult2);

    const job = createJob({
      executors: [
        { executor: 'claude_code', executor_model: 'opus' },
        { executor: 'ttadk', executor_model: 'gpt-5.4' },
      ],
    });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('failure');
    expect(result.stderr).toBe('second failure');
    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('returns success immediately without trying remaining executors', async () => {
    const job = createJob({
      executors: [
        { executor: 'claude_code', executor_model: 'opus' },
        { executor: 'ttadk', executor_model: 'gpt-5.4' },
      ],
    });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('success');
    expect(mockClaudeExecute).toHaveBeenCalledTimes(1);
    expect(mockTTADKExecute).not.toHaveBeenCalled();
    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('constructs correct JobAttempt for each executor preference', async () => {
    const failResult: TaskResultSubmission = {
      job_id: 'job-456',
      task_id: 'test-123',
      task_type: 'generic',
      status: 'failure',
      exit_code: 1,
      stdout: '',
      stderr: 'fail',
    };
    mockClaudeExecute.mockResolvedValueOnce(failResult);

    const job = createJob({
      executors: [
        { executor: 'claude_code', executor_model: 'opus' },
        { executor: 'ttadk', executor_model: 'gpt-5.4' },
      ],
    });
    await orchestrator.handle(job);

    expect(mockClaudeExecute).toHaveBeenCalledWith(
      expect.objectContaining({ executor: 'claude_code', executor_model: 'opus' }),
      mockEnv,
    );
    expect(mockTTADKExecute).toHaveBeenCalledWith(
      expect.objectContaining({ executor: 'ttadk', executor_model: 'gpt-5.4' }),
      mockEnv,
    );
    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('passes history through to JobAttempt when provided', async () => {
    const history = 'Prior task context';
    const job = createJob({ history });

    await orchestrator.handle(job);

    expect(mockClaudeExecute).toHaveBeenCalledWith(
      expect.objectContaining({ history }),
      mockEnv,
    );
  });

  it('returns failure for empty executors array', async () => {
    const job = createJob({ executors: [] });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('failure');
    expect(result.stderr).toContain('Job has no executor preferences');
    expect(mockSetup).not.toHaveBeenCalled();
    expect(mockTeardown).not.toHaveBeenCalled();
  });
});
