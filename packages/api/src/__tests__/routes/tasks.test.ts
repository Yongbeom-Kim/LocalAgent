import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTaskRoutes } from '../../routes/tasks';

const mockRabbitMQ = {
  publish: vi.fn(),
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
      .send({ task_type: 'generic', payload: 'hello' });
    expect(res.status).toBe(201);
    expect(res.body.task_type).toBe('generic');
    expect(res.body.payload).toBe('hello');
    expect(res.body.submitted_at).toBeDefined();
    expect(mockRabbitMQ.publish).toHaveBeenCalled();
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
});

describe('GET /tasks/next', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with task when available', async () => {
    mockRabbitMQ.getNext.mockResolvedValue({
      task_id: 'abc-123',
      task_type: 'generic',
      payload: 'hello',
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
