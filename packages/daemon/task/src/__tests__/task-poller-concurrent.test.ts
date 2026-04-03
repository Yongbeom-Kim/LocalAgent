import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import type { Job, TaskResultSubmission } from '@local-agent/shared';

const { TEST_SESSION_BASE_DIR } = vi.hoisted(() => ({
  TEST_SESSION_BASE_DIR: '/tmp/local-agent-task-poller-session-lock-test/session',
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

function createMockResult(jobId: string, sessionId: string): TaskResultSubmission {
  return {
    job_id: jobId,
    task_id: 'abc-123',
    session_id: sessionId,
    task_type: 'generic',
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
    mockFetch.mockClear();
    mockClaudeExecute.mockClear();
    mockCleanupExecute.mockClear();
    mockSetup.mockClear().mockResolvedValue(mockEnv);
    mockTeardown.mockClear().mockResolvedValue(undefined);

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

  describe('concurrent dispatch', () => {
    it('dispatches multiple jobs for different sessions concurrently', async () => {
      const jobEnv = new JobEnvironment(false);
      poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), mockSessionLock, 5);

      let resolveJob1!: (v: TaskResultSubmission) => void;
      let resolveJob2!: (v: TaskResultSubmission) => void;

      const job1Promise = new Promise<TaskResultSubmission>((r) => { resolveJob1 = r; });
      const job2Promise = new Promise<TaskResultSubmission>((r) => { resolveJob2 = r; });

      mockClaudeExecute
        .mockReturnValueOnce(job1Promise)
        .mockReturnValueOnce(job2Promise);

      const job1 = createJob({ job_id: 'job-1', session_id: 'session-A' });
      const job2 = createJob({ job_id: 'job-2', session_id: 'session-B' });

      // First poll returns job1
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(job1),
      });

      await poller.pollOnce();
      // Let microtasks settle so executeJob starts running
      await new Promise((r) => setTimeout(r, 10));

      // Second poll returns job2
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(job2),
      });

      await poller.pollOnce();
      await new Promise((r) => setTimeout(r, 10));

      // Both orchestrator.handle calls should be in-flight simultaneously
      expect(mockClaudeExecute).toHaveBeenCalledTimes(2);

      // Now resolve both and drain
      mockFetch
        .mockResolvedValueOnce({ status: 201 }) // result for job1
        .mockResolvedValueOnce({ status: 200 }) // ack for job1
        .mockResolvedValueOnce({ status: 201 }) // result for job2
        .mockResolvedValueOnce({ status: 200 }); // ack for job2

      resolveJob1(createMockResult('job-1', 'session-A'));
      resolveJob2(createMockResult('job-2', 'session-B'));

      await poller.drain();

      expect(mockSessionLock.release).toHaveBeenCalledWith('session-A');
      expect(mockSessionLock.release).toHaveBeenCalledWith('session-B');
    });
  });

  describe('same-session serialization', () => {
    it('NACKs a job immediately when session lock cannot be acquired', async () => {
      const jobEnv = new JobEnvironment(false);
      poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), mockSessionLock, 5);

      // First job acquires lock, second fails
      (mockSessionLock.acquire as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false);

      let resolveJob1!: (v: TaskResultSubmission) => void;
      const job1Promise = new Promise<TaskResultSubmission>((r) => { resolveJob1 = r; });
      mockClaudeExecute.mockReturnValueOnce(job1Promise);

      const job1 = createJob({ job_id: 'job-1', session_id: 'session-A' });
      const job2 = createJob({ job_id: 'job-2', session_id: 'session-A' });

      // First poll - job1 acquires lock
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(job1),
      });
      await poller.pollOnce();

      // Second poll - job2 fails lock, should NACK immediately (no sleep)
      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job2),
        })
        .mockResolvedValueOnce({ status: 200 }); // NACK response

      await poller.pollOnce();

      // Verify NACK was called for job2
      const nackCall = mockFetch.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('/jobs/job-2/nack'),
      );
      expect(nackCall).toBeDefined();
      expect(nackCall![1]).toEqual({ method: 'POST' });

      // Clean up job1
      mockFetch
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({ status: 200 });
      resolveJob1(createMockResult('job-1', 'session-A'));
      await poller.drain();
    });

    it('NACKs and requeues a cleanup job when another in-flight job holds the same-session lock', async () => {
      const jobEnv = new JobEnvironment(false);
      const realSessionLock = new SessionLockManager();
      poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), realSessionLock, 5);

      let resolveJob1!: (v: TaskResultSubmission) => void;
      const job1Promise = new Promise<TaskResultSubmission>((r) => {
        resolveJob1 = r;
      });
      mockClaudeExecute.mockReturnValueOnce(job1Promise);
      mockCleanupExecute.mockResolvedValueOnce({
        job_id: 'job-cleanup',
        task_id: 'task-cleanup',
        session_id: 'session-A',
        task_type: 'cleanup',
        status: 'success',
        exit_code: 0,
        stdout: 'cleanup complete',
        stderr: '',
        executor: 'builtin',
        executor_model: 'none',
      });

      const activeJob = createJob({
        job_id: 'job-active',
        task_id: 'task-active',
        session_id: 'session-A',
        task_type: 'generic',
      });
      const cleanupJob = createJob({
        job_id: 'job-cleanup',
        task_id: 'task-cleanup',
        session_id: 'session-A',
        task_type: 'cleanup',
        executors: [{ executor: 'builtin', executor_model: 'none' }],
      });

      mockFetch
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(activeJob) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(cleanupJob) })
        .mockResolvedValueOnce({ status: 200 });

      await poller.pollOnce();
      await new Promise((r) => setTimeout(r, 10));
      await poller.pollOnce();

      const nackCall = mockFetch.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('/jobs/job-cleanup/nack'),
      );
      expect(nackCall).toBeDefined();
      expect(mockCleanupExecute).not.toHaveBeenCalled();

      mockFetch
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({ status: 200 });
      resolveJob1(createMockResult('job-active', 'session-A'));
      await poller.drain();

      poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), realSessionLock, 5);
      mockFetch
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(cleanupJob) })
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({ status: 200 });

      await poller.pollOnce();
      await poller.drain();

      expect(mockCleanupExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe('capacity limit', () => {
    it('skips polling when at max concurrency', async () => {
      const jobEnv = new JobEnvironment(false);
      poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), mockSessionLock, 2);

      let resolveJob1!: (v: TaskResultSubmission) => void;
      let resolveJob2!: (v: TaskResultSubmission) => void;

      const job1Promise = new Promise<TaskResultSubmission>((r) => { resolveJob1 = r; });
      const job2Promise = new Promise<TaskResultSubmission>((r) => { resolveJob2 = r; });

      mockClaudeExecute
        .mockReturnValueOnce(job1Promise)
        .mockReturnValueOnce(job2Promise);

      const job1 = createJob({ job_id: 'job-1', session_id: 'session-A' });
      const job2 = createJob({ job_id: 'job-2', session_id: 'session-B' });

      // Dispatch job1
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(job1),
      });
      await poller.pollOnce();
      await new Promise((r) => setTimeout(r, 10));

      // Dispatch job2
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(job2),
      });
      await poller.pollOnce();
      await new Promise((r) => setTimeout(r, 10));

      // At capacity now (2/2). Third poll should not fetch.
      const fetchCountBefore = mockFetch.mock.calls.length;
      await poller.pollOnce();

      // No additional fetch call should have been made
      expect(mockFetch.mock.calls.length).toBe(fetchCountBefore);

      // Clean up — queue result+ack responses for both jobs
      mockFetch
        .mockResolvedValueOnce({ status: 201 }) // result for job1
        .mockResolvedValueOnce({ status: 200 }) // ack for job1
        .mockResolvedValueOnce({ status: 201 }) // result for job2
        .mockResolvedValueOnce({ status: 200 }); // ack for job2
      resolveJob1(createMockResult('job-1', 'session-A'));
      resolveJob2(createMockResult('job-2', 'session-B'));
      await poller.drain();
    });
  });

  describe('back-off', () => {
    it('doubles poll interval when at capacity and resets when slot frees', async () => {
      vi.useFakeTimers();

      const jobEnv = new JobEnvironment(false);
      poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), mockSessionLock, 1);

      let resolveJob1!: (v: TaskResultSubmission) => void;
      const job1Promise = new Promise<TaskResultSubmission>((r) => { resolveJob1 = r; });
      mockClaudeExecute.mockReturnValueOnce(job1Promise);

      const job1 = createJob({ job_id: 'job-1', session_id: 'session-A' });

      // Access private field for verification
      const getInterval = () => (poller as unknown as { currentPollInterval: number }).currentPollInterval;

      // First poll dispatches job1, not using start() to avoid loop complexity
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(job1),
      });

      // Set up the base interval manually
      (poller as unknown as { basePollInterval: number }).basePollInterval = 1000;
      (poller as unknown as { currentPollInterval: number }).currentPollInterval = 1000;

      await poller.pollOnce();
      // Let microtask resolve so executeJob starts
      await vi.advanceTimersByTimeAsync(0);

      expect(getInterval()).toBe(1000); // still base

      // Now at capacity (1/1). Next pollOnce should back off.
      await poller.pollOnce();
      expect(getInterval()).toBe(2000); // doubled

      // Another poll still at capacity
      await poller.pollOnce();
      expect(getInterval()).toBe(4000); // doubled again

      // Resolve the job to free a slot
      mockFetch
        .mockResolvedValueOnce({ status: 201 })
        .mockResolvedValueOnce({ status: 200 });
      resolveJob1(createMockResult('job-1', 'session-A'));

      // Let the executeJob finish
      await vi.advanceTimersByTimeAsync(0);

      expect(getInterval()).toBe(1000); // reset to base

      vi.useRealTimers();
    });
  });

  describe('drain', () => {
    it('waits for all in-flight jobs to complete before resolving', async () => {
      const jobEnv = new JobEnvironment(false);
      poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), mockSessionLock, 5);

      let resolveJob1!: (v: TaskResultSubmission) => void;
      let resolveJob2!: (v: TaskResultSubmission) => void;

      const job1Promise = new Promise<TaskResultSubmission>((r) => { resolveJob1 = r; });
      const job2Promise = new Promise<TaskResultSubmission>((r) => { resolveJob2 = r; });

      mockClaudeExecute
        .mockReturnValueOnce(job1Promise)
        .mockReturnValueOnce(job2Promise);

      const job1 = createJob({ job_id: 'job-1', session_id: 'session-A' });
      const job2 = createJob({ job_id: 'job-2', session_id: 'session-B' });

      // Dispatch job1
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(job1),
      });
      await poller.pollOnce();

      // Dispatch job2
      mockFetch.mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(job2),
      });
      await poller.pollOnce();

      // Start drain
      let drained = false;
      mockFetch.mockResolvedValue({ status: 201 }); // for result posts and acks

      const drainPromise = poller.drain().then(() => { drained = true; });

      // drain should not have resolved yet
      await new Promise((r) => setTimeout(r, 10));
      expect(drained).toBe(false);

      // Resolve job1
      resolveJob1(createMockResult('job-1', 'session-A'));
      await new Promise((r) => setTimeout(r, 10));

      // Still waiting for job2
      expect(drained).toBe(false);

      // Resolve job2
      resolveJob2(createMockResult('job-2', 'session-B'));

      await drainPromise;
      expect(drained).toBe(true);

      // Both locks released
      expect(mockSessionLock.release).toHaveBeenCalledWith('session-A');
      expect(mockSessionLock.release).toHaveBeenCalledWith('session-B');
    });
  });
});
