import { Command } from 'commander';
import { DEFAULT_API_URL, type TaskSubmission } from '@local-agent/shared';

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
  const url = `${options.apiUrl.replace(/\/+$/, '')}/tasks`;
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

  try {
    const data = (await response.json()) as { task_type: string; submitted_at: string };
    return {
      success: true,
      taskType: data.task_type,
      submittedAt: data.submitted_at,
    };
  } catch {
    return { success: false, error: 'invalid response from server (non-JSON body)' };
  }
}

export function registerSubmitCommand(program: Command): void {
  program
    .command('submit')
    .description('Submit a task to the queue')
    .requiredOption('-p, --payload <string>', 'Task payload')
    .option('-t, --type <string>', 'Task type', 'generic')
    .option('-u, --api-url <string>', 'API base URL')
    .action(async (opts: { payload: string; type: string; apiUrl?: string }) => {
      const apiUrl = opts.apiUrl ?? process.env.API_URL ?? DEFAULT_API_URL;

      const result = await submitTask({ payload: opts.payload, type: opts.type, apiUrl });

      if (result.success) {
        console.log('Task submitted successfully.');
        console.log(`  Type: ${result.taskType}`);
        console.log(`  Submitted at: ${result.submittedAt}`);
      } else {
        console.error(`Error: Failed to submit task — ${result.error}`);
        process.exit(1);
      }
    });
}
