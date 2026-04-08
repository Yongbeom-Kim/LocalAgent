import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCrontabAndSnapshot } from '../cron-renderer';
import type { SchedulerScheduleConfig } from '../schedule-config';

function makeArtifactsDir(): string {
  return mkdtempSync(join(tmpdir(), 'scheduler-render-test-'));
}

describe('renderCrontabAndSnapshot', () => {
  it('renders one cron line per schedule using named run commands in deterministic order', () => {
    const artifactsDir = makeArtifactsDir();
    const crontabPath = join(artifactsDir, 'scheduler.crontab');
    const snapshotPath = join(artifactsDir, 'config.snapshot.json');

    const config: SchedulerScheduleConfig = {
      schedules: [
        {
          name: 'alpha',
          cron: '0 6 * * *',
          task: {
            task_type: 'generic',
            executor: 'claude',
            executor_model: 'sonnet',
            payload: 'first payload',
          },
        },
        {
          name: 'zeta',
          cron: '15 9 * * 1-5',
          task: {
            task_type: 'generic',
            executor: 'claude',
            executor_model: 'sonnet',
            payload: 'second payload',
          },
        },
      ],
    };

    renderCrontabAndSnapshot({ scheduleConfig: config, crontabPath, configSnapshotPath: snapshotPath });

    const crontab = readFileSync(crontabPath, 'utf8');
    expect(crontab).toContain('0 6 * * * node dist/index.js run alpha');
    expect(crontab).toContain('15 9 * * 1-5 node dist/index.js run zeta');
    expect(crontab.indexOf('run alpha')).toBeLessThan(crontab.indexOf('run zeta'));
  });

  it('supports custom dist entry path in rendered crontab commands', () => {
    const artifactsDir = makeArtifactsDir();
    const crontabPath = join(artifactsDir, 'scheduler.crontab');
    const snapshotPath = join(artifactsDir, 'config.snapshot.json');

    const config: SchedulerScheduleConfig = {
      schedules: [
        {
          name: 'nightly',
          cron: '0 2 * * *',
          task: {
            task_type: 'generic',
            executor: 'claude',
            executor_model: 'sonnet',
            payload: 'nightly payload',
          },
        },
      ],
    };

    renderCrontabAndSnapshot({
      scheduleConfig: config,
      crontabPath,
      configSnapshotPath: snapshotPath,
      distEntryPath: '/app/packages/daemon/task-scheduler/dist/index.js',
    });

    const crontab = readFileSync(crontabPath, 'utf8');
    expect(crontab).toContain('0 2 * * * node /app/packages/daemon/task-scheduler/dist/index.js run nightly');
  });

  it('writes snapshot JSON and does not inline payload/auth boilerplate in crontab', () => {
    const artifactsDir = makeArtifactsDir();
    const crontabPath = join(artifactsDir, 'scheduler.crontab');
    const snapshotPath = join(artifactsDir, 'config.snapshot.json');

    const config: SchedulerScheduleConfig = {
      schedules: [
        {
          name: 'daily',
          cron: '*/5 * * * *',
          task: {
            task_type: 'generic',
            executor: 'claude',
            executor_model: 'sonnet',
            payload: 'payload with secret-like content',
          },
        },
      ],
    };

    renderCrontabAndSnapshot({ scheduleConfig: config, crontabPath, configSnapshotPath: snapshotPath });

    const crontab = readFileSync(crontabPath, 'utf8');
    expect(crontab).toContain('node dist/index.js run daily');
    expect(crontab).not.toContain('payload with secret-like content');
    expect(crontab).not.toContain('Authorization');
    expect(crontab).not.toContain('curl');

    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SchedulerScheduleConfig;
    expect(snapshot.schedules).toHaveLength(1);
    expect(snapshot.schedules[0]?.name).toBe('daily');
  });
});
