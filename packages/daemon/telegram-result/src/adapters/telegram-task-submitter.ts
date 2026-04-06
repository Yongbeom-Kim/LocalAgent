import { buildApiAuthHeaders, type TaskSource } from '@local-agent/shared';

export class TelegramTaskSubmitter {
  constructor(
    private readonly apiUrl: string,
    private readonly apiAuthToken?: string,
  ) {}

  async submit(task_type: string, payload: string, taskSource: TaskSource): Promise<string | null> {
    const res = await fetch(`${this.apiUrl}/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildApiAuthHeaders(this.apiAuthToken),
      },
      body: JSON.stringify({ task_type, payload, task_source: taskSource }),
    });

    if (res.status !== 201) {
      return null;
    }

    const body = await res.json() as { task_id?: string };
    return body.task_id ?? null;
  }
}
