import { Task, TaskResultSubmission, createLogger } from '@local-agent/shared';
import { TaskOrchestrator } from './core/task-orchestrator';

const logger = createLogger('task-daemon:poller');

export class TaskPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly apiUrl: string,
    private readonly orchestrator: TaskOrchestrator,
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
      logger.info({ task_id: task.task_id }, 'Received task');

      let result: TaskResultSubmission;
      try {
        result = await this.orchestrator.handle(task);
      } catch (err) {
        logger.error({ task_id: task.task_id, err }, 'Orchestrator error — not acking');
        return;
      }

      // Publish result to API (best-effort)
      try {
        const resultRes = await fetch(`${this.apiUrl}/results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result),
        });
        if (resultRes.status !== 201) {
          logger.warn({ task_id: task.task_id, status: resultRes.status }, 'Result publish failed');
        }
      } catch (resultErr) {
        logger.error({ task_id: task.task_id, err: resultErr }, 'Result publish request failed');
      }

      // ACK the task
      try {
        const ackRes = await fetch(`${this.apiUrl}/tasks/${task.task_id}/ack`, { method: 'POST' });
        if (ackRes.status !== 200) {
          logger.warn({ task_id: task.task_id, status: ackRes.status }, 'ACK failed');
        } else {
          logger.info({ task_id: task.task_id }, 'Task acknowledged');
        }
      } catch (ackErr) {
        logger.error({ task_id: task.task_id, err: ackErr }, 'ACK request failed');
      }
    } catch (err) {
      logger.error({ err }, 'Poll error');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs }, 'Starting task poller');
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
      logger.info('Task poller stopped');
    }
  }
}
