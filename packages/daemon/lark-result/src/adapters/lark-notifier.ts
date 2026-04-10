import {
  SessionPlatformLinkRepository,
  SessionRepository,
  TaskResult,
  createLogger,
  LarkHistoryRepository,
  type RecordOutboundLarkMessageParams,
  type TaskPhaseEvent,
} from '@local-agent/shared';
import { DEFAULT_LARK_MAX_RETRIES } from '../constants';
import {
  clearBotOwnedPhaseReactions,
  LarkTenantTokenProvider,
  type TokenProvider,
} from './lark-phase-notifier';
import { getPhaseReactionTypes } from '../phase-reaction-mapper';

const logger = createLogger('lark-daemon:notifier');

const LARK_MESSAGE_URL = 'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id';
const LARK_REPLY_URL = (messageId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reply`;
const MAX_RETRIES = DEFAULT_LARK_MAX_RETRIES;
const NEW_INSTANCE_MARKER = 'New session instance started.';
const LARK_PLATFORM = 'lark';
const CLAIM_TTL_MS = 60_000;

type LarkHistoryRepositoryLike = Pick<
  LarkHistoryRepository,
  | 'recordOutboundLarkMessage'
  | 'markLarkThreadNewInstance'
  | 'getLarkThreadByRootMessageId'
  | 'upsertLarkThreadState'
  | 'deleteLarkRowsBySessionId'
  | 'deleteLarkRowsBySessionIds'
>;

type SessionRepositoryLike = Pick<
  SessionRepository,
  'getSessionById' | 'markSessionEnded' | 'deleteSessionById' | 'listDescendantSessionIds' | 'deleteSessionsByIds'
>;

type SessionPlatformLinkRepositoryLike = Pick<
  SessionPlatformLinkRepository,
  | 'getActiveLinkBySessionAndPlatform'
  | 'claimPendingLink'
  | 'activateClaimedLink'
  | 'releaseExpiredOrFailedClaim'
  | 'deleteLinksBySessionId'
  | 'getLinkBySessionIdAndPlatform'
  | 'deleteLinksBySessionIds'
>;

interface LarkThreadDestination {
  rootMessageId: string;
  threadId: string | null;
  sessionId: string;
  source: string;
  chatType: string | null;
  taskType: string;
  executor: string;
  executorModel: string;
  createdAtMs: number;
}

export class LarkNotifier {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly recipientId: string,
    private readonly larkHistoryRepository?: LarkHistoryRepositoryLike,
    private readonly tokenProvider: TokenProvider = new LarkTenantTokenProvider(appId, appSecret),
    private readonly sessionRepository?: SessionRepositoryLike,
    private readonly sessionPlatformLinkRepository?: SessionPlatformLinkRepositoryLike,
  ) {}

  async notify(result: TaskResult): Promise<void> {
    if (!result.session_id) {
      return;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.sendResultNotification(result);
        return;
      } catch (err) {
        logger.warn({ result_id: result.result_id, attempt, err }, 'Lark notification attempt failed');
        if (attempt === MAX_RETRIES) {
          logger.error(
            { result_id: result.result_id },
            `Lark notification failed after ${MAX_RETRIES} attempts; giving up`,
          );
        }
      }
    }
  }

  async notifyPhase(event: TaskPhaseEvent): Promise<void> {
    if (!event.session_id) {
      return;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.sendPhaseNotification(event);
        return;
      } catch (err) {
        logger.warn({ event_id: event.event_id, attempt, err }, 'Lark phase notification attempt failed');
        if (attempt === MAX_RETRIES) {
          logger.error(
            { event_id: event.event_id },
            `Lark phase notification failed after ${MAX_RETRIES} attempts; giving up`,
          );
        }
      }
    }
  }

  private async sendResultNotification(result: TaskResult): Promise<void> {
    const destination = await this.resolveOrCreateFallbackThread({
      sessionId: result.session_id,
      taskType: result.task_type,
      executor: result.executor,
      executorModel: result.executor_model,
    });
    if (!destination) {
      return;
    }

    const token = await this.tokenProvider.getTenantAccessToken();
    const text = this.buildResultText(result);
    await this.clearBotOwnedPhaseReactionsBeforeReply(destination.rootMessageId, token);

    const createdAtMs = Date.now();
    const msgRes = await this.replyInThread(destination.rootMessageId, text, token);
    await this.persistThreadReply({
      destination,
      sessionId: result.session_id,
      taskType: result.task_type,
      executor: result.executor,
      executorModel: result.executor_model,
      text,
      messageId: msgRes.data?.message_id ?? this.buildSyntheticOutboundMessageId(result.result_id),
      metadataJson: JSON.stringify({ event_kind: this.getOutboundEventKind(result), result_id: result.result_id }),
      createdAtMs,
      status: result.task_type === 'cleanup' ? 'ended' : 'active',
    });

    if (result.task_type === 'cleanup') {
      const cleanupRootSessionId = await this.resolveCleanupRootSessionId(result.session_id, destination.rootMessageId);
      await this.cleanupTerminalSessionRows(cleanupRootSessionId, createdAtMs);
    }

    if (
      this.isNewInstanceReply(result) &&
      result.executor &&
      result.executor_model &&
      this.larkHistoryRepository
    ) {
      await this.larkHistoryRepository.markLarkThreadNewInstance({
        sessionId: result.session_id,
        executor: result.executor,
        executorModel: result.executor_model,
        updatedAtMs: Date.now(),
      });
    }
  }

  private async sendPhaseNotification(event: TaskPhaseEvent): Promise<void> {
    const destination = await this.resolveOrCreateFallbackThread({
      sessionId: event.session_id,
      taskType: event.task_type,
      executor: event.executor,
      executorModel: event.executor_model,
    });
    if (!destination) {
      return;
    }

    const token = await this.tokenProvider.getTenantAccessToken();
    const text = `Status: ${event.phase}`;
    const msgRes = await this.replyInThread(destination.rootMessageId, text, token);
    await this.persistThreadReply({
      destination,
      sessionId: event.session_id,
      taskType: event.task_type,
      executor: event.executor,
      executorModel: event.executor_model,
      text,
      messageId: msgRes.data?.message_id ?? this.buildSyntheticOutboundMessageId(event.event_id),
      metadataJson: JSON.stringify({ event_kind: 'phase', event_id: event.event_id, phase: event.phase }),
      createdAtMs: Date.now(),
      status: 'active',
    });
  }

  private buildResultText(result: TaskResult): string {
    return [
      ...(result.executor && result.executor_model
        ? [`executor: ${result.executor}`, `model: ${result.executor_model}`]
        : []),
      `task_type: ${result.task_type}`,
      `session_id: ${result.session_id}`,
      `Task ID: ${result.task_id}`,
      `Job ID: ${result.job_id}`,
      `status: ${result.status}`,
      `Exit code: ${result.exit_code ?? 'N/A'}`,
      result.stdout ? `Output:\n${result.stdout}` : 'No output',
    ].join('\n');
  }

  private async sendDirectMessage(text: string, token: string): Promise<{ code: number; data?: { message_id?: string } }> {
    const msgRes = await fetch(LARK_MESSAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: this.recipientId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });

    const msgData = (await msgRes.json()) as { code: number; data?: { message_id?: string } };
    if (msgData.code !== 0) {
      throw new Error(`Lark message send failed with code ${msgData.code}`);
    }

    return msgData;
  }

  private async replyInThread(messageId: string, text: string, token: string): Promise<{ code: number; data?: { message_id?: string } }> {
    const msgRes = await fetch(LARK_REPLY_URL(messageId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        msg_type: 'text',
        content: JSON.stringify({ text }),
        reply_in_thread: true,
      }),
    });

    const msgData = (await msgRes.json()) as { code: number; data?: { message_id?: string } };
    if (msgData.code !== 0) {
      throw new Error(`Lark message send failed with code ${msgData.code}`);
    }

    return msgData;
  }

  private async resolveOrCreateFallbackThread(params: {
    sessionId: string;
    taskType: string;
    executor?: string;
    executorModel?: string;
  }): Promise<LarkThreadDestination | null> {
    if (!this.larkHistoryRepository || !this.sessionRepository || !this.sessionPlatformLinkRepository) {
      return null;
    }

    const session = await this.sessionRepository.getSessionById(params.sessionId);
    if (!session || session.status !== 'active') {
      return null;
    }

    const activeLink = await this.sessionPlatformLinkRepository.getActiveLinkBySessionAndPlatform(
      params.sessionId,
      LARK_PLATFORM,
    );
    if (activeLink?.externalThreadKey) {
      return this.loadPersistedDestination(
        activeLink.externalThreadKey,
        params.sessionId,
        params.taskType,
        params.executor,
        params.executorModel,
      );
    }

    const fallbackSeedText = session.fallbackSeedText?.trim();
    if (!fallbackSeedText) {
      return null;
    }

    const claimToken = this.buildClaimToken(params.sessionId);
    const nowMs = Date.now();
    const claim = await this.sessionPlatformLinkRepository.claimPendingLink({
      sessionId: params.sessionId,
      platform: LARK_PLATFORM,
      claimToken,
      claimExpiresAtMs: nowMs + CLAIM_TTL_MS,
      nowMs,
    });

    if (claim.externalThreadKey) {
      return this.loadPersistedDestination(
        claim.externalThreadKey,
        params.sessionId,
        params.taskType,
        params.executor,
        params.executorModel,
      );
    }

    if (claim.claimToken !== claimToken) {
      const reread = await this.sessionPlatformLinkRepository.getActiveLinkBySessionAndPlatform(params.sessionId, LARK_PLATFORM);
      return reread?.externalThreadKey
        ? this.loadPersistedDestination(
            reread.externalThreadKey,
            params.sessionId,
            params.taskType,
            params.executor,
            params.executorModel,
          )
        : null;
    }

    const token = await this.tokenProvider.getTenantAccessToken();

    try {
      const seedRes = await this.sendDirectMessage(fallbackSeedText, token);
      const rootMessageId = seedRes.data?.message_id;
      if (!rootMessageId) {
        throw new Error('Lark fallback seed message did not return a message_id');
      }

      await this.larkHistoryRepository.upsertLarkThreadState({
        rootMessageId,
        threadId: null,
        sessionId: params.sessionId,
        source: session.fallbackOrigin ?? 'fallback',
        chatType: null,
        taskType: session.taskType ?? params.taskType,
        executor: session.executor ?? params.executor ?? 'claude',
        executorModel: session.executorModel ?? params.executorModel ?? 'sonnet',
        status: 'active',
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });

      await this.larkHistoryRepository.recordOutboundLarkMessage({
        messageId: rootMessageId,
        source: session.fallbackOrigin ?? 'fallback',
        rootMessageId,
        sessionId: params.sessionId,
        threadId: null,
        messageType: 'text',
        rawContent: JSON.stringify({ text: fallbackSeedText }),
        normalizedText: fallbackSeedText,
        metadataJson: JSON.stringify({ event_kind: 'fallback_seed', fallback_origin: session.fallbackOrigin ?? null }),
        createdAtMs: nowMs,
      });

      const activated = await this.sessionPlatformLinkRepository.activateClaimedLink({
        sessionId: params.sessionId,
        platform: LARK_PLATFORM,
        claimToken: claim.claimToken,
        externalThreadKey: rootMessageId,
        updatedAtMs: nowMs,
      });

      if (!activated) {
        const reread = await this.sessionPlatformLinkRepository.getActiveLinkBySessionAndPlatform(
          params.sessionId,
          LARK_PLATFORM,
        );
        if (!reread?.externalThreadKey) {
          throw new Error(`Failed to activate Lark fallback thread for session ${params.sessionId}`);
        }

        return this.loadPersistedDestination(
          reread.externalThreadKey,
          params.sessionId,
          params.taskType,
          params.executor,
          params.executorModel,
        );
      }

      return {
        rootMessageId,
        threadId: null,
        sessionId: params.sessionId,
        source: session.fallbackOrigin ?? 'fallback',
        chatType: null,
        taskType: session.taskType ?? params.taskType,
        executor: session.executor ?? params.executor ?? 'claude',
        executorModel: session.executorModel ?? params.executorModel ?? 'sonnet',
        createdAtMs: nowMs,
      };
    } catch (error) {
      await this.sessionPlatformLinkRepository.releaseExpiredOrFailedClaim({
        sessionId: params.sessionId,
        platform: LARK_PLATFORM,
        claimToken: claim.claimToken,
        updatedAtMs: Date.now(),
      });
      throw error;
    }
  }

  private async loadPersistedDestination(
    rootMessageId: string,
    sessionId: string,
    taskType: string,
    executor?: string,
    executorModel?: string,
  ): Promise<LarkThreadDestination> {
    const existingThread = await this.larkHistoryRepository?.getLarkThreadByRootMessageId(rootMessageId);
    return {
      rootMessageId,
      threadId: existingThread?.threadId ?? null,
      sessionId,
      source: existingThread?.source ?? 'fallback',
      chatType: existingThread?.chatType ?? null,
      taskType: existingThread?.taskType ?? taskType,
      executor: existingThread?.executor ?? executor ?? 'claude',
      executorModel: existingThread?.executorModel ?? executorModel ?? 'sonnet',
      createdAtMs: existingThread?.createdAtMs ?? Date.now(),
    };
  }

  private async persistThreadReply(params: {
    destination: LarkThreadDestination;
    sessionId: string;
    taskType: string;
    executor?: string;
    executorModel?: string;
    text: string;
    messageId: string;
    metadataJson: string;
    createdAtMs: number;
    status: string;
  }): Promise<void> {
    if (!this.larkHistoryRepository) {
      return;
    }

    await this.larkHistoryRepository.upsertLarkThreadState({
      rootMessageId: params.destination.rootMessageId,
      threadId: params.destination.threadId,
      sessionId: params.sessionId,
      source: params.destination.source,
      chatType: params.destination.chatType,
      taskType: params.taskType,
      executor: params.executor ?? params.destination.executor,
      executorModel: params.executorModel ?? params.destination.executorModel,
      status: params.status,
      createdAtMs: params.destination.createdAtMs,
      updatedAtMs: params.createdAtMs,
    });

    const outboundParams: RecordOutboundLarkMessageParams = {
      messageId: params.messageId,
      source: params.destination.source,
      rootMessageId: params.destination.rootMessageId,
      sessionId: params.sessionId,
      threadId: params.destination.threadId,
      messageType: 'text',
      rawContent: JSON.stringify({ text: params.text }),
      normalizedText: params.text,
      metadataJson: params.metadataJson,
      createdAtMs: params.createdAtMs,
    };

    await this.larkHistoryRepository.recordOutboundLarkMessage(outboundParams);
  }

  private async resolveCleanupRootSessionId(sessionId: string, rootMessageId: string): Promise<string> {
    const thread = await this.larkHistoryRepository?.getLarkThreadByRootMessageId(rootMessageId);
    return thread?.rootSessionId ?? sessionId;
  }

  private async cleanupTerminalSessionRows(rootSessionId: string, endedAtMs: number): Promise<void> {
    if (!rootSessionId) {
      return;
    }

    const descendantSessionIds = this.sessionRepository?.listDescendantSessionIds
      ? await this.sessionRepository.listDescendantSessionIds(rootSessionId)
      : [];
    const sessionIds = [rootSessionId, ...descendantSessionIds];

    for (const sessionId of sessionIds) {
      await this.sessionRepository?.markSessionEnded(sessionId, endedAtMs);
    }

    if (this.larkHistoryRepository?.deleteLarkRowsBySessionIds) {
      await this.larkHistoryRepository.deleteLarkRowsBySessionIds(sessionIds);
    } else {
      for (const sessionId of sessionIds) {
        await this.larkHistoryRepository?.deleteLarkRowsBySessionId(sessionId);
      }
    }

    if (this.sessionPlatformLinkRepository?.deleteLinksBySessionIds) {
      await this.sessionPlatformLinkRepository.deleteLinksBySessionIds(sessionIds);
    } else {
      for (const sessionId of sessionIds) {
        await this.sessionPlatformLinkRepository?.deleteLinksBySessionId(sessionId);
      }
    }

    if (this.sessionRepository?.deleteSessionsByIds) {
      await this.sessionRepository.deleteSessionsByIds(sessionIds);
    } else {
      for (const sessionId of sessionIds) {
        await this.sessionRepository?.deleteSessionById(sessionId);
      }
    }
  }

  private getOutboundEventKind(result: TaskResult): string {
    if (this.isNewInstanceReply(result)) {
      return 'new_instance_reply';
    }

    if (result.task_type === 'cleanup') {
      return 'end_reply';
    }

    return 'reply';
  }

  private buildSyntheticOutboundMessageId(resultId: string): string {
    return `local_outbound_${resultId}`;
  }

  private buildClaimToken(sessionId: string): string {
    return `lark-${sessionId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private isNewInstanceReply(result: TaskResult): boolean {
    return result.task_type === 'new_instance' || result.stdout.includes(NEW_INSTANCE_MARKER);
  }

  private async clearBotOwnedPhaseReactionsBeforeReply(messageId: string, token: string): Promise<void> {
    try {
      await clearBotOwnedPhaseReactions({
        messageId,
        token,
        expectedReactionTypes: getPhaseReactionTypes(),
      });
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to clear bot-owned phase reactions before final reply');
    }
  }
}
