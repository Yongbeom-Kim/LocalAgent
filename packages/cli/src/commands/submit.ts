import type { TaskSubmission } from '@local-agent/shared';

export interface SubmitOptions {
  payload: string;
  type: string;
  apiUrl: string;
}

export interface SubmitResult {
  success: boolean;
  taskType?: string;
  submittedAt?: string;
  error?: string;
}

export async function submitTask(options: SubmitOptions): Promise<SubmitResult> {
  const url = `${options.apiUrl}/tasks`;
  const body: TaskSubmission = {
    task_type: options.type,
    payload: options.payload,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const cause = (err as TypeError & { cause?: { code?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED') {
      return { success: false, error: `connection refused (${url})` };
    }
    return { success: false, error: `network error (${url})` };
  }

  if (!response.ok) {
    return { success: false, error: `${response.status} ${response.statusText}` };
  }

  const data = await response.json();
  return {
    success: true,
    taskType: data.task_type,
    submittedAt: data.submitted_at,
  };
}
