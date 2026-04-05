import { createLogger, type Task, type TaskPhaseEventSubmission } from '@local-agent/shared';

const logger = createLogger('enrichment-daemon:phase-publisher');

export class TaskPhasePublisher {
  constructor(private readonly apiUrl: string) {}

  async publish(task: Task, phase: TaskPhaseEventSubmission['phase']): Promise<void> {
    const body: TaskPhaseEventSubmission = {
      task_id: task.task_id,
      task_type: task.task_type,
      phase,
      ...(task.task_source ? { task_source: task.task_source } : {}),
      metadata: { emitted_by: 'task-enrichment' },
    };

    const res = await fetch(`${this.apiUrl}/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_kind: 'phase', ...body }),
    });

    if (!res.ok) {
      throw new Error(`Phase publish failed with status ${res.status}`);
    }

    logger.debug({ task_id: task.task_id, phase }, 'Published task phase');
  }
}
