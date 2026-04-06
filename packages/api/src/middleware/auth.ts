import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { createLogger, type ApiAuthConfig } from '@local-agent/shared';

function tokensMatch(providedToken: string, expectedToken: string): boolean {
  const provided = Buffer.from(providedToken, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');

  // Avoid leaking timing information on mismatch.
  if (provided.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }

  return timingSafeEqual(provided, expected);
}

export function createApiAuthMiddleware(config: ApiAuthConfig): RequestHandler {
  const logger = createLogger('api:auth');

  return (req, res, next) => {
    if (!config.enabled) {
      return next();
    }

    const header = req.header('authorization')?.trim();
    if (!header) {
      logger.debug({ path: req.path, method: req.method, reason: 'missing_authorization_header' }, 'API auth rejected request');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      logger.debug({ path: req.path, method: req.method, reason: 'invalid_authorization_scheme' }, 'API auth rejected request');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!tokensMatch(match[1], config.token)) {
      logger.debug({ path: req.path, method: req.method, reason: 'token_mismatch' }, 'API auth rejected request');
      return res.status(403).json({ error: 'Forbidden' });
    }

    return next();
  };
}
