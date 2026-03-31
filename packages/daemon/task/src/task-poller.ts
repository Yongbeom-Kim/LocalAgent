import { Job, TaskResultSubmission, createLogger } from '@local-agent/shared';
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
      const res = await fetch(`${this.apiUrl}/jobs/next`);

      if (res.status === 204) {
        logger.debug('No jobs available');
        return;
      }

      if (res.status !== 200) {
        logger.warn({ status: res.status }, 'Unexpected response from API');
        return;
      }

      const job = (await res.json()) as Job;
      logger.info({ job_id: job.job_id, task_id: job.task_id }, 'Received job');

      let result: TaskResultSubmission;
      try {
        result = await this.orchestrator.handle(job);
      } catch (err) {
        logger.error({ job_id: job.job_id, err }, 'Orchestrator error — not acking');
        return;
      }

      // Attach task_type and task_source from job to result for downstream routing
      const resultWithSource: TaskResultSubmission = {
        ...result,
        task_type: job.task_type,
        ...(job.task_source ? { task_source: job.task_source } : {}),
      };

      // Publish result to API (best-effort)
      try {
        const resultRes = await fetch(`${this.apiUrl}/results`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(resultWithSource),
        });
        if (resultRes.status !== 201) {
          logger.warn({ job_id: job.job_id, status: resultRes.status }, 'Result publish failed');
        }
      } catch (resultErr) {
        logger.error({ job_id: job.job_id, err: resultErr }, 'Result publish request failed');
      }

      // ACK the job
      try {
        const ackRes = await fetch(`${this.apiUrl}/jobs/${job.job_id}/ack`, { method: 'POST' });
        if (ackRes.status !== 200) {
          logger.warn({ job_id: job.job_id, status: ackRes.status }, 'ACK failed');
        } else {
          logger.info({ job_id: job.job_id }, 'Job acknowledged');
        }
      } catch (ackErr) {
        logger.error({ job_id: job.job_id, err: ackErr }, 'ACK request failed');
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
