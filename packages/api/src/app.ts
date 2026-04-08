import express from 'express';
import {
  MAX_API_JSON_BODY_BYTES,
  type ApiAuthConfig,
  type SessionRepository,
} from '@local-agent/shared';
import { createTaskRoutes } from './routes/tasks';
import { createJobRoutes } from './routes/jobs';
import { createResultRoutes } from './routes/results';
import { createHealthRoutes } from './routes/health';
import { errorHandler } from './middleware/error-handler';
import { createApiAuthMiddleware } from './middleware/auth';
import { RabbitMQService } from './services/rabbitmq';

export function createApp(
  rabbitmq: RabbitMQService,
  auth: ApiAuthConfig,
  sessionRepository: Pick<SessionRepository, 'upsertSession'>,
): express.Application {
  const app = express();

  app.use(express.json({ limit: MAX_API_JSON_BODY_BYTES }));
  app.use('/health', createHealthRoutes(rabbitmq));
  app.use(createApiAuthMiddleware(auth));
  app.use('/tasks', createTaskRoutes(rabbitmq, sessionRepository));
  app.use('/jobs', createJobRoutes(rabbitmq));
  app.use('/results', createResultRoutes(rabbitmq));
  app.use(errorHandler);

  return app;
}
