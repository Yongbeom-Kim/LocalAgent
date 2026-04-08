import { buildApiAuthHeaders, createLogger, type Job, type TaskPhaseEventSubmission } from '@local-agent/shared';

const logger = createLogger('task-daemon:phase-publisher');

export class TaskPhasePublisher {
  constructor(
    private readonly apiUrl: string,
    private readonly apiAuthToken?: string,
  ) {}

  async publish(job: Job, phase: TaskPhaseEventSubmission['phase']): Promise<void> {
    const body: TaskPhaseEventSubmission = {
      task_id: job.task_id,
      session_id: job.session_id,
      ...(job.context_ref ? { context_ref: job.context_ref } : {}),
      task_type: job.task_type,
      phase,
      ...(job.task_source ? { task_source: job.task_source } : {}),
      metadata: { emitted_by: 'task-daemon' },
    };

    const res = await fetch(`${this.apiUrl}/results`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildApiAuthHeaders(this.apiAuthToken),
      },
      body: JSON.stringify({ event_kind: 'phase', ...body }),
    });

    if (res.status === 401 || res.status === 403) {
      logger.warn(
        { job_id: job.job_id, task_id: job.task_id, phase, status: res.status },
        'API authentication failed while publishing task phase; check API_AUTH_TOKEN or API_AUTH_DISABLED',
      );
      throw new Error(`Phase publish failed with auth status ${res.status}`);
    }

    if (!res.ok) {
      throw new Error(`Phase publish failed with status ${res.status}`);
    }

    logger.debug({ job_id: job.job_id, task_id: job.task_id, phase }, 'Published task phase');
  }
}
