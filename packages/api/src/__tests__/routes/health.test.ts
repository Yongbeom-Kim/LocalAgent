import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHealthRoutes } from '../../routes/health';

describe('GET /health', () => {
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
});
