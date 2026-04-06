import {
  buildApiAuthHeaders,
  createLogger,
  resolveApiClientToken,
  type TaskPhaseEventSubmission,
  type TaskSubmission,
  type TaskSource,
} from '@local-agent/shared';
import { DEFAULT_MAX_RETRIES } from '../constants';

const logger = createLogger('lark-listener:submitter');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TaskSubmitter {
  private readonly apiUrl: string;
  private readonly apiAuthToken?: string;

  constructor(apiUrl: string, apiAuthToken?: string) {
    this.apiUrl = apiUrl;
    this.apiAuthToken = resolveApiClientToken({ explicitToken: apiAuthToken, env: process.env });
  }

  /**
   * Submit a task to the API. Returns the task_id on success, null on failure.
   */
  async submit(
    taskType: string,
    payload: string,
    taskSource?: TaskSource,
    executor?: string,
    executorModel?: string,
  ): Promise<string | null> {
    // Listener should avoid routing knobs for normalized inbound messages.
    if (taskType === 'lark_inbound') {
      executor = undefined;
      executorModel = undefined;
    }

    const body: TaskSubmission = {
      task_type: taskType,
      payload,
      ...(executor !== undefined ? { executor } : {}),
      ...(executorModel !== undefined ? { executor_model: executorModel } : {}),
      ...(taskSource ? { task_source: taskSource } : {}),
    };

    for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`${this.apiUrl}/tasks`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...buildApiAuthHeaders(this.apiAuthToken),
          },
          body: JSON.stringify(body),
        });

        if (res.status === 401 || res.status === 403) {
          logger.warn(
            { status: res.status, taskType, attempt },
            'API authentication failed while submitting task; check API_AUTH_TOKEN or API_AUTH_DISABLED',
          );
          return null;
        }

        if (!res.ok) {
          throw new Error(`API returned status ${res.status}`);
        }

        const data = (await res.json()) as { task_id: string };
        logger.info({ task_id: data.task_id }, 'Task submitted');
        return data.task_id;
      } catch (err) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
        logger.warn({ attempt, err, delayMs }, 'Task submission failed, retrying');
        if (attempt < DEFAULT_MAX_RETRIES) {
          await sleep(delayMs);
        }
      }
    }

    logger.error({ payload: payload.substring(0, 100) }, 'Task submission failed after all retries');
    return null;
  }

  async publishPhase(phaseEvent: TaskPhaseEventSubmission): Promise<void> {
    const res = await fetch(`${this.apiUrl}/results`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildApiAuthHeaders(this.apiAuthToken),
      },
      body: JSON.stringify({ event_kind: 'phase', ...phaseEvent }),
    });

    if (res.status === 401 || res.status === 403) {
      logger.warn(
        {
          task_id: phaseEvent.task_id,
          session_id: phaseEvent.session_id,
          status: res.status,
        },
        'API authentication failed while publishing task phase; check API_AUTH_TOKEN or API_AUTH_DISABLED',
      );
      throw new Error(`Phase publish failed with auth status ${res.status}`);
    }

    if (!res.ok) {
      throw new Error(`Phase publish failed with status ${res.status}`);
    }
  }
}
