import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createJobRoutes } from '../../routes/jobs';

const mockRabbitMQ = {
  publishJob: vi.fn().mockReturnValue(true),
  getNextJob: vi.fn(),
  ackJob: vi.fn(),
  nackJob: vi.fn(),
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
    executors: [{ executor: 'claude', executor_model: 'sonnet' }],
    submitted_at: '2026-03-31T00:00:00.000Z',
    session_id: 'session-123',
  };
}

describe('POST /jobs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 201 with session_id when submission is valid', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send(validJobSubmission());
    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe('session-123');
    expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 'session-123' }),
    );
  });

  it('returns 400 when session_id missing', async () => {
    const app = buildApp();
    const { session_id, ...submissionWithoutSessionId } = validJobSubmission();
    const res = await request(app)
      .post('/jobs')
      .send(submissionWithoutSessionId);
    expect(res.status).toBe(400);
  });

  it('returns 201 with history when provided', async () => {
    const app = buildApp();
    const history = 'Previous conversation context';
    const res = await request(app)
      .post('/jobs')
      .send({ ...validJobSubmission(), history });
    expect(res.status).toBe(201);
    expect(res.body.history).toBe(history);
    expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(
      expect.objectContaining({ history }),
    );
  });

  it('returns 201 without history when not provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send(validJobSubmission());
    expect(res.status).toBe(201);
    expect(res.body.history).toBeUndefined();
    expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(
      expect.not.objectContaining({ history: expect.anything() }),
    );
  });

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

  it('returns 201 with system_prompt when provided', async () => {
    const app = buildApp();
    const systemPrompt = 'You are a code reviewer. Focus on security.';
    const res = await request(app)
      .post('/jobs')
      .send({ ...validJobSubmission(), system_prompt: systemPrompt });
    expect(res.status).toBe(201);
    expect(res.body.system_prompt).toBe(systemPrompt);
    expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(
      expect.objectContaining({ system_prompt: systemPrompt }),
    );
  });

  it('returns 201 without system_prompt when not provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send(validJobSubmission());
    expect(res.status).toBe(201);
    expect(res.body.system_prompt).toBeUndefined();
  });

  it('returns 201 with setup_hook and setup_hook_timeout_ms when provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send({ ...validJobSubmission(), setup_hook: 'npm ci', setup_hook_timeout_ms: 60000 });
    expect(res.status).toBe(201);
    expect(res.body.setup_hook).toBe('npm ci');
    expect(res.body.setup_hook_timeout_ms).toBe(60000);
    expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(
      expect.objectContaining({ setup_hook: 'npm ci', setup_hook_timeout_ms: 60000 }),
    );
  });

  it('returns 201 when executors use cursor with allowlisted model gpt-5.4-medium-fast', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send({
        ...validJobSubmission(),
        executors: [{ executor: 'cursor', executor_model: 'gpt-5.4-medium-fast' }],
      });
    expect(res.status).toBe(201);
    expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(
      expect.objectContaining({
        executors: [{ executor: 'cursor', executor_model: 'gpt-5.4-medium-fast' }],
      }),
    );
  });

  it('returns 400 when cursor uses unlisted model not-a-real-model', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send({
        ...validJobSubmission(),
        executors: [{ executor: 'cursor', executor_model: 'not-a-real-model' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'executors must be a non-empty array of valid {executor, executor_model} pairs',
    );
  });

  it('returns 400 when executors use legacy executor names', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send({
        ...validJobSubmission(),
        executors: [{ executor: 'cursor_agent', executor_model: 'auto' }],
      });
    expect(res.status).toBe(400);
  });
});

describe('POST /jobs/:id/nack', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 with { requeued: true } when job is found', async () => {
    mockRabbitMQ.nackJob.mockReturnValue(true);
    const app = buildApp();
    const res = await request(app).post('/jobs/job-abc/nack');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requeued: true });
    expect(mockRabbitMQ.nackJob).toHaveBeenCalledWith('job-abc');
  });

  it('returns 404 when job is not found', async () => {
    mockRabbitMQ.nackJob.mockReturnValue(false);
    const app = buildApp();
    const res = await request(app).post('/jobs/unknown-job/nack');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Job not found or already processed' });
    expect(mockRabbitMQ.nackJob).toHaveBeenCalledWith('unknown-job');
  });
});
