import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Job, JobAttempt, TaskResultSubmission } from '@local-agent/shared';
import { ExecutionEnvironment } from '../../services/job-environment';

const mockEnv: ExecutionEnvironment = {
  workDir: '/tmp/localagent-job-test',
  pluginDirs: [],
  isExistingWorkspace: false,
};

const emptyEnv: ExecutionEnvironment = {
  workDir: '',
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
  executor: 'claude',
  executor_model: 'opus',
};

const mockCleanupResultSubmission: TaskResultSubmission = {
  job_id: 'job-456',
  task_id: 'test-123',
  task_type: 'cleanup',
  session_id: 'session-789',
  status: 'success',
  exit_code: 0,
  stdout: 'cleanup complete',
  stderr: '',
  executor: 'builtin',
  executor_model: 'none',
};

const mockGcResultSubmission: TaskResultSubmission = {
  job_id: 'job-456',
  task_id: 'test-123',
  task_type: 'gc',
  status: 'success',
  exit_code: 0,
  stdout: 'GC complete: removed 1 session(s), retained 0.',
  stderr: '',
};

const mockClaudeExecute = vi.fn().mockResolvedValue(mockResultSubmission);
const mockGcExecute = vi.fn().mockReturnValue(mockGcResultSubmission);
const mockClaudeWExecute = vi.fn().mockResolvedValue(mockResultSubmission);
const mockCursorExecute = vi.fn().mockResolvedValue(mockResultSubmission);
const mockTTCodexExecute = vi.fn().mockResolvedValue(mockResultSubmission);
const mockCleanupExecute = vi.fn().mockResolvedValue(mockCleanupResultSubmission);
vi.mock('../../adapters/claude-executor', () => ({
  ClaudeExecutor: vi.fn(function (this: { execute: typeof mockClaudeExecute }) {
    this.execute = mockClaudeExecute;
  }),
}));

vi.mock('../../adapters/claude-w-executor', () => ({
  ClaudeWExecutor: vi.fn(function (this: { execute: typeof mockClaudeWExecute }) {
    this.execute = mockClaudeWExecute;
  }),
}));

vi.mock('../../adapters/cleanup-executor', () => ({
  CleanupExecutor: vi.fn(function (this: { execute: typeof mockCleanupExecute }) {
    this.execute = mockCleanupExecute;
  }),
}));

vi.mock('../../adapters/cursor-executor', () => ({
  CursorExecutor: vi.fn(function (this: { execute: typeof mockCursorExecute }) {
    this.execute = mockCursorExecute;
  }),
}));

vi.mock('../../adapters/ttcodex-executor', () => ({
  TTCodexExecutor: vi.fn(function (this: { execute: typeof mockTTCodexExecute }) {
    this.execute = mockTTCodexExecute;
  }),
}));

vi.mock('../../services/gc-executor', () => ({
  GcExecutor: vi.fn(function (this: { execute: typeof mockGcExecute }) {
    this.execute = mockGcExecute;
  }),
}));

import { ClaudeExecutor } from '../../adapters/claude-executor';
import { CleanupExecutor } from '../../adapters/cleanup-executor';
import { ClaudeWExecutor } from '../../adapters/claude-w-executor';
import { CursorExecutor } from '../../adapters/cursor-executor';
import { TTCodexExecutor } from '../../adapters/ttcodex-executor';
import { GcExecutor } from '../../services/gc-executor';
import { SetupHookExecutionError } from '../../services/setup-hook-runner';
import { TaskOrchestrator } from '../task-orchestrator';
import { JobEnvironment } from '../../services/job-environment';

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'test-123',
    session_id: 'session-789',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executors: [{ executor: 'claude', executor_model: 'opus' }],
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
    mockClaudeWExecute.mockClear().mockResolvedValue(mockResultSubmission);
    mockCursorExecute.mockClear().mockResolvedValue(mockResultSubmission);
    mockTTCodexExecute.mockClear().mockResolvedValue(mockResultSubmission);
    mockCleanupExecute.mockClear().mockResolvedValue(mockCleanupResultSubmission);
    mockGcExecute.mockClear().mockReturnValue(mockGcResultSubmission);
    mockSetup.mockClear().mockResolvedValue(mockEnv);
    mockTeardown.mockClear().mockResolvedValue(undefined);
    vi.mocked(ClaudeExecutor).mockClear();
    vi.mocked(ClaudeWExecutor).mockClear();
    vi.mocked(CursorExecutor).mockClear();
    vi.mocked(TTCodexExecutor).mockClear();
    vi.mocked(CleanupExecutor).mockClear();
    vi.mocked(GcExecutor).mockClear();
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
      executor: 'claude',
      executor_model: 'opus',
      submitted_at: '2026-03-26T00:00:00.000Z',
      enriched_at: '2026-03-26T00:00:01.000Z',
    };

    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockSetup).toHaveBeenCalledWith(job);
    expect(mockClaudeExecute).toHaveBeenCalledWith(expectedAttempt, mockEnv);
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('returns TaskResultSubmission from Claude executor for claude jobs', async () => {
    const job = createJob();
    const result = await orchestrator.handle(job);

    expect(ClaudeExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeWExecutor).toHaveBeenCalledTimes(1);
    expect(CursorExecutor).toHaveBeenCalledTimes(1);
    expect(CleanupExecutor).toHaveBeenCalledTimes(1);
    expect(mockClaudeExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        executor: 'claude',
        executor_model: 'opus',
      }),
      mockEnv,
    );
    expect(result).toEqual(mockResultSubmission);
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('annotates final failure with executor metadata from the last attempted preference', async () => {
    const failResult: TaskResultSubmission = {
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

    mockClaudeExecute.mockResolvedValueOnce(failResult);
    mockClaudeWExecute.mockResolvedValueOnce(failResult2);

    const result = await orchestrator.handle(createJob({
      executors: [
        { executor: 'claude', executor_model: 'opus' },
        { executor: 'claude-w', executor_model: 'gpt-5.4' },
      ],
    }));

    expect(result.executor).toBe('claude-w');
    expect(result.executor_model).toBe('gpt-5.4');
  });

  it('returns TaskResultSubmission from ClaudeWExecutor for claude-w jobs', async () => {
    const job = createJob({
      executors: [{ executor: 'claude-w', executor_model: 'gpt-5.4' }],
    });
    const result = await orchestrator.handle(job);

    expect(ClaudeWExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeExecutor).toHaveBeenCalledTimes(1);
    expect(CursorExecutor).toHaveBeenCalledTimes(1);
    expect(CleanupExecutor).toHaveBeenCalledTimes(1);
    expect(mockClaudeWExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        executor: 'claude-w',
        executor_model: 'gpt-5.4',
      }),
      mockEnv,
    );
    expect(result).toEqual({ ...mockResultSubmission, executor: 'claude-w', executor_model: 'gpt-5.4' });
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('returns TaskResultSubmission from CursorExecutor for cursor jobs', async () => {
    const job = createJob({
      executors: [{ executor: 'cursor', executor_model: 'auto' }],
    });
    const result = await orchestrator.handle(job);

    expect(CursorExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeWExecutor).toHaveBeenCalledTimes(1);
    expect(CleanupExecutor).toHaveBeenCalledTimes(1);
    expect(mockCursorExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        executor: 'cursor',
        executor_model: 'auto',
      }),
      mockEnv,
    );
    expect(result).toEqual({ ...mockResultSubmission, executor: 'cursor', executor_model: 'auto' });
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('returns TaskResultSubmission from TTCodexExecutor for ttcodex jobs', async () => {
    const job = createJob({
      executors: [{ executor: 'ttcodex', executor_model: 'gpt-5.4' }],
    });
    const result = await orchestrator.handle(job);

    expect(TTCodexExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeWExecutor).toHaveBeenCalledTimes(1);
    expect(CursorExecutor).toHaveBeenCalledTimes(1);
    expect(CleanupExecutor).toHaveBeenCalledTimes(1);
    expect(mockTTCodexExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        executor: 'ttcodex',
        executor_model: 'gpt-5.4',
      }),
      mockEnv,
    );
    expect(result).toEqual({ ...mockResultSubmission, executor: 'ttcodex', executor_model: 'gpt-5.4' });
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('resolves builtin executor for cleanup jobs', async () => {
    const job = createJob({
      task_type: 'cleanup',
      payload: 'cleanup session workspace',
      executors: [{ executor: 'builtin', executor_model: 'none' }],
    });

    const result = await orchestrator.handle(job);

    expect(CleanupExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeWExecutor).toHaveBeenCalledTimes(1);
    expect(mockCleanupExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: 'cleanup',
        executor: 'builtin',
        executor_model: 'none',
      }),
      emptyEnv,
    );
    expect(result).toEqual(mockCleanupResultSubmission);
  });

  it('skips environment setup for cleanup jobs', async () => {
    const job = createJob({
      task_type: 'cleanup',
      payload: 'cleanup session workspace',
      executors: [{ executor: 'builtin', executor_model: 'none' }],
    });

    await orchestrator.handle(job);

    expect(mockSetup).not.toHaveBeenCalled();
    expect(mockTeardown).not.toHaveBeenCalled();
    expect(mockCleanupExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: 'cleanup',
      }),
      emptyEnv,
    );
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

  it('short-circuits with terminal failure when setup hook rejects with SetupHookExecutionError', async () => {
    mockSetup.mockRejectedValue(
      new SetupHookExecutionError({
        message: 'Setup hook exited non-zero',
        stdout: 'hook stdout',
        stderr: 'hook stderr',
        timedOut: false,
      }),
    );

    const result = await orchestrator.handle(createJob());

    expect(result).toEqual({
      job_id: 'job-456',
      task_id: 'test-123',
      task_type: 'generic',
      status: 'failure',
      exit_code: 1,
      stdout: 'hook stdout',
      stderr: 'hook stderr',
    });
    expect(Object.prototype.hasOwnProperty.call(result, 'executor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, 'executor_model')).toBe(false);

    expect(ClaudeExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeWExecutor).toHaveBeenCalledTimes(1);
    expect(CursorExecutor).toHaveBeenCalledTimes(1);
    expect(TTCodexExecutor).toHaveBeenCalledTimes(1);
    expect(CleanupExecutor).toHaveBeenCalledTimes(1);
    expect(mockClaudeExecute).not.toHaveBeenCalled();
    expect(mockClaudeWExecute).not.toHaveBeenCalled();
    expect(mockCursorExecute).not.toHaveBeenCalled();
    expect(mockTTCodexExecute).not.toHaveBeenCalled();
    expect(mockCleanupExecute).not.toHaveBeenCalled();
  });

  it('does not retry new_instance when setup hook rejects with SetupHookExecutionError', async () => {
    mockSetup.mockRejectedValue(
      new SetupHookExecutionError({
        message: 'Setup hook timed out',
        stdout: 'hook stdout 2',
        stderr: 'hook stderr 2',
        timedOut: true,
      }),
    );

    const result = await orchestrator.handle(createJob({ task_type: 'new_instance' }));

    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failure');
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toBe('hook stdout 2');
    expect(result.stderr).toBe('hook stderr 2');
    expect(mockClaudeExecute).not.toHaveBeenCalled();
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
    mockClaudeWExecute.mockResolvedValueOnce(successResult);

    const job = createJob({
      executors: [
        { executor: 'claude', executor_model: 'opus' },
        { executor: 'claude-w', executor_model: 'gpt-5.4' },
      ],
    });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('fallback output');
    expect(result.executor).toBe('claude-w');
    expect(result.executor_model).toBe('gpt-5.4');
    expect(mockClaudeExecute).toHaveBeenCalledTimes(1);
    expect(mockClaudeWExecute).toHaveBeenCalledTimes(1);
    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockClaudeExecute).toHaveBeenCalledWith(expect.anything(), mockEnv);
    expect(mockClaudeWExecute).toHaveBeenCalledWith(expect.anything(), mockEnv);
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
    mockClaudeWExecute.mockResolvedValueOnce(failResult2);

    const job = createJob({
      executors: [
        { executor: 'claude', executor_model: 'opus' },
        { executor: 'claude-w', executor_model: 'gpt-5.4' },
      ],
    });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('failure');
    expect(result.stderr).toBe('second failure');
    expect(result.executor).toBe('claude-w');
    expect(result.executor_model).toBe('gpt-5.4');
    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('returns success immediately without trying remaining executors', async () => {
    const job = createJob({
      executors: [
        { executor: 'claude', executor_model: 'opus' },
        { executor: 'claude-w', executor_model: 'gpt-5.4' },
      ],
    });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('success');
    expect(mockClaudeExecute).toHaveBeenCalledTimes(1);
    expect(mockClaudeWExecute).not.toHaveBeenCalled();
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
        { executor: 'claude', executor_model: 'opus' },
        { executor: 'claude-w', executor_model: 'gpt-5.4' },
      ],
    });
    await orchestrator.handle(job);

    expect(mockClaudeExecute).toHaveBeenCalledWith(
      expect.objectContaining({ executor: 'claude', executor_model: 'opus' }),
      mockEnv,
    );
    expect(mockClaudeWExecute).toHaveBeenCalledWith(
      expect.objectContaining({ executor: 'claude-w', executor_model: 'gpt-5.4' }),
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

  it('short-circuits gc jobs without environment setup', async () => {
    const job = createJob({
      task_type: 'gc',
      executors: [{ executor: 'claude', executor_model: 'sonnet' }],
    });

    const result = await orchestrator.handle(job);

    expect(GcExecutor).toHaveBeenCalledTimes(1);
    expect(mockGcExecute).toHaveBeenCalledWith(job);
    expect(mockSetup).not.toHaveBeenCalled();
    expect(mockClaudeExecute).not.toHaveBeenCalled();
    expect(mockClaudeWExecute).not.toHaveBeenCalled();
    expect(mockCleanupExecute).not.toHaveBeenCalled();
    expect(result).toEqual(mockGcResultSubmission);
  });

  it('calls execute on instantiated GcExecutor', async () => {
    const job = createJob({
      task_type: 'gc',
      executors: [{ executor: 'claude', executor_model: 'sonnet' }],
    });

    await orchestrator.handle(job);

    expect(GcExecutor).toHaveBeenCalledTimes(1);
    expect(mockGcExecute).toHaveBeenCalledWith(job);
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
