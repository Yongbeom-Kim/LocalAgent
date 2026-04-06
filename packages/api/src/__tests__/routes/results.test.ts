import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Test } from 'supertest';
import { createResultRoutes } from '../../routes/results';
import { RabbitMQUnavailableError } from '../../services/rabbitmq';
import { createApiAuthMiddleware } from '../../middleware/auth';

vi.mock('../../services/rabbitmq', () => {
  class MockRabbitMQUnavailableError extends Error {
    constructor(message = 'RabbitMQ temporarily unavailable') {
      super(message);
      this.name = 'RabbitMQUnavailableError';
    }
  }

  return {
    RabbitMQUnavailableError: MockRabbitMQUnavailableError,
  };
});

vi.mock('@local-agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@local-agent/shared')>();
  const constants = await import('../../../../shared/src/constants');
  const types = await import('../../../../shared/src/types');

  return {
    ...actual,
    TASK_EVENT_KINDS: constants.TASK_EVENT_KINDS,
    RESULT_STATUSES: types.RESULT_STATUSES,
    DEFAULT_RESULTS_EXCHANGE_NAME: constants.DEFAULT_RESULTS_EXCHANGE_NAME,
    isValidTaskPhase: types.isValidTaskPhase,
    isValidTaskSource: types.isValidTaskSource,
    isTaskExecutorType: types.isTaskExecutorType,
    isValidExecutorModel: types.isValidExecutorModel,
  };
});

const mockRabbitMQ = {
  publishToExchange: vi.fn().mockResolvedValue(true),
  getNextFromQueue: vi.fn(),
  ackFromQueue: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createApiAuthMiddleware({ enabled: true, token: 'secret' }));
  app.use('/results', createResultRoutes(mockRabbitMQ as any));
  return app;
}

function authedRequest(req: Test) {
  return req.set('Authorization', 'Bearer secret');
}

function validSubmission() {
  return {
    job_id: 'job-456',
    task_id: 'task-123',
    status: 'success',
    exit_code: 0,
    stdout: 'output text',
    stderr: '',
  };
}

function validPhaseSubmission() {
  return {
    event_kind: 'phase',
    task_id: 'task-123',
    task_type: 'generic',
    phase: 'queued',
    task_source: { source: 'lark', message_id: 'om_abc123' },
    metadata: {
      emitted_by: 'task-enrichment',
      thread_id: 'thread-1',
      note: 'queued for session worker',
    },
  };
}

function validMirrorSubmission() {
  return {
    event_kind: 'mirror',
    task_id: 'task-123',
    session_id: 'session-123',
    task_type: 'generic',
    task_source: {
      source: 'telegram',
      chat_id: '-100123',
      topic_id: '42',
      message_id: '99',
    },
    mirror_id: 'mirror-123',
    author_type: 'user',
    text: 'hello',
    origin_message_id: '99',
  };
}

describe('POST /results', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send(validSubmission());
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 201 with generated result_id and completed_at', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results')).send(validSubmission());
    expect(res.status).toBe(201);
    expect(res.body.event_kind).toBe('result');
    expect(res.body.result_id).toBeDefined();
    expect(res.body.completed_at).toBeDefined();
    expect(res.body.job_id).toBe('job-456');
    expect(res.body.task_id).toBe('task-123');
    expect(res.body.status).toBe('success');
    expect(res.body.exit_code).toBe(0);
    expect(res.body.stdout).toBe('output text');
    expect(res.body.stderr).toBe('');
  });

  it('publishes to results exchange', async () => {
    const app = buildApp();
    await authedRequest(request(app).post('/results')).send(validSubmission());
    expect(mockRabbitMQ.publishToExchange).toHaveBeenCalledWith(
      'results',
      expect.objectContaining({
        event_kind: 'result',
        result_id: expect.any(String),
        job_id: 'job-456',
        task_id: 'task-123',
        status: 'success',
      }),
    );
  });

  it('returns 201 with session_id when provided', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send({ ...validSubmission(), session_id: 'session-123' });
    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe('session-123');
    expect(mockRabbitMQ.publishToExchange).toHaveBeenCalledWith(
      'results',
      expect.objectContaining({ session_id: 'session-123' }),
    );
  });

  it('returns 201 without session_id when absent', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send(validSubmission());
    expect(res.status).toBe(201);
    expect(res.body.session_id).toBeUndefined();
    expect(mockRabbitMQ.publishToExchange).toHaveBeenCalledWith(
      'results',
      expect.not.objectContaining({ session_id: expect.anything() }),
    );
  });

  it('returns 400 when session_id is not a string', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send({ ...validSubmission(), session_id: 123 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when job_id missing', async () => {
    const app = buildApp();
    const { job_id, ...noJobId } = validSubmission();
    const res = await authedRequest(request(app).post('/results')).send(noJobId);
    expect(res.status).toBe(400);
  });

  it('returns 400 when task_id missing', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results')).send({ job_id: 'job-456', status: 'success', exit_code: 0, stdout: '', stderr: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when status missing', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results')).send({ job_id: 'job-456', task_id: 'task-123', exit_code: 0, stdout: '', stderr: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when status is invalid value', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results')).send({ ...validSubmission(), status: 'pending' });
    expect(res.status).toBe(400);
  });

  it('returns 503 when exchange publish applies backpressure', async () => {
    mockRabbitMQ.publishToExchange.mockResolvedValueOnce(false);
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results')).send(validSubmission());
    expect(res.status).toBe(503);
  });

  it('returns 503 when result publish cannot reconnect to RabbitMQ', async () => {
    mockRabbitMQ.publishToExchange.mockRejectedValueOnce(new RabbitMQUnavailableError());
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results')).send(validSubmission());
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'RabbitMQ temporarily unavailable' });
  });

  it('returns 201 with task_source when provided', async () => {
    const app = buildApp();
    const taskSource = { source: 'lark', message_id: 'om_abc123' };
    const res = await authedRequest(request(app).post('/results'))
      .send({ ...validSubmission(), task_source: taskSource });
    expect(res.status).toBe(201);
    expect(res.body.task_source).toEqual(taskSource);
    expect(mockRabbitMQ.publishToExchange).toHaveBeenCalledWith(
      'results',
      expect.objectContaining({ task_source: taskSource }),
    );
  });

  it('returns 201 without task_source when not provided', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send(validSubmission());
    expect(res.status).toBe(201);
    expect(res.body.task_source).toBeUndefined();
  });

  it('returns 400 when task_source has invalid shape', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send({ ...validSubmission(), task_source: { source: 'unknown' } });
    expect(res.status).toBe(400);
  });

  it('accepts telegram task_source on result POST /results', async () => {
    const app = buildApp();
    const taskSource = {
      source: 'telegram',
      chat_id: '-100123',
      topic_id: '42',
      message_id: '99',
    };
    const res = await authedRequest(request(app).post('/results'))
      .send({ ...validSubmission(), task_source: taskSource });

    expect(res.status).toBe(201);
    expect(res.body.task_source).toEqual(taskSource);
  });

  it('returns 201 with executor metadata when a valid pair is provided', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send({
        ...validSubmission(),
        executor: 'claude',
        executor_model: 'sonnet',
      });
    expect(res.status).toBe(201);
    expect(res.body.executor).toBe('claude');
    expect(res.body.executor_model).toBe('sonnet');
  });

  it('returns 400 when executor is provided without executor_model', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send({
        ...validSubmission(),
        executor: 'claude',
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when executor/model pair is invalid', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send({
        ...validSubmission(),
        executor: 'claude',
        executor_model: 'gpt-5.4',
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when executor uses legacy name claude_code', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send({
        ...validSubmission(),
        executor: 'claude_code',
        executor_model: 'sonnet',
      });
    expect(res.status).toBe(400);
  });

  it('returns 201 with generated event_id and emitted_at for phase events', async () => {
    const app = buildApp();
    const payload = validPhaseSubmission();

    const res = await authedRequest(request(app).post('/results')).send(payload);

    expect(res.status).toBe(201);
    expect(res.body.event_kind).toBe('phase');
    expect(res.body.event_id).toEqual(expect.any(String));
    expect(res.body.emitted_at).toEqual(expect.any(String));
    expect(res.body.phase).toBe('queued');
    expect(res.body.metadata).toEqual(payload.metadata);
    expect(mockRabbitMQ.publishToExchange).toHaveBeenCalledWith(
      'results',
      expect.objectContaining({
        event_kind: 'phase',
        event_id: expect.any(String),
        task_id: 'task-123',
        task_type: 'generic',
        phase: 'queued',
      }),
    );
  });

  it('returns 400 when phase value is invalid', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send({ ...validPhaseSubmission(), phase: 'invalid-phase' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when metadata.emitted_by is invalid for phase events', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send({
        ...validPhaseSubmission(),
        metadata: { emitted_by: 'unknown-emitter' },
      });
    expect(res.status).toBe(400);
  });

  it('accepts telegram-listener as a valid received-phase emitter', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send({
        ...validPhaseSubmission(),
        phase: 'received',
        metadata: { emitted_by: 'telegram-listener' },
      });

    expect(res.status).toBe(201);
    expect(res.body.metadata).toEqual({ emitted_by: 'telegram-listener' });
  });

  it('accepts mirror POST /results', async () => {
    const app = buildApp();
    const payload = validMirrorSubmission();

    const res = await authedRequest(request(app).post('/results')).send(payload);

    expect(res.status).toBe(201);
    expect(res.body.event_kind).toBe('mirror');
    expect(res.body.mirror_id).toBe('mirror-123');
    expect(res.body.emitted_at).toEqual(expect.any(String));
    expect(mockRabbitMQ.publishToExchange).toHaveBeenCalledWith(
      'results',
      expect.objectContaining({
        event_kind: 'mirror',
        mirror_id: 'mirror-123',
        session_id: 'session-123',
      }),
    );
  });

  it('returns 400 when event_kind is unknown', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results'))
      .send({ ...validSubmission(), event_kind: 'unknown' });
    expect(res.status).toBe(400);
  });
});

describe('GET /results/next/:queueName', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/results/next/lark-messages');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 200 with result when available', async () => {
    mockRabbitMQ.getNextFromQueue.mockResolvedValue({
      event_kind: 'result',
      result_id: 'res-1',
      job_id: 'job-1',
      task_id: 'task-123',
      task_type: 'generic',
      status: 'success',
      exit_code: 0,
      stdout: 'output',
      stderr: '',
      completed_at: '2026-03-27T00:00:00.000Z',
    });
    const app = buildApp();
    const res = await authedRequest(request(app).get('/results/next/lark-messages'));
    expect(res.status).toBe(200);
    expect(res.body.result_id).toBe('res-1');
    expect(mockRabbitMQ.getNextFromQueue).toHaveBeenCalledWith('lark-messages');
  });

  it('returns 200 with phase event when available', async () => {
    mockRabbitMQ.getNextFromQueue.mockResolvedValue({
      event_kind: 'phase',
      event_id: 'evt-1',
      task_id: 'task-123',
      task_type: 'generic',
      phase: 'executing',
      emitted_at: '2026-04-05T00:00:00.000Z',
      metadata: { emitted_by: 'task-daemon' },
    });
    const app = buildApp();
    const res = await authedRequest(request(app).get('/results/next/lark-messages'));
    expect(res.status).toBe(200);
    expect(res.body.event_kind).toBe('phase');
    expect(res.body.event_id).toBe('evt-1');
  });

  it('returns 204 when queue is empty', async () => {
    mockRabbitMQ.getNextFromQueue.mockResolvedValue(null);
    const app = buildApp();
    const res = await authedRequest(request(app).get('/results/next/lark-messages'));
    expect(res.status).toBe(204);
  });

  it('returns 503 when result fetch cannot reconnect to RabbitMQ', async () => {
    mockRabbitMQ.getNextFromQueue.mockRejectedValueOnce(new RabbitMQUnavailableError());
    const app = buildApp();
    const res = await authedRequest(request(app).get('/results/next/lark-messages'));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'RabbitMQ temporarily unavailable' });
  });
});

describe('POST /results/:queueName/:id/ack', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/results/lark-messages/res-1/ack');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 200 when ACK succeeds', async () => {
    mockRabbitMQ.ackFromQueue.mockReturnValue(true);
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results/lark-messages/res-1/ack'));
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
    expect(mockRabbitMQ.ackFromQueue).toHaveBeenCalledWith('lark-messages', 'res-1');
  });

  it('returns 404 when result ID unknown', async () => {
    mockRabbitMQ.ackFromQueue.mockReturnValue(false);
    const app = buildApp();
    const res = await authedRequest(request(app).post('/results/lark-messages/unknown/ack'));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Task event not found or already acknowledged' });
  });
});
