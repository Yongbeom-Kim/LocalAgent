import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createResultRoutes } from '../../routes/results';

const mockRabbitMQ = {
  publishToExchange: vi.fn().mockReturnValue(true),
  getNextFromQueue: vi.fn(),
  ackFromQueue: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/results', createResultRoutes(mockRabbitMQ as any));
  return app;
}

function validSubmission() {
  return {
    task_id: 'task-123',
    status: 'success',
    exit_code: 0,
    stdout: 'output text',
    stderr: '',
  };
}

describe('POST /results', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 201 with generated result_id and completed_at', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send(validSubmission());
    expect(res.status).toBe(201);
    expect(res.body.result_id).toBeDefined();
    expect(res.body.completed_at).toBeDefined();
    expect(res.body.task_id).toBe('task-123');
    expect(res.body.status).toBe('success');
    expect(res.body.exit_code).toBe(0);
    expect(res.body.stdout).toBe('output text');
    expect(res.body.stderr).toBe('');
  });

  it('publishes to results exchange', async () => {
    const app = buildApp();
    await request(app).post('/results').send(validSubmission());
    expect(mockRabbitMQ.publishToExchange).toHaveBeenCalledWith(
      'results',
      expect.objectContaining({
        result_id: expect.any(String),
        task_id: 'task-123',
        status: 'success',
      }),
    );
  });

  it('returns 400 when task_id missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send({ status: 'success', exit_code: 0, stdout: '', stderr: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when status missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send({ task_id: 'task-123', exit_code: 0, stdout: '', stderr: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when status is invalid value', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send({ ...validSubmission(), status: 'pending' });
    expect(res.status).toBe(400);
  });

  it('returns 503 when exchange publish applies backpressure', async () => {
    mockRabbitMQ.publishToExchange.mockReturnValueOnce(false);
    const app = buildApp();
    const res = await request(app).post('/results').send(validSubmission());
    expect(res.status).toBe(503);
  });
});

describe('GET /results/next/:queueName', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with result when available', async () => {
    mockRabbitMQ.getNextFromQueue.mockResolvedValue({
      result_id: 'res-1',
      task_id: 'task-123',
      status: 'success',
      exit_code: 0,
      stdout: 'output',
      stderr: '',
      completed_at: '2026-03-27T00:00:00.000Z',
    });
    const app = buildApp();
    const res = await request(app).get('/results/next/lark-messages');
    expect(res.status).toBe(200);
    expect(res.body.result_id).toBe('res-1');
    expect(mockRabbitMQ.getNextFromQueue).toHaveBeenCalledWith('lark-messages');
  });

  it('returns 204 when queue is empty', async () => {
    mockRabbitMQ.getNextFromQueue.mockResolvedValue(null);
    const app = buildApp();
    const res = await request(app).get('/results/next/lark-messages');
    expect(res.status).toBe(204);
  });
});

describe('POST /results/:queueName/:id/ack', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 when ACK succeeds', async () => {
    mockRabbitMQ.ackFromQueue.mockReturnValue(true);
    const app = buildApp();
    const res = await request(app).post('/results/lark-messages/res-1/ack');
    expect(res.status).toBe(200);
    expect(res.body.acknowledged).toBe(true);
    expect(mockRabbitMQ.ackFromQueue).toHaveBeenCalledWith('lark-messages', 'res-1');
  });

  it('returns 404 when result ID unknown', async () => {
    mockRabbitMQ.ackFromQueue.mockReturnValue(false);
    const app = buildApp();
    const res = await request(app).post('/results/lark-messages/unknown/ack');
    expect(res.status).toBe(404);
  });
});
