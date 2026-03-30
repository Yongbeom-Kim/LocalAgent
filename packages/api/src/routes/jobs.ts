import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Job, isValidExecutorPreferences, ExecutorPreference } from '@local-agent/shared';
import { RabbitMQService } from '../services/rabbitmq';

export function createJobRoutes(rabbitmq: RabbitMQService): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { task_id, task_type, payload, executors, submitted_at, marketplaces } = req.body;

      if (typeof task_id !== 'string' || !task_id) {
        res.status(400).json({ error: 'task_id is required and must be a string' });
        return;
      }
      if (typeof task_type !== 'string' || !task_type) {
        res.status(400).json({ error: 'task_type is required and must be a string' });
        return;
      }
      if (typeof payload !== 'string') {
        res.status(400).json({ error: 'payload is required and must be a string' });
        return;
      }
      if (!isValidExecutorPreferences(executors)) {
        res.status(400).json({
          error: 'executors must be a non-empty array of valid {executor, executor_model} pairs',
        });
        return;
      }
      if (typeof submitted_at !== 'string' || !submitted_at) {
        res.status(400).json({ error: 'submitted_at is required and must be a string' });
        return;
      }

      const job: Job = {
        job_id: uuidv4(),
        task_id,
        task_type,
        payload,
        executors,
        submitted_at,
        enriched_at: new Date().toISOString(),
        ...(marketplaces ? { marketplaces } : {}),
      };
      const buffered = rabbitmq.publishJob(job);

      if (!buffered) {
        res.status(503).json({ error: 'Server busy, try again later' });
        return;
      }

      res.status(201).json(job);
    } catch (err) {
      next(err);
    }
  });

  router.get('/next', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await rabbitmq.getNextJob();
      if (!job) {
        res.status(204).send();
        return;
      }
      res.status(200).json(job);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/ack', (req: Request, res: Response, next: NextFunction) => {
    try {
      const acked = rabbitmq.ackJob(req.params.id);
      if (!acked) {
        res.status(404).json({ error: 'Job not found or already acknowledged' });
        return;
      }
      res.status(200).json({ acknowledged: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
