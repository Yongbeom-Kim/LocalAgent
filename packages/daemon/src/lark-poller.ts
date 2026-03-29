import { TaskResult, createLogger } from '@local-agent/shared';
import { LarkNotifier } from './adapters/lark-notifier';

const logger = createLogger('lark-daemon:poller');

export class LarkPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly apiUrl: string,
    private readonly queueName: string,
    private readonly notifier: LarkNotifier,
  ) {}

  async pollOnce(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/results/next/${this.queueName}`);

      if (res.status === 204) {
        logger.debug('No results available');
        return;
      }

      if (res.status !== 200) {
        logger.warn({ status: res.status }, 'Unexpected response from API');
        return;
      }

      const result = (await res.json()) as TaskResult;
      logger.info({ result_id: result.result_id, task_id: result.task_id }, 'Received result');

      let notificationSuccess = false;
      try {
        await this.notifier.notify(result);
        notificationSuccess = true;
      } catch (notifyErr) {
        logger.error({ result_id: result.result_id, err: notifyErr }, 'Notification failed');
      }

      try {
        const ackRes = await fetch(`${this.apiUrl}/results/${this.queueName}/${result.result_id}/ack`, {
          method: 'POST',
        });
        if (ackRes.status !== 200) {
          logger.warn({ result_id: result.result_id, status: ackRes.status }, 'Result ACK failed');
        } else {
          logger.info({ result_id: result.result_id }, 'Result acknowledged');
        }
      } catch (ackErr) {
        logger.error({ result_id: result.result_id, err: ackErr }, 'Result ACK request failed');
      }
    } catch (err) {
      logger.error({ err }, 'Lark poll error');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs, queueName: this.queueName }, 'Starting lark poller');
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
      logger.info('Lark poller stopped');
    }
  }
}
