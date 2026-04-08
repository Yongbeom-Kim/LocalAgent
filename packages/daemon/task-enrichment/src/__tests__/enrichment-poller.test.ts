import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Task,
  JobSubmission,
  buildApiAuthHeaders,
  buildCleanupSubtreePayload,
  type LarkInboundEnvelope,
  formatUnknownTaskTypeMessage,
  formatMissingTaskTypeMessage,
  formatMissingPayloadMessage,
  formatThreadReplyHelpMessage,
  formatThreadTaskCommandRejectedMessage,
  formatThreadOnlyCommandMessage,
} from '@local-agent/shared';
import { EnrichmentService, EnrichmentResult } from '../enrichment-service';
import { ThreadContextFetcher } from '../adapters/thread-context-fetcher';
import { TelegramThreadContextFetcher } from '../adapters/telegram-thread-context-fetcher';
import { TaskPhasePublisher } from '../adapters/task-phase-publisher';

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
    formatThreadTaskCommandRejectedMessage: () =>
      'Cannot use /task in a thread. Reply with natural language, /status, /new, or /end.\nUse /task only as a new root message.',
    formatThreadOnlyCommandMessage: (command: '/status' | '/new' | '/end') =>
      `The ${command} command can only be used inside a thread.`,
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
const mockPhasePublish = vi.fn();

vi.mock('../adapters/task-phase-publisher', async () => {
  const actual = await vi.importActual<typeof import('../adapters/task-phase-publisher')>('../adapters/task-phase-publisher');
  return {
    ...actual,
    TaskPhasePublisher: vi.fn().mockImplementation(function () {
      this.publish = mockPhasePublish;
    }),
  };
});

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this',
    submitted_at: '2026-03-29T00:00:00.000Z',
    executor: 'claude',
    executor_model: 'sonnet',
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
      { executor: 'claude', executor_model: 'opus' },
    ],
    submitted_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

function createInboundEnvelope(overrides?: Partial<LarkInboundEnvelope>): LarkInboundEnvelope {
  return {
    platform: 'lark',
    schema_version: 1,
    message_id: 'om_root_inbound',
    root_message_id: 'om_root_inbound',
    thread_id: null,
    chat_type: 'p2p',
    sender_open_id: 'ou_sender',
    sender_type: 'user',
    message_type: 'text',
    raw_content: '{"text":"/task deploy claude sonnet fix prod"}',
    normalized_text: '/task deploy claude sonnet fix prod',
    mentions: [],
    is_normalizable: true,
    occurred_at_ms: 1710000000000,
    ...overrides,
  };
}

import { EnrichmentPoller } from '../enrichment-poller';

describe('EnrichmentPoller', () => {
  let poller: EnrichmentPoller;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockEnrich.mockReset();
    mockGetValidTaskTypes.mockReset();
    mockGetValidTaskTypes.mockReturnValue(new Set(['deploy', 'code_review', 'default']));
    mockGenerateSessionId.mockReset();
    mockGenerateSessionId.mockReturnValue('generated-session-id');
    mockPhasePublish.mockReset().mockResolvedValue(undefined);
    vi.mocked(TaskPhasePublisher).mockClear();
    const service = new EnrichmentService() as any;
    poller = new EnrichmentPoller('http://localhost:3000', 'http://task-daemon:7070', service, undefined, undefined, 'daemon-token');
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

    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, expect.objectContaining({ ...task, session_id: 'generated-session-id' }), 'queued');
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ ...task, session_id: 'generated-session-id' }), 'generated-session-id', undefined);
    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://localhost:3000/tasks/next', {
      headers: buildApiAuthHeaders('daemon-token'),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildApiAuthHeaders('daemon-token'),
      },
      body: JSON.stringify(jobSubmission),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
      headers: buildApiAuthHeaders('daemon-token'),
    });
  });

  it('stops polling when GET /tasks/next returns 401', async () => {
    mockFetch.mockResolvedValueOnce({ status: 401 });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/tasks/next', {
      headers: buildApiAuthHeaders('daemon-token'),
    });

    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockPhasePublish).not.toHaveBeenCalled();
  });

  it('does nothing when queue is empty (204)', async () => {
    mockFetch.mockResolvedValueOnce({ status: 204 });
    await poller.pollOnce();
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockGenerateSessionId).not.toHaveBeenCalled();
    expect(mockPhasePublish).not.toHaveBeenCalled();
  });

  it('publishes failed result and acks task when enrichment rejects (no task_source)', async () => {
    const task = createTask();
    const rejectedResult: EnrichmentResult = {
      type: 'rejected',
      reason: formatUnknownTaskTypeMessage('code_review', ['deploy', 'code_review', 'default']),
    };
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

    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, task, 'completed');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'code_review',
        status: 'failure',
        exit_code: null,
        stdout: formatUnknownTaskTypeMessage('code_review', ['deploy', 'code_review', 'default']),
        stderr: '',
      }),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
      headers: buildApiAuthHeaders('daemon-token'),
    });
  });

  it('publishes failed result and acks task when enrichment rejects', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockEnrich.mockReturnValue({
      type: 'rejected',
      reason: formatUnknownTaskTypeMessage('bad', ['generic', 'code_review']),
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

    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, task, 'completed');
    // Verify POST /results with failure
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'code_review',
        status: 'failure',
        exit_code: null,
        stdout: formatUnknownTaskTypeMessage('bad', ['generic', 'code_review']),
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
    // Verify task is acked
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
      headers: buildApiAuthHeaders('daemon-token'),
    });
  });

  it('publishes invalid-model rejection text verbatim for lark tasks', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      task_type: 'localagent',
      executor: 'cursor',
      executor_model: 'xyz',
    });

    mockEnrich.mockReturnValue({
      type: 'rejected',
      reason: 'Invalid model "xyz" for executor "cursor". Available models: auto, composer-2-fast',
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

    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, task, 'completed');
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'localagent',
        status: 'failure',
        exit_code: null,
        stdout: 'Invalid model "xyz" for executor "cursor". Available models: auto, composer-2-fast',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });

  it('publishes missing-task-type help verbatim for lark tasks', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      task_type: '',
      payload: '',
    });

    mockEnrich.mockReturnValue({
      type: 'rejected',
      reason: formatMissingTaskTypeMessage(['generic', 'localagent']),
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

    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, task, 'completed');
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: '',
        status: 'failure',
        exit_code: null,
        stdout: formatMissingTaskTypeMessage(['generic', 'localagent']),
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });

  it('publishes payload-required help verbatim for lark tasks', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      task_type: 'localagent',
      executor: 'cursor',
      executor_model: 'auto',
      payload: '',
    });

    mockEnrich.mockReturnValue({
      type: 'rejected',
      reason: formatMissingPayloadMessage(),
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

    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, task, 'completed');
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'localagent',
        status: 'failure',
        exit_code: null,
        stdout: formatMissingPayloadMessage(),
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
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

    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, task, 'completed');
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockGenerateSessionId).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
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
      headers: buildApiAuthHeaders('daemon-token'),
    });
  });

  it('creates minimal job for base-message gc task and does not enrich', async () => {
    const task = createTask({
      task_type: 'gc',
      payload: 'ignored payload',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-gc-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, expect.objectContaining({ ...task, session_id: 'generated-session-id' }), 'queued');
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        task_id: 'task-123',
        task_type: 'gc',
        payload: 'ignored payload',
        executors: [{ executor: 'claude', executor_model: 'sonnet' }],
        submitted_at: '2026-03-29T00:00:00.000Z',
        session_id: 'generated-session-id',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
      headers: buildApiAuthHeaders('daemon-token'),
    });
  });

  it('does not ack gc task when POST /jobs fails', async () => {
    const task = createTask({
      task_type: 'gc',
      payload: '',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 500, json: () => Promise.resolve({ error: 'nope' }) });

    await poller.pollOnce();

    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).not.toHaveBeenCalledWith('http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
      headers: buildApiAuthHeaders('daemon-token'),
    });
  });

  it('handles fetch errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    await expect(poller.pollOnce()).resolves.toBeUndefined();
    expect(mockPhasePublish).not.toHaveBeenCalled();
  });

  it('continues main workflow when phase publish fails', async () => {
    const task = createTask();
    const jobSubmission = createJobSubmission();
    const enrichmentResult: EnrichmentResult = { type: 'enriched', job: jobSubmission };
    mockEnrich.mockReturnValue(enrichmentResult);
    mockPhasePublish.mockRejectedValueOnce(new Error('phase unavailable'));

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

    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify(jobSubmission),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
      headers: buildApiAuthHeaders('daemon-token'),
    });
  });
});

describe('EnrichmentPoller with ThreadContextFetcher', () => {
  let poller: EnrichmentPoller;
  let mockThreadFetcher: { fetchThreadContext: ReturnType<typeof vi.fn> };
  let mockSessionRepository: {
    listDescendantSessionIds: ReturnType<typeof vi.fn>;
    upsertSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockEnrich.mockReset();
    mockGetValidTaskTypes.mockReset();
    mockGetValidTaskTypes.mockReturnValue(new Set(['deploy', 'code_review', 'default']));
    mockGenerateSessionId.mockReset();
    mockGenerateSessionId.mockReturnValue('generated-session-id');
    mockPhasePublish.mockReset().mockResolvedValue(undefined);
    vi.mocked(TaskPhasePublisher).mockClear();
    const service = new EnrichmentService() as any;
    mockThreadFetcher = { fetchThreadContext: vi.fn() };
    mockSessionRepository = {
      listDescendantSessionIds: vi.fn().mockResolvedValue([]),
      upsertSession: vi.fn().mockResolvedValue(undefined),
    };
    poller = new EnrichmentPoller(
      'http://localhost:3000',
      'http://task-daemon:7070',
      service,
      mockThreadFetcher as unknown as ThreadContextFetcher,
      undefined,
      'daemon-token',
    );
  });

  afterEach(() => {
    poller.stop();
  });

  it('rejects any threaded non-control lark task before creating a job', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'review this diff',
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      kind: 'thread',
      threadContext: 'user: deploy the app\nassistant: Job abc — success',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'thread-session-id',
      inheritedExecutor: 'claude',
      inheritedExecutorModel: 'sonnet',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockThreadFetcher.fetchThreadContext).toHaveBeenCalledWith('om_msg1', expect.any(Set));
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'code_review',
        status: 'failure',
        exit_code: null,
        stdout: formatThreadTaskCommandRejectedMessage(),
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
      headers: buildApiAuthHeaders('daemon-token'),
    });
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
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({ kind: 'not_thread' });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).toHaveBeenCalledTimes(1);
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }), 'generated-session-id', undefined);
  });

  it('generates new session_id when thread fetch returns null', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'hello',
    });
    const jobSubmission = createJobSubmission({ payload: 'hello', session_id: 'generated-session-id' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({ kind: 'not_thread' });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).toHaveBeenCalledTimes(1);
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }), 'generated-session-id', undefined);
  });

  it('passes undefined history when thread fetch returns null', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'hello',
    });
    const jobSubmission = createJobSubmission({ payload: 'hello', session_id: 'generated-session-id' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({ kind: 'not_thread' });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(task.payload).toBe('hello');
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ payload: 'hello' }), 'generated-session-id', undefined);
  });

  it('rejects threaded gc task and acks it', async () => {
    const task = createTask({
      task_type: 'gc',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      kind: 'thread',
      threadContext: 'user: please run cleanup',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'thread-session-id',
      inheritedExecutor: null,
      inheritedExecutorModel: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-gc-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'gc',
        status: 'failure',
        exit_code: null,
        stdout: 'The /gc command can only be used as a base message, not inside a thread.',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
      headers: buildApiAuthHeaders('daemon-token'),
    });
  });

  it('rejects gc task when thread context exists without inherited metadata', async () => {
    const task = createTask({
      task_type: 'gc',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      kind: 'thread',
      threadContext: 'assistant: earlier response',
      inheritedTaskType: null,
      inheritedSessionId: null,
      inheritedExecutor: null,
      inheritedExecutorModel: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-gc-2' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockGenerateSessionId).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'gc',
        status: 'failure',
        exit_code: null,
        stdout: 'The /gc command can only be used as a base message, not inside a thread.',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
      headers: buildApiAuthHeaders('daemon-token'),
    });
  });

  it('includes generated session_id, task_source, and placeholder executors in gc job', async () => {
    const task = createTask({
      task_type: 'gc',
      payload: '24h',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({ kind: 'not_thread' });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-gc-2' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).toHaveBeenCalledTimes(1);
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        task_id: 'task-123',
        task_type: 'gc',
        payload: '24h',
        executors: [{ executor: 'claude', executor_model: 'sonnet' }],
        submitted_at: '2026-03-29T00:00:00.000Z',
        session_id: 'generated-session-id',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });

  it('rejects cleanup task when thread fetch returns null', async () => {
    const task = createTask({
      task_type: 'cleanup',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({ kind: 'not_thread' });

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
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'cleanup',
        status: 'failure',
        exit_code: null,
        stdout: formatThreadOnlyCommandMessage('/end'),
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
      kind: 'thread',
      threadContext: 'user: please end this session\nassistant: acknowledged',
      inheritedTaskType: 'deploy',
      inheritedSessionId: null,
      inheritedExecutor: null,
      inheritedExecutorModel: null,
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
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
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
      kind: 'thread',
      threadContext: 'user: deploy the app\nassistant: Job abc — success',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'inherited-session-id',
      inheritedExecutor: 'cursor',
      inheritedExecutorModel: 'auto',
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
        payload: buildCleanupSubtreePayload(['inherited-session-id']),
      }),
      'inherited-session-id',
      undefined,
    );
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify(jobSubmission),
    });
  });

  it('uses explicit task.executor/task.executor_model for /new override', async () => {
    const task = createTask({
      task_type: 'new_instance',
      payload: '',
      executor: 'cursor',
      executor_model: 'auto',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockEnrich.mockReturnValue({
      type: 'enriched',
      job: createJobSubmission({
        task_type: 'deploy',
        payload: 'Respond with: New session instance started.',
        session_id: 'thread-session-id',
        executors: [{ executor: 'claude', executor_model: 'opus' }],
      }),
    } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      kind: 'thread',
      threadContext: 'assistant: earlier',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'thread-session-id',
      inheritedExecutor: 'claude',
      inheritedExecutorModel: 'sonnet',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    const posted = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(posted.executors).toEqual([{ executor: 'cursor', executor_model: 'auto' }]);
  });

  it('falls back to claude/sonnet for bare /new when no pair is inherited', async () => {
    const task = createTask({
      task_type: 'new_instance',
      payload: '',
      executor: undefined,
      executor_model: undefined,
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockEnrich.mockReturnValue({
      type: 'enriched',
      job: createJobSubmission({
        task_type: 'deploy',
        payload: 'Respond with: New session instance started.',
        session_id: 'thread-session-id',
        executors: [{ executor: 'claude', executor_model: 'sonnet' }],
      }),
    } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      kind: 'thread',
      threadContext: 'assistant: earlier',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'thread-session-id',
      inheritedExecutor: null,
      inheritedExecutorModel: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    const posted = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(posted.executors).toEqual([{ executor: 'claude', executor_model: 'sonnet' }]);
  });

  it('uses inherited executor pair for bare /new when available', async () => {
    const task = createTask({
      task_type: 'new_instance',
      payload: '',
      executor: undefined,
      executor_model: undefined,
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockEnrich.mockReturnValue({
      type: 'enriched',
      job: createJobSubmission({
        task_type: 'deploy',
        payload: 'Respond with: New session instance started.',
        session_id: 'thread-session-id',
        executors: [{ executor: 'claude', executor_model: 'opus' }],
      }),
    } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      kind: 'thread',
      threadContext: 'assistant: earlier',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'thread-session-id',
      inheritedExecutor: 'cursor',
      inheritedExecutorModel: 'auto',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    const posted = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(posted.executors).toEqual([{ executor: 'cursor', executor_model: 'auto' }]);
  });

  it('rejects status task outside thread', async () => {
    const task = createTask({
      task_type: 'status',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({ kind: 'not_thread' });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'status',
        status: 'failure',
        exit_code: null,
        stdout: 'The /status command can only be used inside a thread.',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });

  it('rejects status task without inherited thread metadata', async () => {
    const task = createTask({
      task_type: 'status',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      kind: 'thread',
      threadContext: 'assistant: prior',
      inheritedTaskType: 'deploy',
      inheritedSessionId: null,
      inheritedExecutor: 'claude',
      inheritedExecutorModel: 'sonnet',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'status',
        status: 'failure',
        exit_code: null,
        stdout: 'The /status command requires an existing session in this thread.',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });

  it('rejects status task when inherited thread metadata is incomplete', async () => {
    const task = createTask({
      task_type: 'status',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      kind: 'thread',
      threadContext: 'assistant: prior',
      inheritedTaskType: null,
      inheritedSessionId: 'thread-session-id',
      inheritedExecutor: 'claude',
      inheritedExecutorModel: 'sonnet',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'status',
        status: 'failure',
        exit_code: null,
        stdout: 'Cannot check /status because the inherited thread metadata is incomplete.',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });

  it('publishes running status with inherited headers', async () => {
    const task = createTask({
      task_type: 'status',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      kind: 'thread',
      threadContext: 'assistant: prior',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'thread-session-id',
      inheritedExecutor: 'claude',
      inheritedExecutorModel: 'sonnet',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ running: true, active_session_count: 2, session_directory_count: 17 }),
      })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, task, 'completed');
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://task-daemon:7070/status/thread-session-id', {
      signal: expect.any(AbortSignal),
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'deploy',
        session_id: 'thread-session-id',
        executor: 'claude',
        executor_model: 'sonnet',
        status: 'success',
        exit_code: 0,
        stdout: 'Current thread session: executor running\nSessions with ongoing executor: 2\nSession directories on disk: 17',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });

  it('publishes not-running status with inherited headers', async () => {
    const task = createTask({
      task_type: 'status',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      kind: 'thread',
      threadContext: 'assistant: prior',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'thread-session-id',
      inheritedExecutor: 'cursor',
      inheritedExecutorModel: 'auto',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ running: false, active_session_count: 0, session_directory_count: 21 }),
      })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, task, 'completed');
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'deploy',
        session_id: 'thread-session-id',
        executor: 'cursor',
        executor_model: 'auto',
        status: 'success',
        exit_code: 0,
        stdout: 'Current thread session: idle\nSessions with ongoing executor: 0\nSession directories on disk: 21',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });

  it('publishes failure when status lookup throws', async () => {
    const task = createTask({
      task_type: 'status',
      payload: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      kind: 'thread',
      threadContext: 'assistant: prior',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'thread-session-id',
      inheritedExecutor: 'claude',
      inheritedExecutorModel: 'sonnet',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'status',
        status: 'failure',
        exit_code: null,
        stdout: 'Failed to check live executor status. Please retry in the thread.',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
  });
});

describe('TelegramThreadContextFetcher', () => {
  it('returns inherited task metadata for a mapped telegram topic', async () => {
    const fetcher = new TelegramThreadContextFetcher({
      getTelegramThreadByTopic: vi.fn().mockResolvedValue({
        chatId: '-100123',
        topicId: '42',
        sessionId: 'session-1',
        source: 'telegram',
        taskType: 'coding',
        executor: 'claude',
        executorModel: 'sonnet',
        status: 'active',
        seedMessageId: '1',
        statusMessageId: null,
        metadataJson: null,
        createdAtMs: 100,
        updatedAtMs: 100,
        endedAtMs: null,
      }),
      listTelegramMessagesForTopic: vi.fn().mockResolvedValue([
        {
          chatId: '-100123',
          messageId: '10',
          topicId: '42',
          sessionId: 'session-1',
          direction: 'inbound',
          senderType: 'user',
          messageType: 'text',
          rawContent: 'hello',
          normalizedText: 'hello',
          metadataJson: null,
          createdAtMs: 100,
        },
      ]),
    } as any);

    await expect(fetcher.fetchThreadContext('-100123', '42')).resolves.toEqual({
      kind: 'thread',
      threadContext: 'user: hello',
      inheritedTaskType: 'coding',
      inheritedSessionId: 'session-1',
      inheritedExecutor: 'claude',
      inheritedExecutorModel: 'sonnet',
    });
  });

  it('returns not_thread for an unmapped telegram topic', async () => {
    const fetcher = new TelegramThreadContextFetcher({
      getTelegramThreadByTopic: vi.fn().mockResolvedValue(null),
      listTelegramMessagesForTopic: vi.fn(),
    } as any);

    await expect(fetcher.fetchThreadContext('-100123', '99')).resolves.toEqual({
      kind: 'not_thread',
      threadContext: null,
      inheritedTaskType: null,
      inheritedSessionId: null,
      inheritedExecutor: null,
      inheritedExecutorModel: null,
    });
  });
});

describe('EnrichmentPoller canonical ingress flow', () => {
  let poller: EnrichmentPoller;
  let mockThreadFetcher: { fetchThreadContext: ReturnType<typeof vi.fn> };
  let mockSessionRepository: {
    listDescendantSessionIds: ReturnType<typeof vi.fn>;
    upsertSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockEnrich.mockReset();
    mockGetValidTaskTypes.mockReset();
    mockGetValidTaskTypes.mockReturnValue(new Set(['deploy', 'code_review', 'default']));
    mockGenerateSessionId.mockReset();
    mockGenerateSessionId.mockReturnValue('generated-session-id');
    mockPhasePublish.mockReset().mockResolvedValue(undefined);
    vi.mocked(TaskPhasePublisher).mockClear();
    const service = new EnrichmentService() as any;
    mockThreadFetcher = { fetchThreadContext: vi.fn() };
    mockSessionRepository = {
      listDescendantSessionIds: vi.fn().mockResolvedValue([]),
      upsertSession: vi.fn().mockResolvedValue(undefined),
    };
    poller = new EnrichmentPoller(
      'http://localhost:3000',
      'http://task-daemon:7070',
      service,
      mockThreadFetcher as unknown as ThreadContextFetcher,
      undefined,
      'daemon-token',
    );
  });

  afterEach(() => {
    poller.stop();
  });

  it('consumes canonical tasks with session_id without decoding channel envelopes', async () => {
    const task = createTask({
      task_type: 'code_review',
      payload: 'review this',
      session_id: 'sess-1',
      task_source: { source: 'lark', message_id: 'om_1' },
      context_ref: { platform: 'lark', root_key: 'om_root_1' },
    });
    const jobSubmission = createJobSubmission({ payload: 'review this', session_id: 'sess-1' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({ kind: 'not_thread' });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({ session_id: 'sess-1' }), 'sess-1', undefined);
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify(jobSubmission),
    });
    expect(mockGenerateSessionId).not.toHaveBeenCalled();
  });

  it('does not instantiate channel topic or anchor creators during canonical enrichment', async () => {
    const task = createTask({
      payload: 'review this',
      session_id: 'sess-1',
      task_source: { source: 'telegram', chat_id: '-100', topic_id: '42', message_id: '10' },
      context_ref: { platform: 'telegram', root_key: '-100:42' },
    });
    const jobSubmission = createJobSubmission({ payload: 'review this', session_id: 'sess-1' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);

    const telegramThreadContextFetcher = { fetchThreadContext: vi.fn().mockResolvedValue({ kind: 'not_thread' }) };
    poller = new EnrichmentPoller(
      'http://localhost:3000',
      'http://task-daemon:7070',
      new EnrichmentService() as any,
      mockThreadFetcher as unknown as ThreadContextFetcher,
      undefined,
      'daemon-token',
      undefined,
      {
        telegramThreadContextFetcher: telegramThreadContextFetcher as any,
        sessionRepository: mockSessionRepository as any,
      },
    );

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(telegramThreadContextFetcher.fetchThreadContext).toHaveBeenCalledWith('-100', '42');
    expect(mockFetch).not.toHaveBeenCalledWith('http://localhost:3000/results', expect.objectContaining({
      body: expect.stringContaining('"event_kind":"mirror"'),
    }));
  });

  it('keeps explicit child session ids on telegram topics and persists root lineage', async () => {
    const task = createTask({
      task_type: 'code_review',
      payload: 'review child session',
      session_id: 'child-session',
      context_ref: { platform: 'telegram', root_key: '-100:42' },
      task_source: { source: 'telegram', chat_id: '-100', topic_id: '42', message_id: '10' },
    });
    const jobSubmission = createJobSubmission({
      payload: 'review child session',
      session_id: 'child-session',
      context_ref: { platform: 'telegram', root_key: '-100:42' },
    });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);

    const telegramThreadContextFetcher = {
      fetchThreadContext: vi.fn().mockResolvedValue({
        kind: 'thread',
        threadContext: 'user: root asks\nassistant: root answer',
        inheritedTaskType: 'code_review',
        inheritedSessionId: 'root-session',
        inheritedExecutor: 'claude',
        inheritedExecutorModel: 'sonnet',
      }),
    };
    poller = new EnrichmentPoller(
      'http://localhost:3000',
      'http://task-daemon:7070',
      new EnrichmentService() as any,
      mockThreadFetcher as unknown as ThreadContextFetcher,
      undefined,
      'daemon-token',
      undefined,
      {
        telegramThreadContextFetcher: telegramThreadContextFetcher as any,
        sessionRepository: mockSessionRepository as any,
      },
    );

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).not.toHaveBeenCalled();
    expect(telegramThreadContextFetcher.fetchThreadContext).toHaveBeenCalledWith('-100', '42');
    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'child-session',
      context_ref: { platform: 'telegram', root_key: '-100:42' },
    }), 'child-session', 'user: root asks\nassistant: root answer');
    expect(mockSessionRepository.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'child-session',
      parentSessionId: 'root-session',
      taskType: 'code_review',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
    }));
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildApiAuthHeaders('daemon-token') },
      body: JSON.stringify(jobSubmission),
    });
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, expect.objectContaining({
      task_id: 'task-123',
      session_id: 'child-session',
      context_ref: { platform: 'telegram', root_key: '-100:42' },
    }), 'queued');
  });

  it('publishes queued phase events with context_ref for explicit child-session work', async () => {
    const task = createTask({
      task_type: 'code_review',
      payload: 'review child session',
      session_id: 'child-session',
      context_ref: { platform: 'lark', root_key: 'om_root_shared' },
      task_source: { source: 'lark', message_id: 'om_child_task' },
    });
    const jobSubmission = createJobSubmission({
      payload: 'review child session',
      session_id: 'child-session',
      context_ref: { platform: 'lark', root_key: 'om_root_shared' },
    });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({ kind: 'not_thread' });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockEnrich).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'child-session',
      context_ref: { platform: 'lark', root_key: 'om_root_shared' },
    }), 'child-session', undefined);
    expect(mockPhasePublish).toHaveBeenNthCalledWith(1, task, 'enriching');
    expect(mockPhasePublish).toHaveBeenNthCalledWith(2, expect.objectContaining({
      task_id: 'task-123',
      session_id: 'child-session',
      context_ref: { platform: 'lark', root_key: 'om_root_shared' },
    }), 'queued');
  });
});
