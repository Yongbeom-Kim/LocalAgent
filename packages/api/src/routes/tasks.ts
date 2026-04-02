import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  Task,
  isValidTaskSource,
  isControlTaskType,
  isTaskExecutorType,
  isValidExecutorModel,
} from '@local-agent/shared';
import { RabbitMQService } from '../services/rabbitmq';

export function createTaskRoutes(rabbitmq: RabbitMQService): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { task_type, payload, task_source, executor, executor_model } = req.body;

      if (typeof task_type !== 'string') {
        res.status(400).json({ error: 'task_type is required and must be a string' });
        return;
      }
      if (typeof payload !== 'string') {
        res.status(400).json({ error: 'payload is required and must be a string' });
        return;
      }

      if (task_source !== undefined && !isValidTaskSource(task_source)) {
        res.status(400).json({ error: 'task_source must be a valid source object' });
        return;
      }

      if (executor_model !== undefined && executor === undefined) {
        res.status(400).json({ error: 'executor_model requires executor' });
        return;
      }

      const isControl = isControlTaskType(task_type);

      if (
        isControl &&
        executor !== undefined &&
        (!isTaskExecutorType(executor) ||
          executor_model === undefined ||
          !isValidExecutorModel(executor, executor_model))
      ) {
        res.status(400).json({ error: 'executor and executor_model must be a valid pair' });
        return;
      }

      const task: Task = {
        task_id: uuidv4(),
        task_type,
        payload,
        submitted_at: new Date().toISOString(),
        ...(typeof executor === 'string' ? { executor } : {}),
        ...(typeof executor_model === 'string' ? { executor_model } : {}),
        ...(task_source ? { task_source } : {}),
      };
      const buffered = rabbitmq.publish(task);

      if (!buffered) {
        res.status(503).json({ error: 'Server busy, try again later' });
        return;
      }

      res.status(201).json(task);
    } catch (err) {
      next(err);
    }
  });

  router.get('/next', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const task = await rabbitmq.getNext();
      if (!task) {
        res.status(204).send();
        return;
      }
      res.status(200).json(task);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/ack', (req: Request, res: Response, next: NextFunction) => {
    try {
      const acked = rabbitmq.ack(req.params.id);
      if (!acked) {
        res.status(404).json({ error: 'Task not found or already acknowledged' });
        return;
      }
      res.status(200).json({ acknowledged: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
