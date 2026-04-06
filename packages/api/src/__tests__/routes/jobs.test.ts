import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Test } from 'supertest';
import { createJobRoutes } from '../../routes/jobs';
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
  const types = await import('../../../../shared/src/types');

  return {
    ...actual,
    isValidExecutorPreferences: types.isValidExecutorPreferences,
    isValidTaskSource: types.isValidTaskSource,
  };
});

const mockRabbitMQ = {
  publishJob: vi.fn().mockResolvedValue(true),
  getNextJobFromSession: vi.fn(),
  ackJobFromSession: vi.fn(),
  nackJobFromSession: vi.fn(),
  listSessionQueues: vi.fn().mockResolvedValue([]),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createApiAuthMiddleware({ enabled: true, token: 'secret' }));
  app.use('/jobs', createJobRoutes(mockRabbitMQ as any));
  return app;
}

function authedRequest(req: Test) {
  return req.set('Authorization', 'Bearer secret');
}

function validJobSubmission() {
  return {
    task_id: 'task-123',
    task_type: 'generic',
    payload: 'hello',
    executors: [{ executor: 'claude', executor_model: 'sonnet' }],
    submitted_at: '2026-03-31T00:00:00.000Z',
    session_id: 'session-123',
  };
}

describe('POST /jobs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/jobs').send(validJobSubmission());
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 201 with session_id when submission is valid', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/jobs')).send(validJobSubmission());
    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe('session-123');
    expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'session-123' }),
    );
  });

  it('returns 400 when session_id missing', async () => {
    const app = buildApp();
    const { session_id, ...submissionWithoutSessionId } = validJobSubmission();
    const res = await authedRequest(request(app).post('/jobs')).send(submissionWithoutSessionId);
    expect(res.status).toBe(400);
  });

  it('returns 201 with history when provided', async () => {
    const app = buildApp();
    const history = 'Previous conversation context';
    const res = await authedRequest(request(app).post('/jobs')).send({ ...validJobSubmission(), history });
    expect(res.status).toBe(201);
    expect(res.body.history).toBe(history);
    expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(expect.objectContaining({ history }));
  });

  it('returns 201 with task_source when provided', async () => {
    const app = buildApp();
    const taskSource = { source: 'lark', message_id: 'om_abc123' };
    const res = await authedRequest(request(app).post('/jobs')).send({ ...validJobSubmission(), task_source: taskSource });
    expect(res.status).toBe(201);
    expect(res.body.task_source).toEqual(taskSource);
  });

  it('returns 400 when task_source has invalid shape', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/jobs')).send({ ...validJobSubmission(), task_source: { source: 'unknown' } });
    expect(res.status).toBe(400);
  });

  it('accepts telegram task_source on POST /jobs', async () => {
    const app = buildApp();
    const taskSource = {
      source: 'telegram',
      chat_id: '-100123',
      topic_id: '42',
      message_id: '99',
    };
    const res = await request(app)
      .post('/jobs')
      .send({ ...validJobSubmission(), task_source: taskSource });

    expect(res.status).toBe(201);
    expect(res.body.task_source).toEqual(taskSource);
  });

  it('returns 201 with setup_hook and setup_hook_timeout_ms when provided', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/jobs'))
      .send({ ...validJobSubmission(), setup_hook: 'npm ci', setup_hook_timeout_ms: 60000 });
    expect(res.status).toBe(201);
    expect(res.body.setup_hook).toBe('npm ci');
    expect(res.body.setup_hook_timeout_ms).toBe(60000);
  });

  it('returns 503 when publish fails to buffer', async () => {
    mockRabbitMQ.publishJob.mockResolvedValueOnce(false);
    const app = buildApp();
    const res = await authedRequest(request(app).post('/jobs')).send(validJobSubmission());
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Server busy, try again later' });
  });

  it('returns 503 when job publish cannot reconnect to RabbitMQ', async () => {
    mockRabbitMQ.publishJob.mockRejectedValueOnce(new RabbitMQUnavailableError());
    const app = buildApp();
    const res = await authedRequest(request(app).post('/jobs')).send(validJobSubmission());
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'RabbitMQ temporarily unavailable' });
  });
});

describe('GET /jobs/sessions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/jobs/sessions');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns active sessions', async () => {
    mockRabbitMQ.listSessionQueues.mockResolvedValueOnce([
      { session_id: 'session-a', queue_name: 'jobs.session.session-a' },
      { session_id: 'session-b', queue_name: 'jobs.session.session-b' },
    ]);
    const app = buildApp();
    const res = await authedRequest(request(app).get('/jobs/sessions'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessions: [
        { session_id: 'session-a', queue_name: 'jobs.session.session-a' },
        { session_id: 'session-b', queue_name: 'jobs.session.session-b' },
      ],
    });
  });

  it('returns 503 when broker-backed discovery fails', async () => {
    mockRabbitMQ.listSessionQueues.mockRejectedValueOnce(new Error('management unavailable'));
    const app = buildApp();
    const res = await authedRequest(request(app).get('/jobs/sessions'));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Session queue discovery unavailable' });
  });
});

describe('GET /jobs/next/:sessionId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/jobs/next/session-123');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns the next job for a session', async () => {
    mockRabbitMQ.getNextJobFromSession.mockResolvedValueOnce({
      job_id: 'job-1',
      task_id: 'task-1',
      task_type: 'generic',
      payload: 'hello',
      executors: [{ executor: 'claude', executor_model: 'sonnet' }],
      submitted_at: '2026-03-31T00:00:00.000Z',
      session_id: 'session-123',
      enriched_at: '2026-03-31T00:00:01.000Z',
    });
    const app = buildApp();
    const res = await authedRequest(request(app).get('/jobs/next/session-123'));
    expect(res.status).toBe(200);
    expect(mockRabbitMQ.getNextJobFromSession).toHaveBeenCalledWith('session-123');
  });

  it('returns 204 when the session queue is empty', async () => {
    mockRabbitMQ.getNextJobFromSession.mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await authedRequest(request(app).get('/jobs/next/session-123'));
    expect(res.status).toBe(204);
  });

  it('returns 503 when job fetch cannot reconnect to RabbitMQ', async () => {
    mockRabbitMQ.getNextJobFromSession.mockRejectedValueOnce(new RabbitMQUnavailableError());
    const app = buildApp();
    const res = await authedRequest(request(app).get('/jobs/next/session-123'));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'RabbitMQ temporarily unavailable' });
  });
});

describe('POST /jobs/:sessionId/:id/ack', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/jobs/session-123/job-abc/ack');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 200 with acknowledged true when job is found', async () => {
    mockRabbitMQ.ackJobFromSession.mockReturnValueOnce(true);
    const app = buildApp();
    const res = await authedRequest(request(app).post('/jobs/session-123/job-abc/ack'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ acknowledged: true });
    expect(mockRabbitMQ.ackJobFromSession).toHaveBeenCalledWith('session-123', 'job-abc');
  });

  it('returns 404 when job delivery is no longer available', async () => {
    mockRabbitMQ.ackJobFromSession.mockReturnValueOnce(false);
    const app = buildApp();
    const res = await authedRequest(request(app).post('/jobs/session-123/job-abc/ack'));
    expect(res.status).toBe(404);
  });
});

describe('POST /jobs/:sessionId/:id/nack', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/jobs/session-123/job-abc/nack');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 200 with requeued true when job is found', async () => {
    mockRabbitMQ.nackJobFromSession.mockReturnValueOnce(true);
    const app = buildApp();
    const res = await authedRequest(request(app).post('/jobs/session-123/job-abc/nack'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requeued: true });
    expect(mockRabbitMQ.nackJobFromSession).toHaveBeenCalledWith('session-123', 'job-abc');
  });

  it('returns 404 when job delivery cannot be requeued anymore', async () => {
    mockRabbitMQ.nackJobFromSession.mockReturnValueOnce(false);
    const app = buildApp();
    const res = await authedRequest(request(app).post('/jobs/session-123/job-abc/nack'));
    expect(res.status).toBe(404);
  });
});
