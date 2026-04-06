import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  type MirrorTaskEvent,
  TaskPhaseEvent,
  TaskResultEvent,
  TASK_EVENT_KINDS,
  isValidTaskPhase,
  RESULT_STATUSES,
  DEFAULT_RESULTS_EXCHANGE_NAME,
  isValidTaskSource,
  isTaskExecutorType,
  isValidExecutorModel,
} from '@local-agent/shared';
import { RabbitMQService, RabbitMQUnavailableError } from '../services/rabbitmq';

export function createResultRoutes(rabbitmq: RabbitMQService): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const eventKind = req.body.event_kind ?? 'result';

      if (
        typeof eventKind !== 'string' ||
        !TASK_EVENT_KINDS.includes(eventKind as (typeof TASK_EVENT_KINDS)[number])
      ) {
        res.status(400).json({
          error: `event_kind is required and must be one of: ${TASK_EVENT_KINDS.join(', ')}`,
        });
        return;
      }

      if (eventKind === 'phase') {
        const {
          task_id,
          phase,
          task_source,
          task_type,
          session_id,
          executor,
          executor_model,
          metadata,
        } = req.body;

        if (typeof task_id !== 'string' || !task_id) {
          res.status(400).json({ error: 'task_id is required and must be a string' });
          return;
        }
        if (typeof task_type !== 'string' || !task_type) {
          res.status(400).json({ error: 'task_type is required and must be a string' });
          return;
        }
        if (!isValidTaskPhase(phase)) {
          res.status(400).json({ error: 'phase is required and must be a valid task phase' });
          return;
        }
        if (task_source !== undefined && !isValidTaskSource(task_source)) {
          res.status(400).json({ error: 'task_source must be a valid source object' });
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

        if (metadata !== undefined) {
          if (typeof metadata !== 'object' || metadata === null) {
            res.status(400).json({ error: 'metadata must be an object if provided' });
            return;
          }

          const { thread_id, emitted_by, note } = metadata as Record<string, unknown>;
          if (thread_id !== undefined && typeof thread_id !== 'string') {
            res.status(400).json({ error: 'metadata.thread_id must be a string if provided' });
            return;
          }
          if (
            emitted_by !== 'lark-listener' &&
            emitted_by !== 'telegram-listener' &&
            emitted_by !== 'task-enrichment' &&
            emitted_by !== 'task-daemon'
          ) {
            res.status(400).json({
              error: 'metadata.emitted_by is required and must be one of: lark-listener, telegram-listener, task-enrichment, task-daemon',
            });
            return;
          }
          if (note !== undefined && typeof note !== 'string') {
            res.status(400).json({ error: 'metadata.note must be a string if provided' });
            return;
          }
        }

        const phaseEvent: TaskPhaseEvent = {
          event_kind: 'phase',
          event_id: uuidv4(),
          task_id,
          task_type,
          phase,
          emitted_at: new Date().toISOString(),
          ...(task_source ? { task_source } : {}),
          ...(session_id !== undefined ? { session_id } : {}),
          ...(executor !== undefined ? { executor } : {}),
          ...(executor_model !== undefined ? { executor_model } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        };

        const buffered = await rabbitmq.publishToExchange(DEFAULT_RESULTS_EXCHANGE_NAME, phaseEvent);

        if (!buffered) {
          res.status(503).json({ error: 'Server busy, try again later' });
          return;
        }

        res.status(201).json(phaseEvent);
        return;
      }

      if (eventKind === 'mirror') {
        const {
          task_id,
          session_id,
          task_type,
          task_source,
          mirror_id,
          author_type,
          text,
          origin_message_id,
        } = req.body;

        if (typeof task_id !== 'string' || !task_id) {
          res.status(400).json({ error: 'task_id is required and must be a string' });
          return;
        }
        if (typeof session_id !== 'string' || !session_id) {
          res.status(400).json({ error: 'session_id is required and must be a string' });
          return;
        }
        if (typeof task_type !== 'string' || !task_type) {
          res.status(400).json({ error: 'task_type is required and must be a string' });
          return;
        }
        if (!isValidTaskSource(task_source)) {
          res.status(400).json({ error: 'task_source is required and must be a valid source object' });
          return;
        }
        if (typeof mirror_id !== 'string' || !mirror_id) {
          res.status(400).json({ error: 'mirror_id is required and must be a string' });
          return;
        }
        if (author_type !== 'user') {
          res.status(400).json({ error: 'author_type is required and must be user' });
          return;
        }
        if (typeof text !== 'string') {
          res.status(400).json({ error: 'text is required and must be a string' });
          return;
        }
        if (typeof origin_message_id !== 'string' || !origin_message_id) {
          res.status(400).json({ error: 'origin_message_id is required and must be a string' });
          return;
        }

        const mirrorEvent: MirrorTaskEvent = {
          event_kind: 'mirror',
          task_id,
          session_id,
          task_type,
          task_source,
          mirror_id,
          author_type: 'user',
          text,
          origin_message_id,
          emitted_at: new Date().toISOString(),
        };

        const buffered = await rabbitmq.publishToExchange(DEFAULT_RESULTS_EXCHANGE_NAME, mirrorEvent);

        if (!buffered) {
          res.status(503).json({ error: 'Server busy, try again later' });
          return;
        }

        res.status(201).json(mirrorEvent);
        return;
      }

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
      const resultStatus = status as (typeof RESULT_STATUSES)[number];
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

      const result: TaskResultEvent = {
        event_kind: 'result',
        result_id: uuidv4(),
        job_id,
        task_id,
        task_type: typeof task_type === 'string' ? task_type : 'generic',
        status: resultStatus,
        exit_code: typeof exit_code === 'number' ? exit_code : null,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        completed_at: new Date().toISOString(),
        ...(task_source ? { task_source } : {}),
        ...(session_id !== undefined ? { session_id } : {}),
        ...(executor !== undefined ? { executor } : {}),
        ...(executor_model !== undefined ? { executor_model } : {}),
      };

      const buffered = await rabbitmq.publishToExchange(DEFAULT_RESULTS_EXCHANGE_NAME, result);

      if (!buffered) {
        res.status(503).json({ error: 'Server busy, try again later' });
        return;
      }

      res.status(201).json(result);
    } catch (err) {
      if (err instanceof RabbitMQUnavailableError) {
        res.status(503).json({ error: 'RabbitMQ temporarily unavailable' });
        return;
      }
      next(err);
    }
  });

  router.get('/next/:queueName', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = await rabbitmq.getNextFromQueue(req.params.queueName);
      if (!event) {
        res.status(204).send();
        return;
      }
      res.status(200).json(event);
    } catch (err) {
      if (err instanceof RabbitMQUnavailableError) {
        res.status(503).json({ error: 'RabbitMQ temporarily unavailable' });
        return;
      }
      next(err);
    }
  });

  router.post('/:queueName/:id/ack', (req: Request, res: Response, next: NextFunction) => {
    try {
      const acked = rabbitmq.ackFromQueue(req.params.queueName, req.params.id);
      if (!acked) {
        res.status(404).json({ error: 'Task event not found or already acknowledged' });
        return;
      }
      res.status(200).json({ acknowledged: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
