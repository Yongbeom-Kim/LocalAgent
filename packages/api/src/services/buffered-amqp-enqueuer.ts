import amqplib from 'amqplib';

export interface BufferedEnqueueRequest {
  operationName: string;
  publish: (channel: amqplib.Channel) => Promise<boolean> | boolean;
}

interface PendingBufferedEnqueueRequest extends BufferedEnqueueRequest {
  initialAttempt?: {
    settled: boolean;
    resolve: (buffered: boolean) => void;
    reject: (error: unknown) => void;
  };
}

interface BufferedAmqpEnqueuerOptions {
  capacity?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  resolveChannel: () => Promise<amqplib.Channel | null>;
  clearConnectionState: () => void;
  isRetryableError: (error: unknown) => boolean;
  logger: {
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
}

const DEFAULT_BUFFERED_ENQUEUE_CAPACITY = 10_000;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

export class BufferedAmqpEnqueuer {
  private readonly capacity: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private pending: PendingBufferedEnqueueRequest[] = [];
  private flushPromise: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private nextRetryDelayMs: number;
  private closed = false;

  constructor(private readonly options: BufferedAmqpEnqueuerOptions) {
    this.capacity = options.capacity ?? DEFAULT_BUFFERED_ENQUEUE_CAPACITY;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.nextRetryDelayMs = this.initialRetryDelayMs;
  }

  async enqueue(request: BufferedEnqueueRequest): Promise<boolean> {
    if (this.closed) {
      return false;
    }

    if (this.pending.length >= this.capacity) {
      this.options.logger.warn(
        { operationName: request.operationName, pendingCount: this.pending.length, capacity: this.capacity },
        'Buffered AMQP enqueue capacity exceeded',
      );
      return false;
    }

    const pendingRequest = this.createPendingRequest(request);
    this.pending.push(pendingRequest);
    this.requestFlush();

    if (pendingRequest.initialAttempt) {
      return await new Promise<boolean>((resolve, reject) => {
        pendingRequest.initialAttempt = {
          ...pendingRequest.initialAttempt,
          resolve,
          reject,
        };
      });
    }

    return true;
  }

  requestFlush(): void {
    if (this.closed) {
      return;
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (!this.flushPromise) {
      this.flushPromise = this.flushPending().finally(() => {
        this.flushPromise = null;
        if (!this.closed && this.pending.length > 0 && !this.retryTimer) {
          this.scheduleRetry();
        }
      });
    }
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private async flushPending(): Promise<void> {
    while (!this.closed && this.pending.length > 0) {
      const channel = await this.options.resolveChannel();

      if (!channel) {
        this.resolveBufferedPending();
        this.scheduleRetry();
        return;
      }

      const next = this.pending[0];

      try {
        const buffered = await next.publish(channel);
        this.pending.shift();
        this.resolveInitialAttempt(next, buffered);
        this.nextRetryDelayMs = this.initialRetryDelayMs;

        if (!buffered) {
          this.options.logger.warn(
            { operationName: next.operationName, pendingCount: this.pending.length },
            'AMQP channel reported backpressure while flushing buffered publish',
          );
        }
      } catch (err) {
        if (this.options.isRetryableError(err)) {
          this.resolveBufferedPending();
          this.options.clearConnectionState();
          this.scheduleRetry();
          return;
        }

        this.pending.shift();
        this.rejectInitialAttempt(next, err);
        this.options.logger.error(
          { err, operationName: next.operationName, pendingCount: this.pending.length },
          'Dropping buffered AMQP publish after non-retryable error',
        );
      }
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer || this.pending.length === 0) {
      return;
    }

    const delay = this.nextRetryDelayMs;
    this.nextRetryDelayMs = Math.min(this.nextRetryDelayMs * 2, this.maxRetryDelayMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.requestFlush();
    }, delay);
  }

  private createPendingRequest(request: BufferedEnqueueRequest): PendingBufferedEnqueueRequest {
    if (this.pending.length > 0 || this.flushPromise || this.retryTimer) {
      return request;
    }

    return {
      ...request,
      initialAttempt: {
        settled: false,
        resolve: () => undefined,
        reject: () => undefined,
      },
    };
  }

  private resolveInitialAttempt(request: PendingBufferedEnqueueRequest, buffered: boolean): void {
    if (!request.initialAttempt || request.initialAttempt.settled) {
      return;
    }

    request.initialAttempt.settled = true;
    request.initialAttempt.resolve(buffered);
  }

  private rejectInitialAttempt(request: PendingBufferedEnqueueRequest, error: unknown): void {
    if (!request.initialAttempt || request.initialAttempt.settled) {
      return;
    }

    request.initialAttempt.settled = true;
    request.initialAttempt.reject(error);
  }

  private resolveBufferedPending(): void {
    for (const request of this.pending) {
      this.resolveInitialAttempt(request, true);
    }
  }
}
