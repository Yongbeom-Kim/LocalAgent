import { buildApiAuthHeaders, type TaskContextRef, type TaskSource } from '@local-agent/shared';

export interface TelegramCanonicalTaskSubmitOptions {
  sessionId: string;
  contextRef?: TaskContextRef;
}

export class TelegramTaskSubmitter {
  constructor(
    private readonly apiUrl: string,
    private readonly apiAuthToken?: string,
  ) {}

  async submit(
    taskType: string,
    payload: string,
    taskSource: TaskSource,
    executor?: string,
    executorModel?: string,
    options: TelegramCanonicalTaskSubmitOptions,
  ): Promise<string | null> {
    const res = await fetch(`${this.apiUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildApiAuthHeaders(this.apiAuthToken),
      },
      body: JSON.stringify({
        task_type: taskType,
        payload,
        session_id: options.sessionId,
        task_source: taskSource,
        ...(executor ? { executor } : {}),
        ...(executorModel ? { executor_model: executorModel } : {}),
        ...(options.contextRef ? { context_ref: options.contextRef } : {}),
      }),
    });

    if (res.status !== 201) {
      return null;
    }

    const body = (await res.json()) as { task_id?: string };
    return body.task_id ?? null;
  }
}
