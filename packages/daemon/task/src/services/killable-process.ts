import { MAX_RESULT_OUTPUT_BYTES, truncate } from '@local-agent/shared';
import { ExecutorKillResult } from '../ports/task-executor';

type KillSignal = 'SIGTERM' | 'SIGKILL';
type CloseHandler = (code: number | null, signal: NodeJS.Signals | null) => void;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface KillableProcessLike {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'close', listener: CloseHandler): this;
}

export interface KillableProcessOptions {
  child: KillableProcessLike;
  graceMs: number;
  getStdout: () => string;
  getStderr: () => string;
  sendSignal?: (pid: number, signal: KillSignal) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

interface CloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function defaultSendSignal(pid: number, signal: KillSignal): void {
  process.kill(pid, signal);
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH';
}

function readOutput(read: () => string): string {
  return truncate(read(), MAX_RESULT_OUTPUT_BYTES);
}

function buildSuccessResult(
  outcome: ExecutorKillResult['outcome'],
  signalPath: ExecutorKillResult['signalPath'],
  waitDurationMs: number,
  closeResult: CloseResult | null,
  getStdout: () => string,
  getStderr: () => string,
): ExecutorKillResult {
  return {
    status: 'success',
    outcome,
    signalPath,
    waitDurationMs,
    exitCode: closeResult?.code ?? null,
    stdout: readOutput(getStdout),
    stderr: readOutput(getStderr),
  };
}

function buildFailureResult(
  message: string,
  waitDurationMs: number,
  getStdout: () => string,
  getStderr: () => string,
): ExecutorKillResult {
  const stderr = readOutput(getStderr);
  return {
    status: 'failure',
    outcome: 'terminated_active_process',
    signalPath: 'none',
    waitDurationMs,
    exitCode: null,
    stdout: readOutput(getStdout),
    stderr: stderr ? `${message}\n${stderr}` : message,
  };
}

function signalProcessTree(
  child: KillableProcessLike,
  signal: KillSignal,
  sendSignal: (pid: number, signal: KillSignal) => void,
): boolean {
  if (process.platform === 'win32' || typeof child.pid !== 'number') {
    return child.kill(signal);
  }

  try {
    sendSignal(-child.pid, signal);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }
    throw error;
  }
}

export async function killProcessTree({
  child,
  graceMs,
  getStdout,
  getStderr,
  sendSignal = defaultSendSignal,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
}: KillableProcessOptions): Promise<ExecutorKillResult> {
  const startedAt = now();
  let closeResult: CloseResult | null = null;

  const closePromise = new Promise<CloseResult>((resolve) => {
    child.once('close', (code, signal) => {
      closeResult = { code, signal };
      resolve(closeResult);
    });
  });

  try {
    const termSent = signalProcessTree(child, 'SIGTERM', sendSignal);
    if (!termSent) {
      return buildSuccessResult('terminated_active_process', 'SIGTERM -> exited', now() - startedAt, closeResult, getStdout, getStderr);
    }

    const closeBeforeTimeout = await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimer(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, graceMs);

      void closePromise.then(() => {
        if (!settled) {
          settled = true;
          clearTimer(timer);
          resolve(true);
        }
      });
    });

    if (closeBeforeTimeout) {
      return buildSuccessResult('terminated_active_process', 'SIGTERM -> exited', now() - startedAt, closeResult, getStdout, getStderr);
    }

    const killSent = signalProcessTree(child, 'SIGKILL', sendSignal);
    if (killSent) {
      await closePromise;
    }

    return buildSuccessResult('terminated_active_process', 'SIGTERM -> SIGKILL', now() - startedAt, closeResult, getStdout, getStderr);
  } catch (error) {
    return buildFailureResult(
      `Failed to terminate process: ${error instanceof Error ? error.message : String(error)}`,
      now() - startedAt,
      getStdout,
      getStderr,
    );
  }
}
