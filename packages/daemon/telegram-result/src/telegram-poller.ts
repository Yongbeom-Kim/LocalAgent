import { TaskResult, buildApiAuthHeaders, createLogger } from '@local-agent/shared';
import { TelegramNotifier } from './adapters/telegram-notifier';

const logger = createLogger('telegram-daemon:poller');
const API_AUTH_FAILURE_LOG = 'API authentication failed; check API_AUTH_TOKEN or API_AUTH_DISABLED';

class ApiAuthConfigurationError extends Error {}

type TaskEventKind = 'result' | 'phase';

interface TaskEventEnvelope {
  event_kind: TaskEventKind;
  event: unknown;
}

interface TaskEventEnvelopeLegacy {
  event_kind: TaskEventKind;
}

export class TelegramPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly apiUrl: string,
    private readonly queueName: string,
    private readonly notifier: TelegramNotifier,
    private readonly apiAuthToken?: string,
  ) {}

  private buildApiHeaders(): Record<string, string> {
    return {
      ...buildApiAuthHeaders(this.apiAuthToken),
    };
  }

  private isAuthFailureStatus(status: number): boolean {
    return status === 401 || status === 403;
  }

  private logAuthFailure(context: string, status: number, details?: Record<string, unknown>): void {
    logger.warn(
      {
        ...details,
        status,
        context,
      },
      API_AUTH_FAILURE_LOG,
    );
  }

  private throwIfAuthFailureStatus(status: number, context: string, details?: Record<string, unknown>): void {
    if (!this.isAuthFailureStatus(status)) {
      return;
    }

    this.logAuthFailure(context, status, details);
    throw new ApiAuthConfigurationError(`${context} failed with auth status ${status}`);
  }

  async pollOnce(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/results/next/${this.queueName}`, {
        headers: this.buildApiHeaders(),
      });

      if (res.status === 204) {
        logger.debug('No results available');
        return;
      }

      this.throwIfAuthFailureStatus(res.status, 'GET /results/next/:queue_name', { queue_name: this.queueName });

      if (res.status !== 200) {
        logger.warn({ status: res.status }, 'Unexpected response from API');
        return;
      }

      const payload = await res.json() as unknown;
      const event = this.normalizeEvent(payload);

      if (event.event_kind === 'phase') {
        const phaseEvent = event.event as { event_id?: string; task_id?: string; phase?: string };
        logger.debug(
          { event_id: phaseEvent.event_id, task_id: phaseEvent.task_id, phase: phaseEvent.phase },
          'Ignoring task phase event for telegram delivery',
        );
        await this.ackDelivery(event.id, 'Task event');
        return;
      }

      const result = event.event as TaskResult;
      logger.info({ result_id: result.result_id, job_id: result.job_id, task_id: result.task_id }, 'Received result');

      await this.notifier.notify(result);
      await this.ackDelivery(event.id, 'Result');
    } catch (err) {
      if (err instanceof ApiAuthConfigurationError) {
        logger.error({ err }, 'Stopping telegram poll due to API auth configuration error');
        this.stop();
        return;
      }

      logger.error({ err }, 'Telegram poll error');
    }
  }

  private normalizeEvent(payload: unknown): { event_kind: TaskEventKind; event: unknown; id: string } {
    if (this.isTaskEventEnvelope(payload)) {
      const envelope = payload as TaskEventEnvelope;
      return {
        event_kind: envelope.event_kind,
        event: envelope.event,
        id: this.getEventId(envelope.event_kind, envelope.event),
      };
    }

    if (this.isTaskEventEnvelopeLegacy(payload)) {
      const envelope = payload as TaskEventEnvelopeLegacy;
      return {
        event_kind: envelope.event_kind,
        event: payload,
        id: this.getEventId(envelope.event_kind, payload),
      };
    }

    const result = payload as TaskResult;
    return {
      event_kind: 'result',
      event: result,
      id: result.result_id,
    };
  }

  private getEventId(eventKind: TaskEventKind, event: unknown): string {
    if (eventKind === 'phase') {
      const value = event as { event?: { event_id?: string }; event_id?: string };
      if (value.event?.event_id) {
        return value.event.event_id;
      }
      return value.event_id ?? `phase-${Date.now()}`;
    }

    const value = event as { event?: { result_id?: string }; result_id?: string };
    if (value.event?.result_id) {
      return value.event.result_id;
    }
    return value.result_id ?? `result-${Date.now()}`;
  }

  private isTaskEventEnvelope(payload: unknown): payload is TaskEventEnvelope {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }

    const candidate = payload as Record<string, unknown>;
    return (
      (candidate.event_kind === 'phase' || candidate.event_kind === 'result') &&
      'event' in candidate
    );
  }

  private isTaskEventEnvelopeLegacy(payload: unknown): payload is TaskEventEnvelopeLegacy {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }

    const candidate = payload as Record<string, unknown>;
    if (candidate.event_kind !== 'phase' && candidate.event_kind !== 'result') {
      return false;
    }

    return !('event' in candidate);
  }

  private async ackDelivery(id: string, label: 'Result' | 'Task event'): Promise<void> {
    try {
      const ackRes = await fetch(`${this.apiUrl}/results/${this.queueName}/${id}/ack`, {
        method: 'POST',
        headers: this.buildApiHeaders(),
      });
      this.throwIfAuthFailureStatus(ackRes.status, 'POST /results/:queue_name/:id/ack', {
        queue_name: this.queueName,
        id,
      });
      if (ackRes.status !== 200) {
        logger.warn({ id, status: ackRes.status }, `${label} ACK failed`);
      } else {
        logger.info({ id }, `${label} acknowledged`);
      }
    } catch (ackErr) {
      if (ackErr instanceof ApiAuthConfigurationError) {
        throw ackErr;
      }

      logger.error({ id, err: ackErr }, `${label} ACK request failed`);
      throw ackErr;
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs, queueName: this.queueName }, 'Starting telegram poller');
    this.running = true;
    const loop = async () => {
      await this.pollOnce();
      if (this.running) {
        this.timer = setTimeout(loop, intervalMs);
      }
    };
    loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      logger.info('Telegram poller stopped');
    }
  }
}
