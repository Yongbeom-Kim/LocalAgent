import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SchedulerScheduleConfig } from './schedule-config';

export interface RenderCrontabParams {
  scheduleConfig: SchedulerScheduleConfig;
  crontabPath: string;
  configSnapshotPath: string;
  distEntryPath?: string;
}

export function renderCrontabAndSnapshot(params: RenderCrontabParams): void {
  const sortedSchedules = [...params.scheduleConfig.schedules].sort((a, b) => a.name.localeCompare(b.name));
  const distEntryPath = params.distEntryPath ?? 'dist/index.js';

  mkdirSync(dirname(params.crontabPath), { recursive: true });
  mkdirSync(dirname(params.configSnapshotPath), { recursive: true });

  const crontabLines = sortedSchedules.map((schedule) => `${schedule.cron} node ${distEntryPath} run ${schedule.name}`);
  writeFileSync(params.crontabPath, `${crontabLines.join('\n')}\n`);

  writeFileSync(
    params.configSnapshotPath,
    `${JSON.stringify({ schedules: sortedSchedules }, null, 2)}\n`,
  );
}
