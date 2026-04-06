import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHealthRoutes } from '../../routes/health';
import { createApiAuthMiddleware } from '../../middleware/auth';

describe('GET /health', () => {
  function buildAppWithGlobalAuth() {
    const app = express();
    app.use('/health', createHealthRoutes({ isConnected: vi.fn().mockReturnValue(true) } as any));
    app.use(createApiAuthMiddleware({ enabled: true, token: 'secret' }));
    app.get('/protected', (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  it('returns connected status when RabbitMQ is connected', async () => {
    const mockRabbitMQ = { isConnected: vi.fn().mockReturnValue(true) };
    const app = express();
    app.use('/health', createHealthRoutes(mockRabbitMQ as any));
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.rabbitmq).toBe('connected');
  });

  it('returns disconnected status when RabbitMQ is down', async () => {
    const mockRabbitMQ = { isConnected: vi.fn().mockReturnValue(false) };
    const app = express();
    app.use('/health', createHealthRoutes(mockRabbitMQ as any));
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.rabbitmq).toBe('disconnected');
  });

  it('remains public without credentials when mounted before auth middleware', async () => {
    const app = buildAppWithGlobalAuth();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('still protects non-health routes when auth middleware is mounted globally', async () => {
    const app = buildAppWithGlobalAuth();
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });
});
