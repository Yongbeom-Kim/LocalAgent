import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Job, isValidExecutorPreferences, isValidTaskSource } from '@local-agent/shared';
import { RabbitMQService } from '../services/rabbitmq';

export function createJobRoutes(rabbitmq: RabbitMQService): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { task_id, task_type, payload, history, executors, submitted_at, session_id, system_prompt, marketplaces, task_source, setup_hook, setup_hook_timeout_ms } = req.body;

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
      if (typeof session_id !== 'string' || !session_id) {
        res.status(400).json({ error: 'session_id is required and must be a non-empty string' });
        return;
      }
      if (task_source !== undefined && !isValidTaskSource(task_source)) {
        res.status(400).json({ error: 'task_source must be a valid source object' });
        return;
      }

      const job: Job = {
        job_id: uuidv4(),
        task_id,
        task_type,
        payload,
        ...(history ? { history } : {}),
        executors,
        submitted_at,
        session_id,
        enriched_at: new Date().toISOString(),
        ...(system_prompt ? { system_prompt } : {}),
        ...(marketplaces ? { marketplaces } : {}),
        ...(task_source ? { task_source } : {}),
        ...(setup_hook !== undefined ? { setup_hook } : {}),
        ...(setup_hook_timeout_ms !== undefined ? { setup_hook_timeout_ms } : {}),
      };
      const buffered = await rabbitmq.publishJob(job);

      if (!buffered) {
        res.status(503).json({ error: 'Server busy, try again later' });
        return;
      }

      res.status(201).json(job);
    } catch (err) {
      next(err);
    }
  });

  router.get('/sessions', async (req: Request, res: Response) => {
    try {
      const sessions = await rabbitmq.listSessionQueues();
      res.status(200).json({ sessions });
    } catch {
      res.status(503).json({ error: 'Session queue discovery unavailable' });
    }
  });

  router.get('/next/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const job = await rabbitmq.getNextJobFromSession(req.params.sessionId);
      if (!job) {
        res.status(204).send();
        return;
      }
      res.status(200).json(job);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:sessionId/:id/ack', (req: Request, res: Response, next: NextFunction) => {
    try {
      const acked = rabbitmq.ackJobFromSession(req.params.sessionId, req.params.id);
      if (!acked) {
        res.status(404).json({ error: 'Job not found or already acknowledged' });
        return;
      }
      res.status(200).json({ acknowledged: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:sessionId/:id/nack', (req: Request, res: Response, next: NextFunction) => {
    try {
      const nacked = rabbitmq.nackJobFromSession(req.params.sessionId, req.params.id);
      if (!nacked) {
        res.status(404).json({ error: 'Job not found or already processed' });
        return;
      }
      res.status(200).json({ requeued: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
