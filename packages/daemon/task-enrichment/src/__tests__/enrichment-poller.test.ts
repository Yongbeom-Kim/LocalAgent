import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Task, JobSubmission } from '@local-agent/shared';
import { EnrichmentService, EnrichmentResult } from '../enrichment-service';
import { ThreadContextFetcher } from '../adapters/thread-context-fetcher';

const mockEnrich = vi.fn();
const mockGetValidTaskTypes = vi.fn().mockReturnValue(new Set(['deploy', 'code_review', 'default']));
const { mockGenerateSessionId } = vi.hoisted(() => ({
  mockGenerateSessionId: vi.fn(),
}));

vi.mock('@local-agent/shared', async () => {
  const actual = await vi.importActual<typeof import('@local-agent/shared')>('@local-agent/shared');
  return {
    ...actual,
    generateSessionId: mockGenerateSessionId,
  };
});

vi.mock('../enrichment-service', () => ({
  EnrichmentService: vi.fn().mockImplementation(function () {
    this.enrich = mockEnrich;
    this.getValidTaskTypes = mockGetValidTaskTypes;
  }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this',
    submitted_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

function createJobSubmission(overrides?: Partial<JobSubmission>): JobSubmission {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    session_id: 'generated-session-id',
    payload: 'Review this',
    executors: [
      { executor: 'claude_code', executor_model: 'opus' },
    ],
    submitted_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

import { EnrichmentPoller } from '../enrichment-poller';

describe('EnrichmentPoller', () => {
  let poller: EnrichmentPoller;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateSessionId.mockReturnValue('generated-session-id');
    const service = new EnrichmentService() as any;
    poller = new EnrichmentPoller('http://localhost:3000', service);
  });

  afterEach(() => {
    poller.stop();
  });

  it('fetches task, enriches, posts job, then acks task', async () => {
    const task = createTask();
    const jobSubmission = createJobSubmission();
    const enrichmentResult: EnrichmentResult = { type: 'enriched', job: jobSubmission };
    mockEnrich.mockReturnValue(enrichmentResult);

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      })
      .mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve({ job_id: 'job-456', ...jobSubmission }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ acknowledged: true }),
      });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/tasks/next');
    expect(mockEnrich).toHaveBeenCalledWith(task, 'generated-session-id', undefined);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jobSubmission),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('does nothing when queue is empty (204)', async () => {
    mockFetch.mockResolvedValueOnce({ status: 204 });
    await poller.pollOnce();
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockGenerateSessionId).not.toHaveBeenCalled();
  });

  it('publishes failed result and acks task when enrichment rejects (no task_source)', async () => {
    const task = createTask();
    const rejectedResult: EnrichmentResult = { type: 'rejected', reason: 'Unknown task type "code_review"' };
    mockEnrich.mockReturnValue(rejectedResult);

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      })
      .mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve({ result_id: 'res-1' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ acknowledged: true }),
      });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'code_review',
        status: 'failure',
        exit_code: null,
        stdout: 'Unknown task type "code_review"',
        stderr: '',
      }),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('publishes failed result and acks task when enrichment rejects', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockEnrich.mockReturnValue({
      type: 'rejected',
      reason: 'Unknown task type "bad". Available types: generic, code_review',
    });

    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve(task),
      })
      .mockResolvedValueOnce({
        status: 201,
        json: () => Promise.resolve({ result_id: 'res-1' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ acknowledged: true }),
      });

    await poller.pollOnce();

    // Verify POST /results with failure
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'code_review',
        status: 'failure',
        exit_code: null,
        stdout: 'Unknown task type "bad". Available types: generic, code_review',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
    // Verify task is acked
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('rejects cleanup task without lark source', async () => {
    const task = createTask({
      task_type: 'cleanup',
      payload: '',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockGenerateSessionId).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'cleanup',
        status: 'failure',
        exit_code: null,
        stdout: 'Cleanup tasks require a Lark task source to resolve the existing session.',
        stderr: '',
      }),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('handles fetch errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    await expect(poller.pollOnce()).resolves.toBeUndefined();
  });
});

describe('EnrichmentPoller with ThreadContextFetcher', () => {
  let poller: EnrichmentPoller;
  let mockThreadFetcher: { fetchThreadContext: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateSessionId.mockReturnValue('generated-session-id');
    const service = new EnrichmentService() as any;
    mockThreadFetcher = { fetchThreadContext: vi.fn() };
    poller = new EnrichmentPoller(
      'http://localhost:3000',
      service,
      mockThreadFetcher as unknown as ThreadContextFetcher,
    );
  });

  afterEach(() => {
    poller.stop();
  });

  it('passes thread history separately when task has lark source and thread exists', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'now fix the tests',
    });
    const originalPayload = task.payload;
    const jobSubmission = createJobSubmission({ payload: originalPayload });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({ threadContext: 'user: fix CI', inheritedTaskType: null, inheritedSessionId: null });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockThreadFetcher.fetchThreadContext).toHaveBeenCalledWith('om_msg1', expect.any(Set));
    expect(task.payload).toBe(originalPayload);
    expect(mockEnrich).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: originalPayload,
      }),
      'generated-session-id',
      'user: fix CI',
    );
  });

  it('generates new session_id when no thread', async () => {
    const task = createTask({ payload: 'hello' });
    const jobSubmission = createJobSubmission({ payload: 'hello', session_id: 'generated-session-id' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).toHaveBeenCalledTimes(1);
    expect(mockThreadFetcher.fetchThreadContext).not.toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }), 'generated-session-id', undefined);
  });

  it('generates new session_id when thread has no inherited session_id', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'hello',
    });
    const jobSubmission = createJobSubmission({ payload: 'hello', session_id: 'generated-session-id' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: null,
      inheritedTaskType: null,
      inheritedSessionId: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).toHaveBeenCalledTimes(1);
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }), 'generated-session-id', undefined);
  });

  it('inherits session_id from thread when available', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'hello',
    });
    const jobSubmission = createJobSubmission({ payload: 'hello', session_id: 'inherited-session-id' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: null,
      inheritedTaskType: null,
      inheritedSessionId: 'inherited-session-id',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).not.toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }), 'inherited-session-id', undefined);
  });

  it('generates new session_id when thread fetch returns null', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'hello',
    });
    const jobSubmission = createJobSubmission({ payload: 'hello', session_id: 'generated-session-id' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue(null);

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).toHaveBeenCalledTimes(1);
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }), 'generated-session-id', undefined);
  });

  it('passes undefined history when thread has no context', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'hello',
    });
    const jobSubmission = createJobSubmission({ payload: 'hello', session_id: 'generated-session-id' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: null,
      inheritedTaskType: null,
      inheritedSessionId: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(task.payload).toBe('hello');
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }), 'generated-session-id', undefined);
  });

  it('inherits generic task_type from thread and passes thread history separately', async () => {
    const task = createTask({
      task_type: 'generic',
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'follow up',
    });
    const originalPayload = task.payload;
    const jobSubmission = createJobSubmission({
      task_type: 'deploy',
      payload: originalPayload,
    });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: deploy the app\nassistant: Job abc — success',
      inheritedTaskType: 'deploy',
      inheritedSessionId: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(task.payload).toBe(originalPayload);
    expect(mockEnrich).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: 'deploy',
        payload: originalPayload,
      }),
      'generated-session-id',
      'user: deploy the app\nassistant: Job abc — success',
    );
  });

  it('accepts matching explicit task_type in thread and passes thread history separately', async () => {
    const task = createTask({
      task_type: 'deploy',
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'follow up',
    });
    const originalPayload = task.payload;
    const jobSubmission = createJobSubmission({
      task_type: 'deploy',
      payload: originalPayload,
    });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: deploy the app\nassistant: Job abc — success',
      inheritedTaskType: 'deploy',
      inheritedSessionId: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(task.payload).toBe(originalPayload);
    expect(mockEnrich).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: 'deploy',
        payload: originalPayload,
      }),
      'generated-session-id',
      'user: deploy the app\nassistant: Job abc — success',
    );
  });

  it('rejects differing explicit task_type in thread and does not enrich', async () => {
    const task = createTask({
      task_type: 'code_review',
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'review this',
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: deploy the app\nassistant: Job abc — success',
      inheritedTaskType: 'deploy',
      inheritedSessionId: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'code_review',
        status: 'failure',
        exit_code: null,
        stdout: "Cannot change task type in a thread. This thread uses task_type 'deploy'. Remove the /task prefix or start a new conversation.",
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('rejects cleanup task when thread fetch returns null', async () => {
    const task = createTask({
      task_type: 'cleanup',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue(null);

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockGenerateSessionId).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'cleanup',
        status: 'failure',
        exit_code: null,
        stdout: 'Cleanup tasks require an existing thread with an inherited session_id.',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });

  it('rejects cleanup task without inherited session_id', async () => {
    const task = createTask({
      task_type: 'cleanup',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: please end this session\nassistant: acknowledged',
      inheritedTaskType: 'deploy',
      inheritedSessionId: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockGenerateSessionId).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'cleanup',
        status: 'failure',
        exit_code: null,
        stdout: 'Cleanup tasks in existing threads require an inherited session_id from the thread root.',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });

  it('bypasses inherited task_type mismatch for cleanup and skips thread history', async () => {
    const task = createTask({
      task_type: 'cleanup',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    const jobSubmission = createJobSubmission({
      task_type: 'cleanup',
      payload: '',
      session_id: 'inherited-session-id',
      executors: [{ executor: 'builtin', executor_model: 'none' }],
    });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: deploy the app\nassistant: Job abc — success',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'inherited-session-id',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(task.task_type).toBe('cleanup');
    expect(mockGenerateSessionId).not.toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: 'cleanup',
        payload: '',
      }),
      'inherited-session-id',
      undefined,
    );
  });

  it('keeps current behavior when no inherited type found', async () => {
    const task = createTask({
      task_type: 'generic',
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'hello',
    });
    const jobSubmission = createJobSubmission({ task_type: 'generic' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: hello\nassistant: Job abc — success',
      inheritedTaskType: null,
      inheritedSessionId: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).toHaveBeenCalledWith(
      expect.objectContaining({ task_type: 'generic', payload: 'hello' }),
      'generated-session-id',
      'user: hello\nassistant: Job abc — success',
    );
  });
});
