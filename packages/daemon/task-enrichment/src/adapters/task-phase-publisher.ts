import { buildApiAuthHeaders, createLogger, type Task, type TaskPhaseEventSubmission } from '@local-agent/shared';

const logger = createLogger('enrichment-daemon:phase-publisher');

export class ApiAuthConfigurationError extends Error {}

export class TaskPhasePublisher {
  constructor(
    private readonly apiUrl: string,
    private readonly apiAuthToken?: string,
  ) {}

  async publish(task: Task, phase: TaskPhaseEventSubmission['phase']): Promise<void> {
    const body: TaskPhaseEventSubmission = {
      task_id: task.task_id,
      task_type: task.task_type,
      phase,
      ...(task.session_id ? { session_id: task.session_id } : {}),
      ...(task.context_ref ? { context_ref: task.context_ref } : {}),
      ...(task.task_source ? { task_source: task.task_source } : {}),
      metadata: { emitted_by: 'task-enrichment' },
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
        { task_id: task.task_id, phase, status: res.status },
        'API authentication failed while publishing task phase; check API_AUTH_TOKEN or API_AUTH_DISABLED',
      );
      throw new ApiAuthConfigurationError(`Phase publish failed with auth status ${res.status}`);
    }

    if (!res.ok) {
      throw new Error(`Phase publish failed with status ${res.status}`);
    }

    logger.debug({ task_id: task.task_id, phase }, 'Published task phase');
  }
}
