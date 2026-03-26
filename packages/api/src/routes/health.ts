import { Router, Request, Response } from 'express';
import { RabbitMQService } from '../services/rabbitmq';

export function createHealthRoutes(rabbitmq: RabbitMQService): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      rabbitmq: rabbitmq.isConnected() ? 'connected' : 'disconnected',
    });
  });

  return router;
}
