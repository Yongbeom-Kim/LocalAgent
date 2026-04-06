import { Command } from 'commander';
import {
  DEFAULT_API_URL,
  buildApiAuthHeaders,
  resolveApiClientToken,
  type TaskSubmission,
  type TaskExecutorType,
} from '@local-agent/shared';

export interface SubmitOptions {
  payload: string;
  type: string;
  executor: TaskExecutorType;
  model: string;
  apiUrl: string;
  token?: string;
  env?: Record<string, string | undefined>;
}

export interface SubmitResult {
  success: boolean;
  taskType?: string;
  submittedAt?: string;
  error?: string;
}

export async function submitTask(options: SubmitOptions): Promise<SubmitResult> {
  const env = options.env ?? process.env;
  const token = resolveApiClientToken({
    explicitToken: options.token,
    env,
  });

  if (env.API_AUTH_DISABLED !== '1' && !token) {
    return {
      success: false,
      error: 'API auth is enabled but no token is configured. Pass --token or set API_AUTH_TOKEN.',
    };
  }

  const url = `${options.apiUrl.replace(/\/+$/, '')}/tasks`;
  const body: TaskSubmission = {
    task_type: options.type,
    payload: options.payload,
    executor: options.executor,
    executor_model: options.model,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildApiAuthHeaders(token),
      },
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
    const body = await response.text().catch(() => '');
    const detail = body ? ` — ${body}` : '';
    return { success: false, error: `${response.status} ${response.statusText}${detail}` };
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

export function registerSubmitCommand(
  program: Command,
  submit: typeof submitTask = submitTask,
): void {
  program
    .command('submit')
    .description('Submit a task to the queue')
    .requiredOption('-p, --payload <string>', 'Task payload')
    .requiredOption('-t, --type <string>', 'Task type')
    .requiredOption('-e, --executor <string>', 'Executor')
    .requiredOption('-m, --model <string>', 'Executor model')
    .option('-u, --api-url <string>', 'API base URL')
    .option('--token <value>', 'API bearer token')
    .action(
      async (opts: {
        payload: string;
        type: string;
        executor: TaskExecutorType;
        model: string;
        apiUrl?: string;
        token?: string;
      }) => {
      const apiUrl = opts.apiUrl ?? process.env.API_URL ?? DEFAULT_API_URL;

      const result = await submit({
        payload: opts.payload,
        type: opts.type,
        executor: opts.executor,
        model: opts.model,
        apiUrl,
        token: opts.token,
      });

      if (result.success) {
        console.log('Task submitted successfully.');
        console.log(`  Type: ${result.taskType}`);
        console.log(`  Submitted at: ${result.submittedAt}`);
      } else {
        console.error(`Error: Failed to submit task — ${result.error}`);
        process.exit(1);
      }
    },
    );
}
