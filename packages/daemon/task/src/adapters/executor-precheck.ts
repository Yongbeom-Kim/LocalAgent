import { spawnSync } from 'node:child_process';
import { ExecutorPrecheckResult } from '../ports/task-executor';

export function checkRequiredBinaries(
  executorName: string,
  binaries: readonly string[],
): ExecutorPrecheckResult {
  try {
    const missing = binaries.filter((binary) => {
      const result = spawnSync('sh', ['-lc', `command -v ${binary} >/dev/null 2>&1`], {
        stdio: 'ignore',
      });
      return result.status !== 0;
    });

    if (missing.length === 0) {
      return { ok: true };
    }

    return {
      ok: false,
      stderr: `Executor "${executorName}" unavailable: missing required binaries in PATH: ${missing.join(', ')}`,
    };
  } catch {
    return {
      ok: false,
      stderr: `Executor "${executorName}" unavailable: missing required binaries in PATH: ${binaries.join(', ')}`,
    };
  }
}
