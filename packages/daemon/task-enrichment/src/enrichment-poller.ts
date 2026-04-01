import { Task, createLogger, generateSessionId } from '@local-agent/shared';
import { EnrichmentService } from './enrichment-service';
import type { ThreadContextFetcher, ThreadContextResult } from './adapters/thread-context-fetcher';

const logger = createLogger('enrichment-daemon:poller');
const CLEANUP_TASK_TYPE = 'cleanup';
const CLEANUP_REJECTION_REASON = 'Cleanup tasks in existing threads require an inherited session_id from the thread root.';
const CLEANUP_MISSING_SOURCE_REASON = 'Cleanup tasks require a Lark task source to resolve the existing session.';
const CLEANUP_MISSING_THREAD_REASON = 'Cleanup tasks require an existing thread with an inherited session_id.';

export class EnrichmentPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly apiUrl: string,
    private readonly enrichmentService: EnrichmentService,
    private readonly threadContextFetcher?: ThreadContextFetcher,
  ) {}

  async pollOnce(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/tasks/next`);

      if (res.status === 204) {
        logger.debug('No tasks available');
        return;
      }

      if (res.status !== 200) {
        logger.warn({ status: res.status }, 'Unexpected response from API');
        return;
      }

      const task = (await res.json()) as Task;
      logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Received task for enrichment');

      const isCleanupTask = task.task_type === CLEANUP_TASK_TYPE;
      let threadResult: ThreadContextResult | null | undefined;

      if (isCleanupTask && task.task_source?.source !== 'lark') {
        logger.warn({ task_id: task.task_id, task_source: task.task_source }, 'Rejected cleanup task without lark task_source');
        await this.publishRejection(task, CLEANUP_MISSING_SOURCE_REASON);
        await this.ackTask(task.task_id);
        return;
      }

      if (this.threadContextFetcher && task.task_source?.source === 'lark') {
        const validTaskTypes = this.enrichmentService.getValidTaskTypes();
        threadResult = await this.threadContextFetcher.fetchThreadContext(task.task_source.message_id, validTaskTypes);

        if (isCleanupTask && !threadResult) {
          logger.warn({ task_id: task.task_id }, 'Rejected cleanup task without thread context');
          await this.publishRejection(task, CLEANUP_MISSING_THREAD_REASON);
          await this.ackTask(task.task_id);
          return;
        }

        if (threadResult?.inheritedTaskType && !isCleanupTask) {
          if (task.task_type === 'generic' || task.task_type === threadResult.inheritedTaskType) {
            task.task_type = threadResult.inheritedTaskType;
            logger.info({ task_id: task.task_id, inherited_task_type: threadResult.inheritedTaskType }, 'Inherited task_type from thread root');
          } else {
            const rejectionReason = `Cannot change task type in a thread. This thread uses task_type '${threadResult.inheritedTaskType}'. Remove the /task prefix or start a new conversation.`;
            logger.warn(
              {
                task_id: task.task_id,
                task_type: task.task_type,
                inherited_task_type: threadResult.inheritedTaskType,
              },
              'Rejected task with mismatched thread task_type',
            );
            await this.publishRejection(task, rejectionReason);
            await this.ackTask(task.task_id);
            return;
          }
        }
      }

      if (isCleanupTask && !threadResult?.inheritedSessionId) {
        logger.warn({ task_id: task.task_id }, 'Rejected cleanup task without inherited session_id');
        await this.publishRejection(task, CLEANUP_REJECTION_REASON);
        await this.ackTask(task.task_id);
        return;
      }

      const sessionId = threadResult?.inheritedSessionId ?? generateSessionId();
      if (threadResult?.inheritedSessionId) {
        logger.info({ task_id: task.task_id, inherited_session_id: sessionId }, 'Inherited session_id from thread root');
      } else {
        logger.info({ task_id: task.task_id, new_session_id: sessionId }, 'Generated new session_id for enrichment');
      }

      const threadHistory = isCleanupTask ? undefined : (threadResult?.threadContext ?? undefined);
      const enrichmentResult = this.enrichmentService.enrich(task, sessionId, threadHistory);

      if (enrichmentResult.type === 'rejected') {
        logger.warn({ task_id: task.task_id, task_type: task.task_type, reason: enrichmentResult.reason }, 'Enrichment rejected task');
        await this.publishRejection(task, enrichmentResult.reason);
        await this.ackTask(task.task_id);
        return;
      }

      try {
        const jobRes = await fetch(`${this.apiUrl}/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enrichmentResult.job),
        });
        if (jobRes.status !== 201) {
          logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed — not acking task');
          return;
        }
      } catch (jobErr) {
        logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed — not acking task');
        return;
      }

      await this.ackTask(task.task_id);
    } catch (err) {
      logger.error({ err }, 'Enrichment poll error');
    }
  }

  private async publishRejection(task: Task, reason: string): Promise<void> {
    try {
      const body = {
        job_id: task.task_id,
        task_id: task.task_id,
        task_type: task.task_type,
        status: 'failure' as const,
        exit_code: null,
        stdout: reason,
        stderr: '',
        ...(task.task_source ? { task_source: task.task_source } : {}),
      };

      const res = await fetch(`${this.apiUrl}/results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status !== 201) {
        logger.error({ task_id: task.task_id, status: res.status }, 'POST /results failed for rejection');
      } else {
        logger.info({ task_id: task.task_id }, 'Published rejection result');
      }
    } catch (err) {
      logger.error({ task_id: task.task_id, err }, 'Failed to publish rejection result');
    }
  }

  private async ackTask(taskId: string): Promise<void> {
    try {
      const ackRes = await fetch(`${this.apiUrl}/tasks/${taskId}/ack`, { method: 'POST' });
      if (ackRes.status !== 200) {
        logger.warn({ task_id: taskId, status: ackRes.status }, 'Task ACK failed');
      } else {
        logger.info({ task_id: taskId }, 'Task acknowledged');
      }
    } catch (ackErr) {
      logger.error({ task_id: taskId, err: ackErr }, 'Task ACK request failed');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs }, 'Starting enrichment poller');
    this.running = true;
    const loop = async () => {
      await this.pollOnce();
      if (this.running) {
        this.timer = setTimeout(loop, intervalMs);
      }
    };
    loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      logger.info('Enrichment poller stopped');
    }
  }
}
