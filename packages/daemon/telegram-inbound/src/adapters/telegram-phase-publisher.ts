import { buildApiAuthHeaders, type TaskSource } from '@local-agent/shared';

export class TelegramPhasePublisher {
  constructor(
    private readonly apiUrl: string,
    private readonly apiAuthToken?: string,
  ) {}

  async publishReceived(params: {
    taskId: string;
    taskType: string;
    taskSource: TaskSource;
    sessionId?: string;
  }): Promise<void> {
    await fetch(`${this.apiUrl}/results`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildApiAuthHeaders(this.apiAuthToken),
      },
      body: JSON.stringify({
        event_kind: 'phase',
        task_id: params.taskId,
        task_type: params.taskType,
        phase: 'received',
        task_source: params.taskSource,
        ...(params.sessionId ? { session_id: params.sessionId } : {}),
        metadata: { emitted_by: 'telegram-listener' },
      }),
    });
  }

  async publishCompletedSyntheticFailure(params: {
    taskId: string;
    taskType: string;
    taskSource: TaskSource;
    sessionId: string;
    reason: string;
  }): Promise<void> {
    await fetch(`${this.apiUrl}/results`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildApiAuthHeaders(this.apiAuthToken),
      },
      body: JSON.stringify({
        event_kind: 'phase',
        task_id: params.taskId,
        task_type: params.taskType,
        phase: 'completed',
        task_source: params.taskSource,
        session_id: params.sessionId,
        metadata: { emitted_by: 'telegram-listener', note: 'synthetic-failure' },
      }),
    });

    await fetch(`${this.apiUrl}/results`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildApiAuthHeaders(this.apiAuthToken),
      },
      body: JSON.stringify({
        event_kind: 'result',
        job_id: params.taskId,
        task_id: params.taskId,
        task_type: params.taskType,
        session_id: params.sessionId,
        status: 'failure',
        exit_code: null,
        stdout: params.reason,
        stderr: '',
        task_source: params.taskSource,
      }),
    });
  }
}
