import { Task, createLogger } from '@local-agent/shared';

const logger = createLogger('daemon:poller');

type TaskHandler = (task: Task) => Promise<void>;

export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly apiUrl: string,
    private readonly handler: TaskHandler,
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

      await this.handler(task);

      await fetch(`${this.apiUrl}/tasks/${task.task_id}/ack`, { method: 'POST' });
      logger.info({ task_id: task.task_id }, 'Task acknowledged');
    } catch (err) {
      logger.error({ err }, 'Poll error');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs }, 'Starting poller');
    this.timer = setInterval(() => this.pollOnce(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Poller stopped');
    }
  }
}
