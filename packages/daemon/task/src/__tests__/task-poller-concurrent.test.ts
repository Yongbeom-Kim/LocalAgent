import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import type { Job, TaskResultSubmission } from '@local-agent/shared';

const { TEST_SESSION_BASE_DIR } = vi.hoisted(() => ({
  TEST_SESSION_BASE_DIR: `/tmp/local-agent-task-poller-session-lock-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}/session`,
}));

vi.mock('@local-agent/shared', async () => {
  const actual = await vi.importActual<typeof import('@local-agent/shared')>('@local-agent/shared');
  return {
    ...actual,
    SESSION_BASE_DIR: TEST_SESSION_BASE_DIR,
  };
});

import { TaskOrchestrator } from '../core/task-orchestrator';
import { ExecutionEnvironment } from '../services/job-environment';
import { SessionLockManager } from '../services/session-lock';

const mockEnv: ExecutionEnvironment = {
  workDir: '/tmp/localagent-job-test',
  pluginDirs: [],
};

const mockSetup = vi.fn().mockResolvedValue(mockEnv);
const mockTeardown = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/job-environment', () => ({
  JobEnvironment: vi.fn(function (this: { setup: typeof mockSetup; teardown: typeof mockTeardown }) {
    this.setup = mockSetup;
    this.teardown = mockTeardown;
  }),
}));

const mockClaudeExecute = vi.fn();
const mockCleanupExecute = vi.fn();
vi.mock('../adapters/claude-executor', () => {
  return {
    ClaudeExecutor: vi.fn(function (this: { execute: typeof mockClaudeExecute }) {
      this.execute = mockClaudeExecute;
    }),
  };
});

vi.mock('../adapters/cleanup-executor', () => ({
  CleanupExecutor: vi.fn(function (this: { execute: typeof mockCleanupExecute }) {
    this.execute = mockCleanupExecute;
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'abc-123',
    session_id: 'session-789',
    task_type: 'generic',
    payload: 'hello',
    executors: [{ executor: 'claude', executor_model: 'opus' }],
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    ...overrides,
  };
}

function createMockResult(jobId: string, sessionId: string, taskType = 'generic'): TaskResultSubmission {
  return {
    job_id: jobId,
    task_id: `${jobId}-task`,
    session_id: sessionId,
    task_type: taskType,
    status: 'success',
    exit_code: 0,
    stdout: 'result output',
    stderr: '',
  };
}

import { TaskPoller } from '../task-poller';
import { JobEnvironment } from '../services/job-environment';

describe('TaskPoller Concurrent', () => {
  let poller: TaskPoller;
  let mockSessionLock: SessionLockManager;

  beforeEach(() => {
    rmSync(TEST_SESSION_BASE_DIR, { recursive: true, force: true });
    mockFetch.mockReset();
    mockClaudeExecute.mockReset();
    mockCleanupExecute.mockReset();
    mockSetup.mockReset().mockResolvedValue(mockEnv);
    mockTeardown.mockReset().mockResolvedValue(undefined);

    mockSessionLock = {
      acquire: vi.fn().mockReturnValue(true),
      release: vi.fn(),
      isLockedByLiveProcess: vi.fn().mockReturnValue(false),
    } as unknown as SessionLockManager;
  });

  afterEach(() => {
    if (poller) poller.stop();
    rmSync(TEST_SESSION_BASE_DIR, { recursive: true, force: true });
  });

  it('dispatches multiple jobs for different sessions concurrently', async () => {
    const jobEnv = new JobEnvironment(false);
    poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), mockSessionLock, 5);

    let resolveJob1!: (v: TaskResultSubmission) => void;
    let resolveJob2!: (v: TaskResultSubmission) => void;

    const job1Promise = new Promise<TaskResultSubmission>((r) => { resolveJob1 = r; });
    const job2Promise = new Promise<TaskResultSubmission>((r) => { resolveJob2 = r; });

    mockClaudeExecute.mockReturnValueOnce(job1Promise).mockReturnValueOnce(job2Promise);

    const job1 = createJob({ job_id: 'job-1', task_id: 'task-1', session_id: 'session-A' });
    const job2 = createJob({ job_id: 'job-2', task_id: 'task-2', session_id: 'session-B' });

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({
          sessions: [
            { session_id: 'session-A', queue_name: 'jobs.session.session-A' },
            { session_id: 'session-B', queue_name: 'jobs.session.session-B' },
          ],
        }),
      })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(job1) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(job2) });

    await poller.pollOnce();
    await new Promise((r) => setTimeout(r, 10));

    expect(mockClaudeExecute).toHaveBeenCalledTimes(2);

    mockFetch
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 200 });

    resolveJob1(createMockResult('job-1', 'session-A'));
    resolveJob2(createMockResult('job-2', 'session-B'));

    await poller.drain();

    expect(mockSessionLock.release).toHaveBeenCalledWith('session-A');
    expect(mockSessionLock.release).toHaveBeenCalledWith('session-B');
  });

  it('preserves fifo within a session across repeated polls', async () => {
    const jobEnv = new JobEnvironment(false);
    poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), mockSessionLock, 5);

    let resolveJob1!: (v: TaskResultSubmission) => void;
    let resolveJob2!: (v: TaskResultSubmission) => void;
    const firstPromise = new Promise<TaskResultSubmission>((r) => { resolveJob1 = r; });
    const secondPromise = new Promise<TaskResultSubmission>((r) => { resolveJob2 = r; });

    mockClaudeExecute.mockReturnValueOnce(firstPromise).mockReturnValueOnce(secondPromise);

    const job1 = createJob({ job_id: 'job-1', task_id: 'task-1', session_id: 'session-A', payload: 'first' });
    const job2 = createJob({ job_id: 'job-2', task_id: 'task-2', session_id: 'session-A', payload: 'second' });

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ sessions: [{ session_id: 'session-A', queue_name: 'jobs.session.session-A' }] }),
      })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(job1) });

    await poller.pollOnce();
    await new Promise((r) => setTimeout(r, 10));

    mockFetch.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ sessions: [{ session_id: 'session-A', queue_name: 'jobs.session.session-A' }] }),
    });
    await poller.pollOnce();
    expect(mockClaudeExecute).toHaveBeenCalledTimes(1);

    mockFetch
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 200 });
    resolveJob1(createMockResult('job-1', 'session-A'));
    await new Promise((r) => setTimeout(r, 10));

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ sessions: [{ session_id: 'session-A', queue_name: 'jobs.session.session-A' }] }),
      })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(job2) })
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 200 });

    await poller.pollOnce();
    await new Promise((r) => setTimeout(r, 10));
    resolveJob2(createMockResult('job-2', 'session-A'));
    await poller.drain();

    expect(mockClaudeExecute).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.some((call) => String(call[0]).includes('/jobs/session-A/job-1/nack'))).toBe(false);
  });

  it('runs cleanup in normal fifo order for the same session', async () => {
    const jobEnv = new JobEnvironment(false);
    poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), mockSessionLock, 5);

    let resolveActive!: (v: TaskResultSubmission) => void;
    const activePromise = new Promise<TaskResultSubmission>((r) => { resolveActive = r; });
    mockClaudeExecute.mockReturnValueOnce(activePromise);
    mockCleanupExecute.mockResolvedValueOnce(createMockResult('job-cleanup', 'session-A', 'cleanup'));

    const activeJob = createJob({ job_id: 'job-active', task_id: 'task-active', session_id: 'session-A' });
    const cleanupJob = createJob({
      job_id: 'job-cleanup',
      task_id: 'task-cleanup',
      session_id: 'session-A',
      task_type: 'cleanup',
      executors: [{ executor: 'builtin', executor_model: 'none' }],
    });

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ sessions: [{ session_id: 'session-A', queue_name: 'jobs.session.session-A' }] }),
      })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(activeJob) });
    await poller.pollOnce();
    await new Promise((r) => setTimeout(r, 10));

    mockFetch.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ sessions: [{ session_id: 'session-A', queue_name: 'jobs.session.session-A' }] }),
    });
    await poller.pollOnce();
    expect(mockCleanupExecute).not.toHaveBeenCalled();

    mockFetch
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 200 });
    resolveActive(createMockResult('job-active', 'session-A'));
    await new Promise((r) => setTimeout(r, 10));

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ sessions: [{ session_id: 'session-A', queue_name: 'jobs.session.session-A' }] }),
      })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(cleanupJob) })
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 200 });

    await poller.pollOnce();
    await poller.drain();

    expect(mockCleanupExecute).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls.some((call) => String(call[0]).includes('/nack'))).toBe(false);
  });

  it('backs off when active session count hits concurrency limit', async () => {
    vi.useFakeTimers();
    const jobEnv = new JobEnvironment(false);
    poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), mockSessionLock, 1);

    let resolveJob1!: (v: TaskResultSubmission) => void;
    const job1Promise = new Promise<TaskResultSubmission>((r) => { resolveJob1 = r; });
    mockClaudeExecute.mockReturnValueOnce(job1Promise);

    const job1 = createJob({ job_id: 'job-1', task_id: 'task-1', session_id: 'session-A' });

    (poller as unknown as { basePollInterval: number }).basePollInterval = 1000;
    (poller as unknown as { currentPollInterval: number }).currentPollInterval = 1000;

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ sessions: [{ session_id: 'session-A', queue_name: 'jobs.session.session-A' }] }),
      })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(job1) });

    await poller.pollOnce();
    await vi.advanceTimersByTimeAsync(0);

    mockFetch.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ sessions: [{ session_id: 'session-A', queue_name: 'jobs.session.session-A' }] }),
    });
    await poller.pollOnce();

    expect((poller as unknown as { currentPollInterval: number }).currentPollInterval).toBe(2000);

    mockFetch
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 200 });
    resolveJob1(createMockResult('job-1', 'session-A'));
    await vi.advanceTimersByTimeAsync(0);

    expect((poller as unknown as { currentPollInterval: number }).currentPollInterval).toBe(1000);
    vi.useRealTimers();
  });
});
