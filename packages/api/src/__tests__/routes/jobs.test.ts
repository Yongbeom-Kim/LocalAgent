import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createJobRoutes } from '../../routes/jobs';

const mockRabbitMQ = {
  publishJob: vi.fn().mockReturnValue(true),
  getNextJob: vi.fn(),
  ackJob: vi.fn(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', createJobRoutes(mockRabbitMQ as any));
  return app;
}

function validJobSubmission() {
  return {
    task_id: 'task-123',
    task_type: 'generic',
    payload: 'hello',
    executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
    submitted_at: '2026-03-31T00:00:00.000Z',
  };
}

describe('POST /jobs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 201 with task_source when provided', async () => {
    const app = buildApp();
    const taskSource = { source: 'lark', message_id: 'om_abc123' };
    const res = await request(app)
      .post('/jobs')
      .send({ ...validJobSubmission(), task_source: taskSource });
    expect(res.status).toBe(201);
    expect(res.body.task_source).toEqual(taskSource);
    expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(
      expect.objectContaining({ task_source: taskSource }),
    );
  });

  it('returns 201 without task_source when not provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send(validJobSubmission());
    expect(res.status).toBe(201);
    expect(res.body.task_source).toBeUndefined();
  });

  it('returns 400 when task_source has invalid shape', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send({ ...validJobSubmission(), task_source: { source: 'unknown' } });
    expect(res.status).toBe(400);
  });

  it('returns 400 when task_source.source is lark but message_id missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send({ ...validJobSubmission(), task_source: { source: 'lark' } });
    expect(res.status).toBe(400);
  });
});
