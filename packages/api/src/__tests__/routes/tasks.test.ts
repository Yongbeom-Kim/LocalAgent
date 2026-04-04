import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTaskRoutes } from '../../routes/tasks';

const mockRabbitMQ = {
  publish: vi.fn().mockReturnValue(true),
  getNext: vi.fn(),
  ack: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/tasks', createTaskRoutes(mockRabbitMQ as any));
  return app;
}

describe('POST /tasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 201 with submitted task', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
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
  });

  it('returns 503 when broker publish applies backpressure', async () => {
    mockRabbitMQ.publish.mockReturnValueOnce(false);
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({
        task_type: 'generic',
        payload: 'hello',
        executor: 'claude',
        executor_model: 'sonnet',
      });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Server busy, try again later' });
    expect(mockRabbitMQ.publish).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when task_type missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ payload: 'hello' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when payload missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'generic' });
    expect(res.status).toBe(400);
  });

  it('returns 201 with task_source when provided', async () => {
    const app = buildApp();
    const taskSource = { source: 'lark', message_id: 'om_abc123' };
    const res = await request(app)
      .post('/tasks')
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
    const res = await request(app)
      .post('/tasks')
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
    const res = await request(app)
      .post('/tasks')
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
    const res = await request(app)
      .post('/tasks')
      .send({
        task_type: 'generic',
        payload: 'hello',
        executor: 'claude',
        executor_model: 'sonnet',
        task_source: { source: 'lark' },
      });
    expect(res.status).toBe(400);
  });

  it('returns 201 for non-control task with explicit executor/model', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
      .send({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'claude',
        executor_model: 'sonnet',
      });
    expect(res.status).toBe(201);
  });

  it('accepts non-control task with empty task_type for pipeline help', async () => {
    const res = await request(buildApp())
      .post('/tasks')
      .send({ task_type: '', payload: '' });
    expect(res.status).toBe(201);
  });

  it('accepts non-control task with task_type only', async () => {
    const res = await request(buildApp())
      .post('/tasks')
      .send({ task_type: 'localagent', payload: '' });
    expect(res.status).toBe(201);
  });

  it('accepts non-control task with executor but no model', async () => {
    const res = await request(buildApp())
      .post('/tasks')
      .send({ task_type: 'localagent', payload: '', executor: 'cursor' });
    expect(res.status).toBe(201);
  });

  it('accepts non-control task with invalid executor/model pair so enrichment can explain it', async () => {
    const res = await request(buildApp())
      .post('/tasks')
      .send({
        task_type: 'localagent',
        payload: '',
        executor: 'foo',
        executor_model: 'bar',
      });
    expect(res.status).toBe(201);
  });

  it('rejects executor_model without executor', async () => {
    const res = await request(buildApp())
      .post('/tasks')
      .send({
        task_type: 'localagent',
        payload: '',
        executor_model: 'auto',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/executor_model/);
  });

  it('keeps explicit /new validation strict', async () => {
    const res = await request(buildApp())
      .post('/tasks')
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
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'code_review', payload: 'review this diff' });
    expect(res.status).toBe(201);
  });

  it('accepts non-control task when payload is whitespace-only', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
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
    const res = await request(app)
      .post('/tasks')
      .send({ task_type: 'new_instance', payload: '' });
    expect(res.status).toBe(201);
  });

  it('returns 201 when control task includes a valid explicit executor/model pair', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
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
    const res = await request(app)
      .post('/tasks')
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
    const res = await request(app)
      .post('/tasks')
      .send({
        task_type: 'code_review',
        payload: 'review this diff',
        executor: 'claude',
      });
    expect(res.status).toBe(201);
  });

  it('returns 201 for lark task with invalid model so enrichment can reject it later', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/tasks')
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
    const res = await request(app)
      .post('/tasks')
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
    const res = await request(app)
      .post('/tasks')
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
    const res = await request(app)
      .post('/tasks')
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
    const res = await request(app).get('/tasks/next');
    expect(res.status).toBe(200);
    expect(res.body.task_id).toBe('abc-123');
  });

  it('returns 204 when queue is empty', async () => {
    mockRabbitMQ.getNext.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app).get('/tasks/next');
    expect(res.status).toBe(204);
  });
});

describe('POST /tasks/:id/ack', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 when ACK succeeds', async () => {
    mockRabbitMQ.ack.mockReturnValue(true);
    const app = buildApp();
    const res = await request(app).post('/tasks/abc-123/ack');
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
  });

  it('returns 404 when task ID unknown', async () => {
    mockRabbitMQ.ack.mockReturnValue(false);
    const app = buildApp();
    const res = await request(app).post('/tasks/unknown/ack');
    expect(res.status).toBe(404);
  });
});
