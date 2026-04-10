import { TaskResult, buildApiAuthHeaders, createLogger } from '@local-agent/shared';
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

type TaskEventKind = 'result' | 'phase';

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

interface PollPassResult {
  fetchedWork: boolean;
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

  private async pollPass(): Promise<PollPassResult> {
    try {
      const res = await fetch(`${this.apiUrl}/results/next/${this.queueName}`, {
        headers: this.buildApiHeaders(),
      });

      if (res.status === 204) {
        logger.debug('No results available');
        return { fetchedWork: false };
      }

      this.throwIfAuthFailureStatus(res.status, 'GET /results/next/:queue_name', { queue_name: this.queueName });

      if (res.status !== 200) {
        logger.warn({ status: res.status }, 'Unexpected response from API');
        return { fetchedWork: false };
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
          } else if (phaseEvent.context_ref?.platform === 'lark' || (phaseEvent.task_source?.source === 'lark' && phaseEvent.task_source.message_id)) {
            await this.phaseNotifier.notify(phaseEvent);
            this.recordPhase(phaseEvent);
          } else {
            await this.notifier.notifyPhase(phaseEvent as never);
          }
        } catch (err) {
          logger.warn(
            { event_id: phaseEvent.event_id, task_id: phaseEvent.task_id, phase: phaseEvent.phase, err },
            'Phase event dispatch failed',
          );
        } finally {
          await this.ackDelivery(event.id);
        }
        return { fetchedWork: true };
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
      return { fetchedWork: true };
    } catch (err) {
      if (err instanceof ApiAuthConfigurationError) {
        logger.error({ err }, 'Stopping lark poll due to API auth configuration error');
        this.stop();
        return { fetchedWork: false };
      }

      logger.error({ err }, 'Lark poll error');
      return { fetchedWork: false };
    }
  }

  async pollOnce(): Promise<void> {
    await this.pollPass();
  }

  async runBurstCycle(): Promise<void> {
    while (this.running) {
      const { fetchedWork } = await this.pollPass();
      if (!fetchedWork) {
        break;
      }
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
    return (candidate.event_kind === 'phase' || candidate.event_kind === 'result') && 'event' in candidate;
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

  private async ackDelivery(id: string): Promise<void> {
    try {
      const ackRes = await fetch(`${this.apiUrl}/results/${this.queueName}/${id}/ack`, {
        method: 'POST',
        headers: this.buildApiHeaders(),
      });
      this.throwIfAuthFailureStatus(ackRes.status, 'POST /results/:queue_name/:id/ack', {
        id,
        queue_name: this.queueName,
      });
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
      await this.runBurstCycle();
      if (this.running) {
        this.timer = setTimeout(loop, intervalMs);
      }
    };
    void loop();
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

  private shouldIgnorePhaseEvent(event: TaskPhaseEventLike): boolean {
    if (!event.task_id || !isLarkTaskPhase(event.phase)) {
      return false;
    }

    this.prunePhaseGuard();

    const previous = this.phaseGuard.get(this.buildPhaseGuardKey(event));
    if (!previous) {
      return false;
    }

    return compareLarkTaskPhases(event.phase, previous.phase) < 0;
  }

  private recordPhase(event: TaskPhaseEventLike): void {
    if (!event.task_id || !isLarkTaskPhase(event.phase)) {
      return;
    }

    this.prunePhaseGuard();
    this.phaseGuard.set(this.buildPhaseGuardKey(event), {
      phase: event.phase,
      updatedAtMs: Date.now(),
    });
  }

  private buildPhaseGuardKey(event: TaskPhaseEventLike): string {
    if (event.context_ref?.platform === 'lark') {
      return `${event.task_id}:context:${event.context_ref.root_key}`;
    }

    if (event.task_source?.source === 'lark' && event.task_source.message_id) {
      return `${event.task_id}:message:${event.task_source.message_id}`;
    }

    return `${event.task_id}:session:${event.session_id ?? 'unknown'}`;
  }

  private prunePhaseGuard(): void {
    const now = Date.now();
    for (const [key, state] of this.phaseGuard.entries()) {
      if (now - state.updatedAtMs > PHASE_GUARD_TTL_MS) {
        this.phaseGuard.delete(key);
      }
    }
  }
}
