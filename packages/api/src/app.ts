import express from 'express';
import { createTaskRoutes } from './routes/tasks';
import { createResultRoutes } from './routes/results';
import { createHealthRoutes } from './routes/health';
import { errorHandler } from './middleware/error-handler';
import { RabbitMQService } from './services/rabbitmq';

export function createApp(rabbitmq: RabbitMQService): express.Application {
  const app = express();

  app.use(express.json());
  app.use('/tasks', createTaskRoutes(rabbitmq));
  app.use('/results', createResultRoutes(rabbitmq));
  app.use('/health', createHealthRoutes(rabbitmq));
  app.use(errorHandler);

  return app;
}
