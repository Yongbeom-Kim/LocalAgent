import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test SetupHookRunner with real bash execution in a real temp directory.
// No mocking of child_process — this validates actual script execution.

import { SetupHookRunner } from '../setup-hook-runner';

describe('SetupHookRunner', () => {
  let runner: SetupHookRunner;
  let workDir: string;

  beforeEach(() => {
    runner = new SetupHookRunner();
    workDir = join(tmpdir(), `setup-hook-test-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const ctx = {
    job_id: 'job-abc',
    task_id: 'task-xyz',
    task_type: 'coding',
    payload: 'do something',
  };

  it('runs a bash script with cwd set to workDir', async () => {
    const script = 'touch marker.txt';
    await runner.run(script, workDir, ctx, 10_000);
    expect(existsSync(join(workDir, 'marker.txt'))).toBe(true);
  });

  it('passes LOCALAGENT_* env vars to the script', async () => {
    const script = [
      'echo "$LOCALAGENT_JOB_ID" > job_id.txt',
      'echo "$LOCALAGENT_TASK_ID" > task_id.txt',
      'echo "$LOCALAGENT_TASK_TYPE" > task_type.txt',
    ].join('\n');

    await runner.run(script, workDir, ctx, 10_000);

    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(workDir, 'job_id.txt'), 'utf-8').trim()).toBe('job-abc');
    expect(readFileSync(join(workDir, 'task_id.txt'), 'utf-8').trim()).toBe('task-xyz');
    expect(readFileSync(join(workDir, 'task_type.txt'), 'utf-8').trim()).toBe('coding');
  });

  it('throws when script exits non-zero', async () => {
    const script = 'exit 1';
    await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toThrow(/Setup hook failed/);
  });

  it('includes stderr in the error message when script fails', async () => {
    const script = 'echo "something went wrong" >&2; exit 1';
    await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toThrow(/something went wrong/);
  });

  it('throws on timeout', async () => {
    const script = 'sleep 10';
    await expect(runner.run(script, workDir, ctx, 100)).rejects.toThrow();
  }, 5_000);
});
