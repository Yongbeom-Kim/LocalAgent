import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMergedScheduleConfig } from '../schedule-config';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'scheduler-config-test-'));
}

function writeYaml(dir: string, name: string, contents: string): void {
  writeFileSync(join(dir, name), contents);
}

describe('loadMergedScheduleConfig', () => {
  it('merges .yaml and .yml files and returns deterministic ordering', () => {
    const dir = makeDir();
    writeYaml(
      dir,
      'second.yml',
      `schedules:\n  zeta:\n    cron: "15 9 * * 1-5"\n    task:\n      task_type: generic\n      executor: claude\n      executor_model: sonnet\n      payload: "z"\n`,
    );
    writeYaml(
      dir,
      'first.yaml',
      `schedules:\n  alpha:\n    cron: "0 6 * * *"\n    task:\n      task_type: generic\n      executor: claude\n      executor_model: sonnet\n      payload: "a"\n`,
    );

    const config = loadMergedScheduleConfig(dir);

    expect(config.schedules.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);
  });

  it('rejects duplicate schedule names across files', () => {
    const dir = makeDir();
    writeYaml(
      dir,
      'a.yaml',
      `schedules:\n  daily:\n    cron: "0 8 * * *"\n    task:\n      task_type: generic\n      executor: claude\n      executor_model: sonnet\n      payload: "one"\n`,
    );
    writeYaml(
      dir,
      'b.yaml',
      `schedules:\n  daily:\n    cron: "0 9 * * *"\n    task:\n      task_type: generic\n      executor: claude\n      executor_model: sonnet\n      payload: "two"\n`,
    );

    expect(() => loadMergedScheduleConfig(dir)).toThrow(/duplicate schedule name/i);
  });

  it('rejects missing required task fields', () => {
    const dir = makeDir();
    writeYaml(
      dir,
      'missing.yaml',
      `schedules:\n  bad:\n    cron: "0 10 * * *"\n    task:\n      task_type: generic\n      executor: claude\n      payload: "missing model"\n`,
    );

    expect(() => loadMergedScheduleConfig(dir)).toThrow(/executor_model/i);
  });

  it('rejects task_source and destination/thread/topic identifiers', () => {
    const dir = makeDir();
    writeYaml(
      dir,
      'invalid.yaml',
      `schedules:\n  bad:\n    cron: "0 11 * * *"\n    task:\n      task_type: generic\n      executor: claude\n      executor_model: sonnet\n      payload: "x"\n      task_source:\n        source: lark\n        message_id: "123"\n`,
    );

    expect(() => loadMergedScheduleConfig(dir)).toThrow(/task_source/i);

    const dir2 = makeDir();
    writeYaml(
      dir2,
      'invalid2.yaml',
      `schedules:\n  bad:\n    cron: "0 11 * * *"\n    task:\n      task_type: generic\n      executor: claude\n      executor_model: sonnet\n      payload: "x"\n      topic_id: "42"\n`,
    );

    expect(() => loadMergedScheduleConfig(dir2)).toThrow(/topic_id/i);
  });

  it('rejects invalid cron expressions and accepts raw cron strings', () => {
    const bad = makeDir();
    writeYaml(
      bad,
      'bad.yaml',
      `schedules:\n  invalid:\n    cron: "not-a-cron"\n    task:\n      task_type: generic\n      executor: claude\n      executor_model: sonnet\n      payload: "x"\n`,
    );

    expect(() => loadMergedScheduleConfig(bad)).toThrow(/cron/i);

    const good = makeDir();
    writeYaml(
      good,
      'good.yaml',
      `schedules:\n  valid:\n    cron: "*/5 * * * *"\n    task:\n      task_type: generic\n      executor: claude\n      executor_model: sonnet\n      payload: "x"\n`,
    );

    const config = loadMergedScheduleConfig(good);
    expect(config.schedules[0]?.cron).toBe('*/5 * * * *');
  });

  it('supports nested config directories', () => {
    const dir = makeDir();
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    writeYaml(
      nested,
      'weekly.yaml',
      `schedules:\n  weekly:\n    cron: "0 7 * * 1"\n    task:\n      task_type: generic\n      executor: claude\n      executor_model: sonnet\n      payload: "weekly"\n`,
    );

    const config = loadMergedScheduleConfig(dir);
    expect(config.schedules.map((entry) => entry.name)).toEqual(['weekly']);
  });
});
