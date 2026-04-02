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
    job_id: 'job-456',
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
    expect(res.body.job_id).toBe('job-456');
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
        job_id: 'job-456',
        task_id: 'task-123',
        status: 'success',
      }),
    );
  });

  it('returns 201 with session_id when provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/results')
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
    const res = await request(app)
      .post('/results')
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
    const res = await request(app)
      .post('/results')
      .send({ ...validSubmission(), session_id: 123 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when job_id missing', async () => {
    const app = buildApp();
    const { job_id, ...noJobId } = validSubmission();
    const res = await request(app).post('/results').send(noJobId);
    expect(res.status).toBe(400);
  });

  it('returns 400 when task_id missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send({ job_id: 'job-456', status: 'success', exit_code: 0, stdout: '', stderr: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when status missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send({ job_id: 'job-456', task_id: 'task-123', exit_code: 0, stdout: '', stderr: '' });
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

  it('returns 201 with task_source when provided', async () => {
    const app = buildApp();
    const taskSource = { source: 'lark', message_id: 'om_abc123' };
    const res = await request(app)
      .post('/results')
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
    const res = await request(app)
      .post('/results')
      .send(validSubmission());
    expect(res.status).toBe(201);
    expect(res.body.task_source).toBeUndefined();
  });

  it('returns 400 when task_source has invalid shape', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/results')
      .send({ ...validSubmission(), task_source: { source: 'unknown' } });
    expect(res.status).toBe(400);
  });

  it('returns 201 with executor metadata when a valid pair is provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/results')
      .send({
        ...validSubmission(),
        executor: 'claude_code',
        executor_model: 'sonnet',
      });
    expect(res.status).toBe(201);
    expect(res.body.executor).toBe('claude_code');
    expect(res.body.executor_model).toBe('sonnet');
  });

  it('returns 400 when executor is provided without executor_model', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/results')
      .send({
        ...validSubmission(),
        executor: 'claude_code',
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when executor/model pair is invalid', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/results')
      .send({
        ...validSubmission(),
        executor: 'claude_code',
        executor_model: 'gpt-5.4',
      });
    expect(res.status).toBe(400);
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
