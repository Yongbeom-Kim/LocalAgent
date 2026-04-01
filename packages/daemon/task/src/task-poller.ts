import {
  Job,
  TaskResultSubmission,
  createLogger,
  MAX_SNIPPET_CHARS,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
} from '@local-agent/shared';
import { TaskOrchestrator } from './core/task-orchestrator';
import { SessionLockManager } from './services/session-lock';

const logger = createLogger('task-daemon:poller');

export class TaskPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlightJobs = new Map<string, Promise<void>>();
  private activeSessions = new Set<string>();
  private basePollInterval = 0;
  private currentPollInterval = 0;

  constructor(
    private readonly apiUrl: string,
    private readonly orchestrator: TaskOrchestrator,
    private readonly sessionLock: SessionLockManager,
    private readonly maxConcurrency: number = DEFAULT_MAX_CONCURRENT_SESSIONS,
  ) {}

  async pollOnce(): Promise<void> {
    try {
      if (this.inFlightJobs.size >= this.maxConcurrency) {
        this.increasePollInterval();
        logger.info(
          { inFlight: this.inFlightJobs.size, maxConcurrency: this.maxConcurrency },
          'At capacity, backing off',
        );
        return;
      }

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

      if (this.sessionLock.acquire(job.session_id, job.job_id)) {
        this.activeSessions.add(job.session_id);
        const promise = this.executeJob(job);
        this.inFlightJobs.set(job.job_id, promise);
      } else {
        logger.info({ job_id: job.job_id, session_id: job.session_id }, 'Session locked, requeueing job');
        // NACK immediately — do not sleep here; sleeping blocks the poll loop from
        // dispatching other jobs or responding to shutdown for the full delay duration.
        try {
          await fetch(`${this.apiUrl}/jobs/${job.job_id}/nack`, { method: 'POST' });
        } catch (nackErr) {
          logger.error({ job_id: job.job_id, err: nackErr }, 'NACK request failed');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Poll error');
    }
  }

  private async executeJob(job: Job): Promise<void> {
    try {
      const result = await this.orchestrator.handle(job);

      // Truncate stdout
      if (result.stdout.length > MAX_SNIPPET_CHARS) {
        result.stdout = result.stdout.substring(0, MAX_SNIPPET_CHARS);
      }

      // Attach routing fields
      const resultWithSource: TaskResultSubmission = {
        ...result,
        task_type: job.task_type,
        session_id: job.session_id,
        ...(job.task_source ? { task_source: job.task_source } : {}),
      };

      // Publish result (best-effort)
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
      logger.error({ job_id: job.job_id, err }, 'Orchestrator error — not acking');
    } finally {
      this.sessionLock.release(job.session_id);
      this.inFlightJobs.delete(job.job_id);
      this.activeSessions.delete(job.session_id);
      this.resetPollInterval();
      logger.info(
        { job_id: job.job_id, inFlight: this.inFlightJobs.size },
        'Job completed, slot freed',
      );
    }
  }

  private increasePollInterval(): void {
    this.currentPollInterval = Math.min(this.currentPollInterval * 2, 30_000);
  }

  private resetPollInterval(): void {
    this.currentPollInterval = this.basePollInterval;
  }

  start(intervalMs: number): void {
    this.basePollInterval = intervalMs;
    this.currentPollInterval = intervalMs;
    this.running = true;

    logger.info({ intervalMs }, 'Starting task poller');

    const loop = async () => {
      await this.pollOnce();
      if (this.running) {
        this.timer = setTimeout(loop, this.currentPollInterval);
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

  async drain(): Promise<void> {
    this.stop();
    if (this.inFlightJobs.size > 0) {
      logger.info({ count: this.inFlightJobs.size }, 'Waiting for in-flight jobs to complete');
      await Promise.all(this.inFlightJobs.values());
      logger.info('All in-flight jobs completed');
    }
  }
}
