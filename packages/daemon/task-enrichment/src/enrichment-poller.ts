import { Task, createLogger } from '@local-agent/shared';
import { EnrichmentService } from './enrichment-service';
import type { ThreadContextFetcher } from './adapters/thread-context-fetcher';

const logger = createLogger('enrichment-daemon:poller');

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

      if (this.threadContextFetcher && task.task_source?.source === 'lark') {
        const validTaskTypes = this.enrichmentService.getValidTaskTypes();
        const threadResult = await this.threadContextFetcher.fetchThreadContext(task.task_source.message_id, validTaskTypes);
        if (threadResult) {
          if (task.task_type === 'generic' && threadResult.inheritedTaskType) {
            task.task_type = threadResult.inheritedTaskType;
            logger.info({ task_id: task.task_id, inherited_task_type: threadResult.inheritedTaskType }, 'Inherited task_type from thread root');
          }
          if (threadResult.threadContext) {
            task.payload = `--- Thread Context ---\n${threadResult.threadContext}\n--- Current Message ---\n${task.payload}`;
            logger.info({ task_id: task.task_id }, 'Prepended thread context to payload');
          }
        }
      }

      const enrichmentResult = this.enrichmentService.enrich(task);

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
