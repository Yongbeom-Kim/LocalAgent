import { readFileSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { buildApiAuthHeaders } from '@local-agent/shared';
import type { SchedulerScheduleConfig } from './schedule-config';

export interface SchedulerSubmitConfig {
  apiUrl: string;
  apiAuthEnabled: boolean;
  apiAuthToken?: string;
  configSnapshotPath: string;
}

function loadSnapshot(configSnapshotPath: string): SchedulerScheduleConfig {
  const raw = readFileSync(configSnapshotPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { schedules?: unknown }).schedules)) {
    throw new Error('snapshot file is invalid');
  }

  return parsed as SchedulerScheduleConfig;
}

export async function submitScheduleByName(config: SchedulerSubmitConfig, scheduleName: string): Promise<void> {
  const snapshot = loadSnapshot(config.configSnapshotPath);
  const schedule = snapshot.schedules.find((item) => item.name === scheduleName);

  if (!schedule) {
    throw new Error(`schedule ${scheduleName} not found in snapshot`);
  }

  const sessionId = uuidv4();
  const headers = {
    'Content-Type': 'application/json',
    ...(config.apiAuthEnabled ? buildApiAuthHeaders(config.apiAuthToken) : {}),
  };

  const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}/tasks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      task_type: schedule.task.task_type,
      executor: schedule.task.executor,
      executor_model: schedule.task.executor_model,
      payload: schedule.task.payload,
      session_id: sessionId,
      session: {
        fallbackSeedText: schedule.task.payload,
        fallbackOrigin: 'scheduler',
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`failed to submit scheduled task ${scheduleName}: ${response.status} ${response.statusText} ${body}`.trim());
  }
}
