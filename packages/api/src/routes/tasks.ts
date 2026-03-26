import { Router, Request, Response } from 'express';
import { RabbitMQService } from '../services/rabbitmq';

export function createTaskRoutes(rabbitmq: RabbitMQService): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const { task_type, payload } = req.body;

    if (typeof task_type !== 'string' || !task_type) {
      res.status(400).json({ error: 'task_type is required and must be a string' });
      return;
    }
    if (typeof payload !== 'string') {
      res.status(400).json({ error: 'payload is required and must be a string' });
      return;
    }

    const submitted_at = new Date().toISOString();
    rabbitmq.publish({ task_type, payload, submitted_at });

    res.status(201).json({ task_type, payload, submitted_at });
  });

  router.get('/next', async (req: Request, res: Response) => {
    const task = await rabbitmq.getNext();
    if (!task) {
      res.status(204).send();
      return;
    }
    res.status(200).json(task);
  });

  router.post('/:id/ack', (req: Request, res: Response) => {
    const acked = rabbitmq.ack(req.params.id);
    if (!acked) {
      res.status(404).json({ error: 'Task not found or already acknowledged' });
      return;
    }
    res.status(200).json({ acknowledged: true });
  });

  return router;
}
