import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Job, TaskResultSubmission, MAX_SNIPPET_CHARS } from '@local-agent/shared';
import { TaskOrchestrator } from '../core/task-orchestrator';
import { ClaudeExecutor } from '../adapters/claude-executor';
import { ExecutionEnvironment } from '../services/job-environment';
import { TaskPhasePublisher } from '../adapters/task-phase-publisher';

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

const mockResultSubmission: TaskResultSubmission = {
  job_id: 'job-456',
  task_id: 'abc-123',
  session_id: 'session-789',
  task_type: 'generic',
  status: 'success',
  exit_code: 0,
  stdout: 'result output',
  stderr: '',
  executor: 'claude',
  executor_model: 'opus',
};

const mockClaudePrecheck = vi.fn().mockResolvedValue({ ok: true });
const mockClaudeExecute = vi.fn().mockResolvedValue(mockResultSubmission);

vi.mock('../adapters/claude-executor', () => {
  return {
    ClaudeExecutor: vi.fn(function (this: { precheck: typeof mockClaudePrecheck; execute: typeof mockClaudeExecute }) {
      this.precheck = mockClaudePrecheck;
      this.execute = mockClaudeExecute;
    }),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
const mockPhasePublish = vi.fn();

vi.mock('../adapters/task-phase-publisher', () => ({
  TaskPhasePublisher: vi.fn().mockImplementation(function () {
    this.publish = mockPhasePublish;
  }),
}));

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

import { TaskPoller } from '../task-poller';
import { JobEnvironment } from '../services/job-environment';
import { SessionLockManager } from '../services/session-lock';

const mockSessionLock = {
  acquire: vi.fn().mockReturnValue(true),
  release: vi.fn(),
  isLockedByLiveProcess: vi.fn().mockReturnValue(false),
} as unknown as SessionLockManager;

describe('TaskPoller', () => {
  let poller: TaskPoller;

  beforeEach(() => {
    mockFetch.mockClear();
    mockClaudePrecheck.mockClear().mockResolvedValue({ ok: true });
    mockClaudeExecute.mockClear().mockResolvedValue(mockResultSubmission);
    mockSetup.mockClear().mockResolvedValue(mockEnv);
    mockTeardown.mockClear().mockResolvedValue(undefined);
    mockPhasePublish.mockClear().mockResolvedValue(undefined);
    vi.mocked(TaskPhasePublisher).mockClear();
    vi.mocked(ClaudeExecutor).mockClear();
    (mockSessionLock.acquire as ReturnType<typeof vi.fn>).mockClear().mockReturnValue(true);
    (mockSessionLock.release as ReturnType<typeof vi.fn>).mockClear();
    const jobEnv = new JobEnvironment(false);
    poller = new TaskPoller('http://localhost:3000', new TaskOrchestrator(jobEnv), mockSessionLock, 5);
  });

  afterEach(() => {
    poller.stop();
  });

  describe('pollOnce', () => {
    it('fetches active sessions, acknowledges a session job, then executes and posts result', async () => {
      const job = createJob();

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ sessions: [{ session_id: 'session-789', queue_name: 'jobs.session.session-789' }] }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        })
        .mockResolvedValueOnce({
          status: 201,
          json: () => Promise.resolve({ result_id: 'res-1' }),
        });

      await poller.pollOnce();
      await poller.drain();

      expect(mockPhasePublish).toHaveBeenNthCalledWith(1, job, 'executing');
      expect(mockPhasePublish).toHaveBeenNthCalledWith(2, job, 'completed');
      expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/jobs/sessions');
      expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs/next/session-789');
      expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/jobs/session-789/job-456/ack', {
        method: 'POST',
      });
      expect(mockFetch).toHaveBeenNthCalledWith(4, 'http://localhost:3000/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mockResultSubmission),
      });
    });

    it('still posts result after early ack even if result POST fails', async () => {
      const job = createJob();

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ sessions: [{ session_id: 'session-789', queue_name: 'jobs.session.session-789' }] }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job),
        })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
        .mockResolvedValueOnce({ status: 500 });

      await poller.pollOnce();
      await poller.drain();

      expect(mockPhasePublish).toHaveBeenCalledWith(job, 'executing');
      expect(mockPhasePublish).not.toHaveBeenCalledWith(job, 'completed');
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/jobs/session-789/job-456/ack', {
        method: 'POST',
      });
    });

    it('does not execute a fetched job when the immediate ACK request fails', async () => {
      const job = createJob();

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ sessions: [{ session_id: 'session-789', queue_name: 'jobs.session.session-789' }] }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job),
        })
        .mockResolvedValueOnce({ status: 404, json: () => Promise.resolve({ error: 'missing delivery' }) });

      await poller.pollOnce();
      await poller.drain();

      expect(mockClaudeExecute).not.toHaveBeenCalled();
      expect(mockPhasePublish).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockFetch.mock.calls.some((call) => String(call[0]).includes('/results'))).toBe(false);
    });

    it('does nothing when there are no active sessions', async () => {
      mockFetch.mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ sessions: [] }) });
      await poller.pollOnce();
      expect(mockClaudeExecute).not.toHaveBeenCalled();
    });

    it('treats 503 from session discovery as an empty cycle', async () => {
      mockFetch.mockResolvedValueOnce({
        status: 503,
        json: () => Promise.resolve({ error: 'Session queue discovery unavailable' }),
      });

      await expect(poller.pollOnce()).resolves.toBeUndefined();
      expect(mockClaudeExecute).not.toHaveBeenCalled();
    });

    it('recovers on the next successful poll after a 503 discovery failure', async () => {
      const job = createJob();

      mockFetch
        .mockResolvedValueOnce({
          status: 503,
          json: () => Promise.resolve({ error: 'Session queue discovery unavailable' }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ sessions: [{ session_id: 'session-789', queue_name: 'jobs.session.session-789' }] }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        })
        .mockResolvedValueOnce({
          status: 201,
          json: () => Promise.resolve({ result_id: 'res-1' }),
        });

      await poller.pollOnce();
      await poller.pollOnce();
      await poller.drain();

      expect(mockClaudeExecute).toHaveBeenCalledTimes(1);
    });

    it('forwards task_source from job to result submission', async () => {
      const taskSource = { source: 'lark' as const, message_id: 'om_abc123' };
      const job = createJob({ task_source: taskSource });

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ sessions: [{ session_id: 'session-789', queue_name: 'jobs.session.session-789' }] }),
        })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(job) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
        .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) });

      await poller.pollOnce();
      await poller.drain();

      const resultPostBody = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(resultPostBody.task_source).toEqual(taskSource);
      expect(mockPhasePublish).toHaveBeenCalledWith(job, 'executing');
    });

    it('truncates stdout and stderr to snippet length before publishing', async () => {
      const job = createJob();
      mockClaudeExecute.mockResolvedValueOnce({
        ...mockResultSubmission,
        stdout: 'x'.repeat(MAX_SNIPPET_CHARS + 10),
        stderr: 'y'.repeat(MAX_SNIPPET_CHARS + 20),
      });

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ sessions: [{ session_id: 'session-789', queue_name: 'jobs.session.session-789' }] }),
        })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(job) })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
        .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) });

      await poller.pollOnce();
      await poller.drain();

      const body = JSON.parse(mockFetch.mock.calls[3][1].body);
      expect(body.stdout).toHaveLength(MAX_SNIPPET_CHARS);
      expect(body.stderr).toHaveLength(MAX_SNIPPET_CHARS);
      expect(mockPhasePublish).toHaveBeenNthCalledWith(1, job, 'executing');
      expect(mockPhasePublish).toHaveBeenNthCalledWith(2, job, 'completed');
    });

    it('handles active-session fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
      await expect(poller.pollOnce()).resolves.toBeUndefined();
      expect(mockPhasePublish).not.toHaveBeenCalled();
    });

    it('continues job flow when phase publish fails', async () => {
      const job = createJob();
      mockPhasePublish.mockRejectedValueOnce(new Error('phase unavailable'));

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ sessions: [{ session_id: 'session-789', queue_name: 'jobs.session.session-789' }] }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job),
        })
        .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) })
        .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) });

      await poller.pollOnce();
      await poller.drain();

      expect(mockClaudeExecute).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenNthCalledWith(4, 'http://localhost:3000/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mockResultSubmission),
      });
    });
  });
});
