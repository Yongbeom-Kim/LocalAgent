import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Test } from 'supertest';
import { createTaskRoutes } from '../../routes/tasks';
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
    isValidTaskSource: types.isValidTaskSource,
    isControlTaskType: types.isControlTaskType,
    isTaskExecutorType: types.isTaskExecutorType,
    isValidExecutorModel: types.isValidExecutorModel,
  };
});

const mockRabbitMQ = {
  publish: vi.fn().mockResolvedValue(true),
  getNext: vi.fn(),
  ack: vi.fn(),
};

const mockSessionRepository = {
  upsertSession: vi.fn().mockResolvedValue(undefined),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createApiAuthMiddleware({ enabled: true, token: 'secret' }));
  app.use('/tasks', createTaskRoutes(mockRabbitMQ as any, mockSessionRepository as any));
  return app;
}

function authedRequest(req: Test) {
  return req.set('Authorization', 'Bearer secret');
}

describe('POST /tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRabbitMQ.publish.mockResolvedValue(true);
    mockSessionRepository.upsertSession.mockResolvedValue(undefined);
  });

  it('returns 401 when authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/tasks/').send({ task_type: 'generic', payload: 'hello' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 201 with submitted task', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'generic',
        payload: 'hello',
        executor: 'claude',
        executor_model: 'sonnet',
      });
    expect(res.status).toBe(201);
    expect(res.body.task_id).toBeDefined();
    expect(res.body.task_type).toBe('generic');
    expect(res.body.payload).toBe('hello');
    expect(res.body.submitted_at).toBeDefined();
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith({
      task_id: expect.any(String),
      task_type: 'generic',
      payload: 'hello',
      submitted_at: expect.any(String),
      executor: 'claude',
      executor_model: 'sonnet',
    });
    expect(mockSessionRepository.upsertSession).not.toHaveBeenCalled();
  });

  it('accepts additive session fallback metadata and persists a canonical session row', async () => {
    const app = buildApp();

    const res = await authedRequest(request(app).post('/tasks')).send({
      task_type: 'generic',
      payload: 'hello',
      executor: 'claude',
      executor_model: 'sonnet',
      session_id: 'session-123',
      session: {
        fallbackSeedText: 'hello',
        fallbackOrigin: 'scheduler',
        fallbackTitleHint: 'Morning review',
      },
    });

    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe('session-123');
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'session-123',
    }));
    expect(mockSessionRepository.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-123',
      taskType: 'generic',
      executor: 'claude',
      executorModel: 'sonnet',
      status: 'active',
      fallbackSeedText: 'hello',
      fallbackOrigin: 'scheduler',
      fallbackTitleHint: 'Morning review',
      createdAtMs: expect.any(Number),
      updatedAtMs: expect.any(Number),
      endedAtMs: null,
    }));
    expect(mockSessionRepository.upsertSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockRabbitMQ.publish.mock.invocationCallOrder[0],
    );
  });

  it('returns 500 and does not publish when canonical session persistence fails', async () => {
    mockSessionRepository.upsertSession.mockRejectedValueOnce(new Error('sqlite write failed'));
    const app = buildApp();

    const res = await authedRequest(request(app).post('/tasks')).send({
      task_type: 'generic',
      payload: 'hello',
      executor: 'claude',
      executor_model: 'sonnet',
      session_id: 'session-123',
      session: {
        fallbackSeedText: 'hello',
        fallbackOrigin: 'scheduler',
      },
    });

    expect(res.status).toBe(500);
    expect(mockSessionRepository.upsertSession).toHaveBeenCalledTimes(1);
    expect(mockRabbitMQ.publish).not.toHaveBeenCalled();
  });

  it('returns 400 when fallback metadata is malformed', async () => {
    const app = buildApp();

    const res = await authedRequest(request(app).post('/tasks')).send({
      task_type: 'generic',
      payload: 'hello',
      session_id: 'session-123',
      session: {
        fallbackSeedText: 42,
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('session.fallbackSeedText must be a string if provided');
    expect(mockSessionRepository.upsertSession).not.toHaveBeenCalled();
  });

  it('returns 400 when session metadata is present without session_id', async () => {
    const app = buildApp();

    const res = await authedRequest(request(app).post('/tasks')).send({
      task_type: 'generic',
      payload: 'hello',
      session: {
        fallbackSeedText: 'hello',
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('session_id is required when session metadata is provided');
    expect(mockSessionRepository.upsertSession).not.toHaveBeenCalled();
  });

  it('returns 201 and preserves canonical session_id/context_ref fields', async () => {
    const app = buildApp();
    const canonical = {
      session_id: 'session-123',
      context_ref: {
        platform: 'lark',
        root_key: 'om_root_123',
      },
    };

    const res = await authedRequest(request(app).post('/tasks')).send({
      task_type: 'generic',
      payload: 'hello',
      ...canonical,
    });

    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe('session-123');
    expect(res.body.context_ref).toEqual({
      platform: 'lark',
      root_key: 'om_root_123',
    });
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-123',
        context_ref: {
          platform: 'lark',
          root_key: 'om_root_123',
        },
      }),
    );
  });

  it('returns 201 without session_id/context_ref for legacy callers', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks')).send({
      task_type: 'generic',
      payload: 'hello',
    });

    expect(res.status).toBe(201);
    expect(res.body.session_id).toBeUndefined();
    expect(res.body.context_ref).toBeUndefined();
  });

  it('returns 503 when broker publish applies backpressure', async () => {
    mockRabbitMQ.publish.mockResolvedValueOnce(false);
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'generic',
        payload: 'hello',
        executor: 'claude',
        executor_model: 'sonnet',
      });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Server busy, try again later' });
    expect(mockRabbitMQ.publish).toHaveBeenCalledTimes(1);
    expect(mockSessionRepository.upsertSession).not.toHaveBeenCalled();
  });

  it('returns 503 when task publish cannot reconnect to RabbitMQ', async () => {
    mockRabbitMQ.publish.mockRejectedValueOnce(new RabbitMQUnavailableError());
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks')).send({ task_type: 'generic', payload: 'hello' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'RabbitMQ temporarily unavailable' });
  });

  it('returns 400 when task_type missing', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({ payload: 'hello' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when payload missing', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({ task_type: 'generic' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when session_id is not a string', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks')).send({
      task_type: 'generic',
      payload: 'hello',
      session_id: 123,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('session_id must be a string if provided');
  });

  it('returns 400 when context_ref is not an object', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks')).send({
      task_type: 'generic',
      payload: 'hello',
      context_ref: 'bad',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('context_ref must be an object if provided');
  });

  it('returns 400 when context_ref.platform is invalid', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks')).send({
      task_type: 'generic',
      payload: 'hello',
      context_ref: {
        platform: 'discord',
        root_key: 'root-1',
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('context_ref.platform must be one of: lark, telegram');
  });

  it('returns 400 when context_ref.root_key is not a string', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks')).send({
      task_type: 'generic',
      payload: 'hello',
      context_ref: {
        platform: 'telegram',
        root_key: 123,
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('context_ref.root_key must be a string');
  });

  it('returns 201 with task_source when provided', async () => {
    const app = buildApp();
    const taskSource = { source: 'lark', message_id: 'om_abc123' };
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'generic',
        payload: 'hello',
        executor: 'claude',
        executor_model: 'sonnet',
        task_source: taskSource,
      });
    expect(res.status).toBe(201);
    expect(res.body.task_source).toEqual(taskSource);
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith(
      expect.objectContaining({ task_source: taskSource }),
    );
  });

  it('returns 201 without task_source when not provided', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'generic',
        payload: 'hello',
        executor: 'claude',
        executor_model: 'sonnet',
      });
    expect(res.status).toBe(201);
    expect(res.body.task_source).toBeUndefined();
  });

  it('returns 400 when task_source has invalid shape', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'generic',
        payload: 'hello',
        executor: 'claude',
        executor_model: 'sonnet',
        task_source: { source: 'unknown' },
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when task_source.source is lark but message_id is missing', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'generic',
        payload: 'hello',
        executor: 'claude',
        executor_model: 'sonnet',
        task_source: { source: 'lark' },
      });
    expect(res.status).toBe(400);
  });

  it('accepts telegram task_source on POST /tasks', async () => {
    const app = buildApp();
    const taskSource = {
      source: 'telegram',
      chat_id: '-100123',
      topic_id: '42',
      message_id: '99',
    };
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'generic',
        payload: 'hello',
        task_source: taskSource,
      });

    expect(res.status).toBe(201);
    expect(res.body.task_source).toEqual(taskSource);
  });

  it('returns 201 for non-control task with explicit executor/model', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'claude',
        executor_model: 'sonnet',
      });
    expect(res.status).toBe(201);
  });

  it('accepts non-control task with empty task_type for pipeline help', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({ task_type: '', payload: '' });
    expect(res.status).toBe(201);
  });

  it('accepts non-control task with task_type only', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({ task_type: 'localagent', payload: '' });
    expect(res.status).toBe(201);
  });

  it('accepts non-control task with executor but no model', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({ task_type: 'localagent', payload: '', executor: 'cursor' });
    expect(res.status).toBe(201);
  });

  it('accepts non-control task with invalid executor/model pair so enrichment can explain it', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'localagent',
        payload: '',
        executor: 'foo',
        executor_model: 'bar',
      });
    expect(res.status).toBe(201);
  });

  it('rejects executor_model without executor', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'localagent',
        payload: '',
        executor_model: 'auto',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/executor_model/);
  });

  it('keeps explicit /new validation strict', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'new_instance',
        payload: '',
        executor: 'foo',
        executor_model: 'bar',
      });
    expect(res.status).toBe(400);
  });

  it('accepts non-control task when executor is omitted (partial routing)', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({ task_type: 'code_review', payload: 'review this diff' });
    expect(res.status).toBe(201);
  });

  it('accepts non-control task when payload is whitespace-only', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'code_review',
        payload: '   ',
        executor: 'claude',
        executor_model: 'sonnet',
      });
    expect(res.status).toBe(201);
  });

  it('returns 201 when control task omits executor/model', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({ task_type: 'new_instance', payload: '' });
    expect(res.status).toBe(201);
  });

  it('returns 201 when control task includes a valid explicit executor/model pair', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'new_instance',
        payload: '',
        executor: 'claude',
        executor_model: 'sonnet',
      });
    expect(res.status).toBe(201);
  });

  it('returns 201 when control task uses ttcodex with an allowlisted model', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'new_instance',
        payload: '',
        executor: 'ttcodex',
        executor_model: 'gpt-5.4',
      });
    expect(res.status).toBe(201);
  });

  it('accepts non-control task when executor is present without model', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'claude',
      });
    expect(res.status).toBe(201);
  });

  it('returns 201 for lark task with invalid model so enrichment can reject it later', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'localagent',
        payload: 'test',
        executor: 'cursor',
        executor_model: 'xyz',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });

    expect(res.status).toBe(201);
    expect(mockRabbitMQ.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        executor: 'cursor',
        executor_model: 'xyz',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    );
  });

  it('returns 400 for control /new task with invalid executor/model pair even with lark source', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'new_instance',
        payload: '',
        executor: 'foo',
        executor_model: 'bar',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid pair/);
  });

  it('accepts non-lark non-control task with invalid executor for enrichment', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'foo',
        executor_model: 'bar',
      });

    expect(res.status).toBe(201);
  });

  it('accepts non-lark non-control task with invalid model for enrichment', async () => {
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks'))
      .send({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'cursor',
        executor_model: 'xyz',
      });

    expect(res.status).toBe(201);
  });
});

describe('GET /tasks/next', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).get('/tasks/next');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 200 with task when available', async () => {
    mockRabbitMQ.getNext.mockResolvedValue({
      task_id: 'abc-123',
      task_type: 'generic',
      payload: 'hello',
      executor: 'claude',
      executor_model: 'sonnet',
      submitted_at: '2026-03-26T00:00:00.000Z',
    });
    const app = buildApp();
    const res = await authedRequest(request(app).get('/tasks/next'));
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe('abc-123');
  });

  it('returns 204 when queue is empty', async () => {
    mockRabbitMQ.getNext.mockResolvedValue(null);
    const app = buildApp();
    const res = await authedRequest(request(app).get('/tasks/next'));
    expect(res.status).toBe(204);
  });

  it('returns 503 when task fetch cannot reconnect to RabbitMQ', async () => {
    mockRabbitMQ.getNext.mockRejectedValueOnce(new RabbitMQUnavailableError());
    const app = buildApp();
    const res = await authedRequest(request(app).get('/tasks/next'));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'RabbitMQ temporarily unavailable' });
  });
});

describe('POST /tasks/:id/ack', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when authorization header is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/tasks/abc-123/ack');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 200 when ACK succeeds', async () => {
    mockRabbitMQ.ack.mockReturnValue(true);
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks/abc-123/ack'));
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
  });

  it('returns 404 when task ID unknown', async () => {
    mockRabbitMQ.ack.mockReturnValue(false);
    const app = buildApp();
    const res = await authedRequest(request(app).post('/tasks/unknown/ack'));
    expect(res.status).toBe(404);
  });
});
