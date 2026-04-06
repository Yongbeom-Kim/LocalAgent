import { MirrorTaskEvent, TaskResult, buildApiAuthHeaders, createLogger } from '@local-agent/shared';
import { LarkPhaseNotifier, type TaskPhaseEventLike } from './adapters/lark-phase-notifier';
import { LarkNotifier } from './adapters/lark-notifier';
import {
  compareLarkTaskPhases,
  isLarkTaskPhase,
  type LarkTaskPhase,
} from './phase-reaction-mapper';

const logger = createLogger('lark-daemon:poller');
const PHASE_GUARD_TTL_MS = 10 * 60 * 1000;
const API_AUTH_FAILURE_LOG = 'API authentication failed; check API_AUTH_TOKEN or API_AUTH_DISABLED';

class ApiAuthConfigurationError extends Error {}

type TaskEventKind = 'result' | 'phase' | 'mirror';

interface TaskEventEnvelope {
  event_kind: TaskEventKind;
  event: unknown;
}

interface TaskEventEnvelopeLegacy {
  event_kind: TaskEventKind;
}

interface PhaseGuardState {
  phase: LarkTaskPhase;
  updatedAtMs: number;
}

export class LarkPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly phaseGuard = new Map<string, PhaseGuardState>();

  constructor(
    private readonly apiUrl: string,
    private readonly queueName: string,
    private readonly notifier: LarkNotifier,
    private readonly phaseNotifier: LarkPhaseNotifier,
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
        const phaseEvent = event.event as TaskPhaseEventLike;
        try {
          if (this.shouldIgnorePhaseEvent(phaseEvent)) {
            logger.info(
              {
                event_id: phaseEvent.event_id,
                task_id: phaseEvent.task_id,
                phase: phaseEvent.phase,
                message_id: phaseEvent.task_source?.message_id,
              },
              'Ignoring regressive phase event',
            );
          } else {
            await this.phaseNotifier.notify(phaseEvent);
            this.recordPhase(phaseEvent);
          }
        } catch (err) {
          logger.warn(
            { event_id: phaseEvent.event_id, task_id: phaseEvent.task_id, phase: phaseEvent.phase, err },
            'Phase event dispatch failed',
          );
        } finally {
          await this.ackDelivery(event.id);
        }
        return;
      }

      if (event.event_kind === 'mirror') {
        const mirrorEvent = event.event as MirrorTaskEvent;

        try {
          if (mirrorEvent.task_source.source !== 'lark') {
            await this.notifier.notifyMirror(mirrorEvent);
          }
        } catch (err) {
          logger.warn({ mirror_id: mirrorEvent.mirror_id, err }, 'Mirror event dispatch failed');
        } finally {
          await this.ackDelivery(event.id);
        }

        return;
      }

      const result = event.event as TaskResult;
      try {
        logger.info({ result_id: result.result_id, job_id: result.job_id, task_id: result.task_id }, 'Received result');
        await this.notifier.notify(result);
      } catch (err) {
        logger.warn({ result_id: result.result_id, err }, 'Result event dispatch failed');
      } finally {
        await this.ackDelivery(event.id);
      }
      return;
    } catch (err) {
      if (err instanceof ApiAuthConfigurationError) {
        logger.error({ err }, 'Stopping lark poll due to API auth configuration error');
        this.stop();
        return;
      }

      logger.error({ err }, 'Lark poll error');
    }
  }

  private normalizeEvent(payload: unknown): { event_kind: TaskEventKind; event: unknown; id: string } {
    if (this.isTaskEventEnvelope(payload)) {
      const envelope = payload as TaskEventEnvelope;
      const id = this.getEventId(envelope.event_kind, envelope.event);
      return {
        event_kind: envelope.event_kind,
        event: envelope.event,
        id,
      };
    }

    if (this.isTaskEventEnvelopeLegacy(payload)) {
      const envelope = payload as TaskEventEnvelopeLegacy;
      const id = this.getEventId(envelope.event_kind, payload);
      return {
        event_kind: envelope.event_kind,
        event: payload,
        id,
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

  private shouldIgnorePhaseEvent(event: TaskPhaseEventLike): boolean {
    if (!isLarkTaskPhase(event.phase)) {
      return false;
    }
    if (event.task_source?.source !== 'lark' || !event.task_source.message_id) {
      return false;
    }

    const messageId = event.task_source.message_id;
    this.prunePhaseGuard();

    const previous = this.phaseGuard.get(messageId);
    if (!previous) {
      return false;
    }

    return compareLarkTaskPhases(event.phase, previous.phase) < 0;
  }

  private recordPhase(event: TaskPhaseEventLike): void {
    if (!isLarkTaskPhase(event.phase)) {
      return;
    }
    if (event.task_source?.source !== 'lark' || !event.task_source.message_id) {
      return;
    }

    this.prunePhaseGuard();
    this.phaseGuard.set(event.task_source.message_id, {
      phase: event.phase,
      updatedAtMs: Date.now(),
    });
  }

  private prunePhaseGuard(): void {
    const now = Date.now();
    for (const [messageId, state] of this.phaseGuard.entries()) {
      if (now - state.updatedAtMs > PHASE_GUARD_TTL_MS) {
        this.phaseGuard.delete(messageId);
      }
    }
  }

  private async ackDelivery(id: string): Promise<void> {
    try {
      const ackRes = await fetch(`${this.apiUrl}/results/${this.queueName}/${id}/ack`, {
        method: 'POST',
        headers: this.buildApiHeaders(),
      });
      this.throwIfAuthFailureStatus(ackRes.status, 'POST /results/:queue_name/:id/ack', { id, queue_name: this.queueName });
      if (ackRes.status !== 200) {
        logger.warn({ id, status: ackRes.status }, 'Task event ACK failed');
      } else {
        logger.info({ id }, 'Task event acknowledged');
      }
    } catch (ackErr) {
      logger.error({ id, err: ackErr }, 'Task event ACK request failed');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs, queueName: this.queueName }, 'Starting lark poller');
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
    this.phaseGuard.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      logger.info('Lark poller stopped');
    }
  }
}
