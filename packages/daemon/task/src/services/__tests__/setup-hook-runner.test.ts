import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_RESULT_OUTPUT_BYTES } from '@local-agent/shared';

// We test SetupHookRunner with real bash execution in a real temp directory.
// No mocking of child_process — this validates actual script execution.

import { SetupHookExecutionError, SetupHookRunner } from '../setup-hook-runner';

describe('SetupHookRunner', () => {
  let runner: SetupHookRunner;
  let workDir: string;

  beforeEach(() => {
    runner = new SetupHookRunner();
    workDir = mkdtempSync(join(tmpdir(), 'setup-hook-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const ctx = {
    job_id: 'job-abc',
    task_id: 'task-xyz',
    task_type: 'coding',
    session_id: 'session-123',
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
      'echo "$LOCALAGENT_SESSION_ID" > session_id.txt',
      'echo "$LOCALAGENT_PAYLOAD" > payload.txt',
    ].join('\n');

    await runner.run(script, workDir, ctx, 10_000);

    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(workDir, 'job_id.txt'), 'utf-8').trim()).toBe('job-abc');
    expect(readFileSync(join(workDir, 'task_id.txt'), 'utf-8').trim()).toBe('task-xyz');
    expect(readFileSync(join(workDir, 'task_type.txt'), 'utf-8').trim()).toBe('coding');
    expect(readFileSync(join(workDir, 'session_id.txt'), 'utf-8').trim()).toBe('session-123');
    expect(readFileSync(join(workDir, 'payload.txt'), 'utf-8').trim()).toBe('do something');
  });

  it('enforces -e', async () => {
    const script = 'false; true';
    await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toThrow(/Setup hook failed/);
  });

  it('enforces -u', async () => {
    const script = 'echo "$THIS_VAR_IS_NOT_SET"';
    await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toThrow(/Setup hook failed/);
  });

  it('enforces pipefail', async () => {
    const script = 'false | true';
    await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toThrow(/Setup hook failed/);
  });

  it('throws a typed error for non-zero exit and captures stderr', async () => {
    const script = 'echo "something went wrong" >&2; exit 2';

    await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toBeInstanceOf(SetupHookExecutionError);
    await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toMatchObject({
      exit_code: 1,
      timedOut: false,
      stdout: '',
      stderr: expect.stringContaining('something went wrong'),
    });
  });

  it('captures stdout and stderr separately when script exits non-zero', async () => {
    const script = 'echo out; echo err >&2; exit 2';

    await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toMatchObject({
      exit_code: 1,
      timedOut: false,
      stdout: expect.stringContaining('out'),
      stderr: expect.stringContaining('err'),
    });
  });

  it('throws a typed error on timeout with actionable stderr', async () => {
    const timeoutMs = 100;
    const script = 'sleep 10';

    await expect(runner.run(script, workDir, ctx, timeoutMs)).rejects.toBeInstanceOf(SetupHookExecutionError);
    await expect(runner.run(script, workDir, ctx, timeoutMs)).rejects.toMatchObject({
      exit_code: 1,
      timedOut: true,
      stderr: expect.any(String),
    });

    // Ensure the synthesized stderr is not empty when the process produced no stderr.
    try {
      await runner.run(script, workDir, ctx, timeoutMs);
      throw new Error('Expected runner.run to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SetupHookExecutionError);
      expect((err as SetupHookExecutionError).stderr.trim().length).toBeGreaterThan(0);
    }
  }, 5_000);

  it('truncates large stdout and stderr to MAX_RESULT_OUTPUT_BYTES', async () => {
    // Large, but well under execFile maxBuffer (10MB) so we validate our truncation, not Node's.
    const size = MAX_RESULT_OUTPUT_BYTES * 2;
    const script = `node -e "process.stdout.write('x'.repeat(${size})); process.stderr.write('y'.repeat(${size})); process.exit(2)"`;

    try {
      await runner.run(script, workDir, ctx, 10_000);
      throw new Error('Expected runner.run to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SetupHookExecutionError);
      const e = err as SetupHookExecutionError;
      expect(Buffer.byteLength(e.stdout, 'utf-8')).toBeLessThanOrEqual(MAX_RESULT_OUTPUT_BYTES);
      expect(Buffer.byteLength(e.stderr, 'utf-8')).toBeLessThanOrEqual(MAX_RESULT_OUTPUT_BYTES);
    }
  });
});
