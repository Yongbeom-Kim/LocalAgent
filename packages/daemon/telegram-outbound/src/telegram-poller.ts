import { type MirrorTaskEvent, TaskResult, createLogger } from '@local-agent/shared';
import { TelegramNotifier } from './adapters/telegram-notifier';

const logger = createLogger('telegram-daemon:poller');

type TaskEventKind = 'result' | 'phase' | 'mirror';

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
  ) {}

  async pollOnce(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/results/next/${this.queueName}`);

      if (res.status === 204) {
        logger.debug('No results available');
        return;
      }

      if (res.status !== 200) {
        logger.warn({ status: res.status }, 'Unexpected response from API');
        return;
      }

      const payload = await res.json() as unknown;
      const event = this.normalizeEvent(payload);

      if (event.event_kind === 'phase') {
        const phaseEvent = event.event as {
          event_id?: string;
          task_id?: string;
          session_id?: string;
          phase?: string;
          task_source?: { source?: string; chat_id?: string; topic_id?: string };
        };

        if (phaseEvent.task_source?.source === 'telegram' && phaseEvent.task_source.chat_id) {
          await this.notifier.notifyStatus({
            chatId: phaseEvent.task_source.chat_id,
            topicId: phaseEvent.task_source.topic_id,
            sessionId: phaseEvent.session_id,
            text: `*Status:* ${phaseEvent.phase ?? 'unknown'}`,
          });
        } else if (phaseEvent.session_id) {
          await this.notifier.notifyStatus({
            sessionId: phaseEvent.session_id,
            text: `*Status:* ${phaseEvent.phase ?? 'unknown'}`,
          });
        }

        await this.ackDelivery(event.id, 'Task event');
        return;
      }

      if (event.event_kind === 'mirror') {
        const mirrorEvent = event.event as MirrorTaskEvent;
        if (mirrorEvent.task_source.source !== 'telegram') {
          await this.notifier.notifyMirror(mirrorEvent);
        }
        await this.ackDelivery(event.id, 'Task event');
        return;
      }

      const result = event.event as TaskResult;
      logger.info({ result_id: result.result_id, job_id: result.job_id, task_id: result.task_id }, 'Received result');

      if (result.task_source?.source === 'telegram') {
        await this.notifier.notifyResult({
          chatId: result.task_source.chat_id,
          topicId: 'topic_id' in result.task_source ? result.task_source.topic_id : undefined,
          result,
        });
      } else if (result.session_id) {
        await this.notifier.notifyResult({ result });
      } else {
        await this.notifier.notify(result);
      }
      await this.ackDelivery(event.id, 'Result');
    } catch (err) {
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

    if (eventKind === 'mirror') {
      const value = event as { event?: { mirror_id?: string }; mirror_id?: string };
      if (value.event?.mirror_id) {
        return value.event.mirror_id;
      }
      return value.mirror_id ?? `mirror-${Date.now()}`;
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
      (candidate.event_kind === 'phase' || candidate.event_kind === 'result' || candidate.event_kind === 'mirror') &&
      'event' in candidate
    );
  }

  private isTaskEventEnvelopeLegacy(payload: unknown): payload is TaskEventEnvelopeLegacy {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }

    const candidate = payload as Record<string, unknown>;
    if (candidate.event_kind !== 'phase' && candidate.event_kind !== 'result' && candidate.event_kind !== 'mirror') {
      return false;
    }

    return !('event' in candidate);
  }

  private async ackDelivery(id: string, label: 'Result' | 'Task event'): Promise<void> {
    try {
      const ackRes = await fetch(`${this.apiUrl}/results/${this.queueName}/${id}/ack`, {
        method: 'POST',
      });
      if (ackRes.status !== 200) {
        logger.warn({ id, status: ackRes.status }, `${label} ACK failed`);
      } else {
        logger.info({ id }, `${label} acknowledged`);
      }
    } catch (ackErr) {
      logger.error({ id, err: ackErr }, `${label} ACK request failed`);
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
