import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  Task,
  isValidTaskContextRef,
  SessionRepository,
  isValidTaskSource,
  isControlTaskType,
  isTaskExecutorType,
  isValidExecutorModel,
} from '@local-agent/shared';
import { RabbitMQService, RabbitMQUnavailableError } from '../services/rabbitmq';

function validateSessionMetadata(session: unknown): { valid: true } | { valid: false; error: string } {
  if (typeof session !== 'object' || session === null) {
    return { valid: false, error: 'session must be an object if provided' };
  }

  const { fallbackSeedText, fallbackOrigin, fallbackTitleHint } = session as Record<string, unknown>;

  if (fallbackSeedText !== undefined && typeof fallbackSeedText !== 'string') {
    return { valid: false, error: 'session.fallbackSeedText must be a string if provided' };
  }
  if (fallbackOrigin !== undefined && typeof fallbackOrigin !== 'string') {
    return { valid: false, error: 'session.fallbackOrigin must be a string if provided' };
  }
  if (fallbackTitleHint !== undefined && typeof fallbackTitleHint !== 'string') {
    return { valid: false, error: 'session.fallbackTitleHint must be a string if provided' };
  }

  return { valid: true };
}

export function createTaskRoutes(
  rabbitmq: RabbitMQService,
  sessionRepository: Pick<SessionRepository, 'upsertSession'>,
): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { task_type, payload, task_source, executor, executor_model, session_id, session, context_ref } = req.body;

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

      if (session_id !== undefined && typeof session_id !== 'string') {
        res.status(400).json({ error: 'session_id must be a string if provided' });
        return;
      }

      if (session !== undefined) {
        const validation = validateSessionMetadata(session);
        if (!validation.valid) {
          res.status(400).json({ error: validation.error });
          return;
        }

        if (session_id === undefined) {
          res.status(400).json({ error: 'session_id is required when session metadata is provided' });
          return;
        }
      }

      if (context_ref !== undefined) {
        if (typeof context_ref !== 'object' || context_ref === null) {
          res.status(400).json({ error: 'context_ref must be an object if provided' });
          return;
        }

        if (!isValidTaskContextRef(context_ref)) {
          const { platform, root_key } = context_ref as Record<string, unknown>;
          if (platform !== 'lark' && platform !== 'telegram') {
            res.status(400).json({ error: 'context_ref.platform must be one of: lark, telegram' });
            return;
          }
          if (typeof root_key !== 'string' || root_key.length === 0) {
            res.status(400).json({ error: 'context_ref.root_key must be a string' });
            return;
          }
          res.status(400).json({ error: 'context_ref must be a valid reporting channel reference' });
          return;
        }
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

      const intakeAtMs = Date.now();
      const task: Task = {
        task_id: uuidv4(),
        task_type,
        payload,
        submitted_at: new Date(intakeAtMs).toISOString(),
        ...(typeof executor === 'string' ? { executor } : {}),
        ...(typeof executor_model === 'string' ? { executor_model } : {}),
        ...(session_id !== undefined ? { session_id } : {}),
        ...(context_ref !== undefined ? { context_ref } : {}),
        ...(task_source ? { task_source } : {}),
      };
      if (session !== undefined && typeof session_id === 'string') {
        const sessionMetadata = session as {
          fallbackSeedText?: string;
          fallbackOrigin?: string;
          fallbackTitleHint?: string;
        };

        // Persist scheduler-owned session metadata before enqueue so retries cannot
        // create duplicate work after a successful publish. This still leaves a
        // narrow follow-up gap where a publish failure can strand canonical session
        // state without a queued task; fixing that cleanly would require an outbox
        // or a dedicated pending/queued intake state.
        await sessionRepository.upsertSession({
          sessionId: session_id,
          taskType: task_type,
          executor: typeof executor === 'string' ? executor : null,
          executorModel: typeof executor_model === 'string' ? executor_model : null,
          status: 'active',
          createdAtMs: intakeAtMs,
          updatedAtMs: intakeAtMs,
          endedAtMs: null,
          fallbackSeedText: sessionMetadata.fallbackSeedText ?? null,
          fallbackOrigin: sessionMetadata.fallbackOrigin ?? null,
          fallbackTitleHint: sessionMetadata.fallbackTitleHint ?? null,
        });
      }

      const buffered = await rabbitmq.publish(task);

      if (!buffered) {
        res.status(503).json({ error: 'Server busy, try again later' });
        return;
      }

      res.status(201).json(task);
    } catch (err) {
      if (err instanceof RabbitMQUnavailableError) {
        res.status(503).json({ error: 'RabbitMQ temporarily unavailable' });
        return;
      }
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
      if (err instanceof RabbitMQUnavailableError) {
        res.status(503).json({ error: 'RabbitMQ temporarily unavailable' });
        return;
      }
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
