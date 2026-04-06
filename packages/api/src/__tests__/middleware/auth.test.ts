import { describe, it, expect, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { createApiAuthMiddleware } from '../../middleware/auth';

function createResponseMock() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });

  return {
    response: { status } as unknown as Response,
    status,
    json,
  };
}

describe('createApiAuthMiddleware', () => {
  it('returns 401 when authorization header is missing', async () => {
    const middleware = createApiAuthMiddleware({ enabled: true, token: 'secret' });
    const next = vi.fn() as unknown as NextFunction;
    const { response, status, json } = createResponseMock();
    const req = { header: vi.fn().mockReturnValue(undefined) } as unknown as Request;

    middleware(req, response, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when scheme is not bearer', async () => {
    const middleware = createApiAuthMiddleware({ enabled: true, token: 'secret' });
    const next = vi.fn() as unknown as NextFunction;
    const { response, status, json } = createResponseMock();
    const req = { header: vi.fn().mockReturnValue('Basic abc123') } as unknown as Request;

    middleware(req, response, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when bearer token does not match', async () => {
    const middleware = createApiAuthMiddleware({ enabled: true, token: 'secret' });
    const next = vi.fn() as unknown as NextFunction;
    const { response, status, json } = createResponseMock();
    const req = { header: vi.fn().mockReturnValue('Bearer wrong-token') } as unknown as Request;

    middleware(req, response, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when token matches', async () => {
    const middleware = createApiAuthMiddleware({ enabled: true, token: 'secret' });
    const next = vi.fn() as unknown as NextFunction;
    const { response, status } = createResponseMock();
    const req = { header: vi.fn().mockReturnValue('Bearer secret') } as unknown as Request;

    middleware(req, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('bypasses auth when API_AUTH_DISABLED is 1', async () => {
    const middleware = createApiAuthMiddleware({ enabled: false });
    const next = vi.fn() as unknown as NextFunction;
    const { response, status } = createResponseMock();
    const req = { header: vi.fn().mockReturnValue(undefined) } as unknown as Request;

    middleware(req, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });
});
