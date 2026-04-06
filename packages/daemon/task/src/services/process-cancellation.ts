import { type ChildProcess } from 'node:child_process';
import { DEFAULT_KILL_CANCELLATION_GRACE_TIMEOUT_MS } from '@local-agent/shared';
import { TaskExecutionHooks } from '../ports/task-executor';

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the child itself when process-group signalling is unavailable.
    }
  }

  child.kill(signal);
}

export function attachProcessCancellation(
  child: ChildProcess,
  hooks?: TaskExecutionHooks,
  graceTimeoutMs: number = DEFAULT_KILL_CANCELLATION_GRACE_TIMEOUT_MS,
): void {
  if (!hooks?.runningJob) {
    return;
  }

  let forcedKillTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  hooks.runningJob.attachCancellationHandle({
    cancel: () => {
      if (cancelled) {
        return;
      }

      cancelled = true;
      sendSignal(child, 'SIGTERM');
      forcedKillTimer = setTimeout(() => {
        forcedKillTimer = null;
        sendSignal(child, 'SIGKILL');
      }, graceTimeoutMs);
    },
  });

  child.once('close', () => {
    if (forcedKillTimer) {
      clearTimeout(forcedKillTimer);
      forcedKillTimer = null;
    }
  });
}
