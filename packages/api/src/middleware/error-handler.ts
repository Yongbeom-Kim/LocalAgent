import { Request, Response, NextFunction } from 'express';
import { createLogger } from '@local-agent/shared';

const logger = createLogger('api:error');

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}
