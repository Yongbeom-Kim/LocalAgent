import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  TaskResult,
  RESULT_STATUSES,
  DEFAULT_RESULTS_EXCHANGE_NAME,
  isValidTaskSource,
  isTaskExecutorType,
  isValidExecutorModel,
} from '@local-agent/shared';
import { RabbitMQService } from '../services/rabbitmq';

export function createResultRoutes(rabbitmq: RabbitMQService): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        job_id,
        task_id,
        status,
        exit_code,
        stdout,
        stderr,
        task_source,
        task_type,
        session_id,
        executor,
        executor_model,
      } = req.body;

      if (typeof job_id !== 'string' || !job_id) {
        res.status(400).json({ error: 'job_id is required and must be a string' });
        return;
      }
      if (typeof task_id !== 'string' || !task_id) {
        res.status(400).json({ error: 'task_id is required and must be a string' });
        return;
      }
      if (typeof status !== 'string' || !RESULT_STATUSES.includes(status as any)) {
        res.status(400).json({ error: `status is required and must be one of: ${RESULT_STATUSES.join(', ')}` });
        return;
      }
      if (task_source !== undefined && !isValidTaskSource(task_source)) {
        res.status(400).json({ error: 'task_source must be a valid source object' });
        return;
      }
      if (task_type !== undefined && typeof task_type !== 'string') {
        res.status(400).json({ error: 'task_type must be a string if provided' });
        return;
      }
      if (session_id !== undefined && typeof session_id !== 'string') {
        res.status(400).json({ error: 'session_id must be a string if provided' });
        return;
      }
      if ((executor === undefined) !== (executor_model === undefined)) {
        res.status(400).json({ error: 'executor and executor_model must be provided together' });
        return;
      }
      if (
        executor !== undefined &&
        (!isTaskExecutorType(executor) || !isValidExecutorModel(executor, executor_model))
      ) {
        res.status(400).json({ error: 'executor and executor_model must be a valid pair' });
        return;
      }

      const result: TaskResult = {
        result_id: uuidv4(),
        job_id,
        task_id,
        task_type: typeof task_type === 'string' ? task_type : 'generic',
        status: status as TaskResult['status'],
        exit_code: typeof exit_code === 'number' ? exit_code : null,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        completed_at: new Date().toISOString(),
        ...(task_source ? { task_source } : {}),
        ...(session_id !== undefined ? { session_id } : {}),
        ...(executor !== undefined ? { executor } : {}),
        ...(executor_model !== undefined ? { executor_model } : {}),
      };

      const buffered = rabbitmq.publishToExchange(DEFAULT_RESULTS_EXCHANGE_NAME, result);

      if (!buffered) {
        res.status(503).json({ error: 'Server busy, try again later' });
        return;
      }

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/next/:queueName', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await rabbitmq.getNextFromQueue(req.params.queueName);
      if (!result) {
        res.status(204).send();
        return;
      }
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:queueName/:id/ack', (req: Request, res: Response, next: NextFunction) => {
    try {
      const acked = rabbitmq.ackFromQueue(req.params.queueName, req.params.id);
      if (!acked) {
        res.status(404).json({ error: 'Result not found or already acknowledged' });
        return;
      }
      res.status(200).json({ acknowledged: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
