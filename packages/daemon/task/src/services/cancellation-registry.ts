export const CANCELLED_BY_KILL_MESSAGE = 'Cancelled by /kill';

export interface ExecutorCancellationHandle {
  cancel: () => void;
}

export interface RunningJobRegistration {
  attachCancellationHandle: (handle: ExecutorCancellationHandle) => void;
  clear: () => void;
  isCancellationRequested: () => boolean;
  hasCancellationHandle: () => boolean;
}

export type CancellationRequestOutcome =
  | { kind: 'not_running' }
  | { kind: 'already_requested'; jobId: string }
  | { kind: 'requested'; jobId: string };

interface RunningJobEntry {
  jobId: string;
  cancellationRequested: boolean;
  cancellationHandle: ExecutorCancellationHandle | null;
}

export class CancellationRegistry {
  private readonly entries = new Map<string, RunningJobEntry>();

  register(sessionId: string, jobId: string): RunningJobRegistration {
    const entry: RunningJobEntry = {
      jobId,
      cancellationRequested: false,
      cancellationHandle: null,
    };
    this.entries.set(sessionId, entry);

    return {
      attachCancellationHandle: (handle) => {
        const current = this.entries.get(sessionId);
        if (!current || current !== entry) {
          return;
        }

        current.cancellationHandle = handle;
        if (current.cancellationRequested) {
          current.cancellationHandle.cancel();
        }
      },
      clear: () => {
        const current = this.entries.get(sessionId);
        if (current === entry) {
          this.entries.delete(sessionId);
        }
      },
      isCancellationRequested: () => {
        const current = this.entries.get(sessionId);
        return current === entry ? current.cancellationRequested : false;
      },
      hasCancellationHandle: () => {
        const current = this.entries.get(sessionId);
        return current === entry && current.cancellationHandle !== null;
      },
    };
  }

  hasRunningJob(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  requestCancellation(sessionId: string): CancellationRequestOutcome {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return { kind: 'not_running' };
    }

    if (entry.cancellationRequested) {
      return { kind: 'already_requested', jobId: entry.jobId };
    }

    entry.cancellationRequested = true;
    entry.cancellationHandle?.cancel();
    return { kind: 'requested', jobId: entry.jobId };
  }
}
