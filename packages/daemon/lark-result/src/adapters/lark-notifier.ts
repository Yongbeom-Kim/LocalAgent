import {
  MirrorTaskEvent,
  SessionPlatformLinkRepository,
  SessionRepository,
  SessionBridgeRepository,
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
  | 'getLarkMessageByMessageId'
  | 'getLarkThreadByRootMessageId'
  | 'getLarkMessagesForThread'
  | 'upsertLarkThreadState'
  | 'markLarkThreadEnded'
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
  | 'markLinksEnded'
  | 'deleteLinksBySessionId'
  | 'getLinkBySessionIdAndPlatform'
  | 'deleteLinksBySessionIds'
>;

interface LarkThreadDestination {
  rootMessageId: string;
  threadId: string | null;
  sessionId?: string;
  source: string;
  chatType: string | null;
  taskType: string;
  executor: string;
  executorModel: string;
  createdAtMs: number;
}

interface ReplyDestination {
  replyMessageId: string;
  rootMessageId: string;
}

export class LarkNotifier {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly recipientId: string,
    private readonly larkHistoryRepository?: LarkHistoryRepositoryLike,
    private readonly tokenProvider: TokenProvider = new LarkTenantTokenProvider(appId, appSecret),
    private readonly sessionBridgeRepository?: Pick<
      SessionBridgeRepository,
      'getBridgeBySessionId' | 'markBridgeEnded' | 'deleteBridgeBySessionId'
    >,
    private readonly sessionRepository?: SessionRepositoryLike,
    private readonly sessionPlatformLinkRepository?: SessionPlatformLinkRepositoryLike,
  ) {}

  async notify(result: TaskResult): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.sendResultNotification(result);
        return;
      } catch (err) {
        logger.warn(
          { result_id: result.result_id, attempt, err },
          'Lark notification attempt failed',
        );
        if (attempt === MAX_RETRIES) {
          logger.error(
            { result_id: result.result_id },
            `Lark notification failed after ${MAX_RETRIES} attempts — giving up`,
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
        logger.warn(
          { event_id: event.event_id, attempt, err },
          'Lark phase notification attempt failed',
        );
        if (attempt === MAX_RETRIES) {
          logger.error(
            { event_id: event.event_id },
            `Lark phase notification failed after ${MAX_RETRIES} attempts — giving up`,
          );
        }
      }
    }
  }

  async notifyMirror(event: MirrorTaskEvent): Promise<void> {
    if (!this.larkHistoryRepository || !this.sessionBridgeRepository) {
      return;
    }

    const bridge = await this.sessionBridgeRepository.getBridgeBySessionId(event.session_id);
    if (!bridge) {
      return;
    }

    const existingMessages = await this.larkHistoryRepository.getLarkMessagesForThread(bridge.larkRootMessageId);
    const duplicate = existingMessages.some((message) => {
      if (message.direction !== 'outbound' || !message.metadataJson) {
        return false;
      }

      try {
        const metadata = JSON.parse(message.metadataJson) as { mirror_id?: string };
        return metadata.mirror_id === event.mirror_id;
      } catch {
        return false;
      }
    });

    if (duplicate) {
      return;
    }

    const token = await this.tokenProvider.getTenantAccessToken();
    const createdAtMs = Date.now();
    const rawContent = JSON.stringify({ text: event.text });

    const msgRes = await fetch(LARK_REPLY_URL(bridge.larkRootMessageId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        msg_type: 'text',
        content: rawContent,
        reply_in_thread: true,
      }),
    });

    const msgData = (await msgRes.json()) as { code: number; data?: { message_id?: string } };
    if (msgData.code !== 0) {
      throw new Error(`Lark mirror send failed with code ${msgData.code}`);
    }

    const existingThread = await this.larkHistoryRepository.getLarkThreadByRootMessageId(bridge.larkRootMessageId);
    await this.larkHistoryRepository.recordOutboundLarkMessage({
      messageId: msgData.data?.message_id ?? this.buildSyntheticOutboundMessageId(event.mirror_id),
      source: event.task_source.source,
      rootMessageId: bridge.larkRootMessageId,
      sessionId: event.session_id,
      threadId: existingThread?.threadId ?? null,
      messageType: 'text',
      rawContent,
      normalizedText: event.text,
      metadataJson: JSON.stringify({
        mirror_origin: event.task_source.source,
        origin_message_id: event.origin_message_id,
        mirror_id: event.mirror_id,
        mirrored_by: 'local-agent',
      }),
      createdAtMs,
    });
  }

  private async sendResultNotification(result: TaskResult): Promise<void> {
    const token = await this.tokenProvider.getTenantAccessToken();
    const text = this.buildResultText(result);

    if (result.task_source?.source === 'lark') {
      await this.clearBotOwnedPhaseReactionsBeforeReply(result.task_source.message_id, token);
      const msgRes = await this.replyInThread(result.task_source.message_id, text, token);
      await this.persistDirectReply(result, text, msgRes.data?.message_id);
      if (
        result.session_id &&
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
      return;
    }

    const replyDestination = await this.resolveReplyDestination(result);
    if (replyDestination) {
      await this.clearBotOwnedPhaseReactionsBeforeReply(replyDestination.replyMessageId, token);
      const msgRes = await this.replyInThread(replyDestination.replyMessageId, text, token);
      await this.persistDirectReply(result, text, msgRes.data?.message_id);
      if (
        result.session_id &&
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
      return;
    }

    const destination = await this.resolveOrCreateFallbackThread({
      sessionId: result.session_id,
      taskType: result.task_type,
      executor: result.executor,
      executorModel: result.executor_model,
      token,
    });

    if (!destination) {
      await this.sendDirectMessage(text, token);
      return;
    }

    const createdAtMs = Date.now();
    const msgRes = await this.replyInThread(destination.rootMessageId, text, token);
    await this.persistThreadReply({
      destination,
      sessionId: result.session_id ?? destination.sessionId,
      taskType: result.task_type,
      executor: result.executor,
      executorModel: result.executor_model,
      text,
      messageId: msgRes.data?.message_id ?? this.buildSyntheticOutboundMessageId(result.result_id),
      metadataJson: JSON.stringify({ event_kind: this.getOutboundEventKind(result), result_id: result.result_id }),
      createdAtMs,
      status: result.task_type === 'cleanup' ? 'ended' : 'active',
    });

    if (result.session_id && result.task_type === 'cleanup') {
      const cleanupRootSessionId = await this.resolveCleanupRootSessionId(result, destination.rootMessageId);
      await this.cleanupTerminalSessionRows(cleanupRootSessionId, createdAtMs);
    }

    if (
      result.session_id &&
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
    const token = await this.tokenProvider.getTenantAccessToken();
    const destination = await this.resolveOrCreateFallbackThread({
      sessionId: event.session_id,
      taskType: event.task_type,
      executor: event.executor,
      executorModel: event.executor_model,
      token,
    });

    if (!destination) {
      return;
    }

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
      ...(result.session_id ? [`session_id: ${result.session_id}`] : []),
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
    sessionId?: string;
    taskType: string;
    executor?: string;
    executorModel?: string;
    token: string;
  }): Promise<LarkThreadDestination | null> {
    if (!params.sessionId || !this.larkHistoryRepository || !this.sessionRepository || !this.sessionPlatformLinkRepository) {
      return null;
    }

    const activeLink = await this.sessionPlatformLinkRepository.getActiveLinkBySessionAndPlatform(
      params.sessionId,
      LARK_PLATFORM,
    );
    if (activeLink?.externalThreadKey) {
      return this.loadPersistedDestination(activeLink.externalThreadKey, params.sessionId, params.taskType, params.executor, params.executorModel);
    }

    const session = await this.sessionRepository.getSessionById(params.sessionId);
    const fallbackSeedText = session?.fallbackSeedText?.trim();
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

    if (claim.linkStatus === 'active' && claim.externalThreadKey) {
      return this.loadPersistedDestination(claim.externalThreadKey, params.sessionId, params.taskType, params.executor, params.executorModel);
    }

    if (claim.claimToken !== claimToken) {
      const reread = await this.sessionPlatformLinkRepository.getActiveLinkBySessionAndPlatform(params.sessionId, LARK_PLATFORM);
      return reread?.externalThreadKey
        ? this.loadPersistedDestination(reread.externalThreadKey, params.sessionId, params.taskType, params.executor, params.executorModel)
        : null;
    }

    try {
      const seedRes = await this.sendDirectMessage(fallbackSeedText, params.token);
      const rootMessageId = seedRes.data?.message_id;
      if (!rootMessageId) {
        throw new Error('Lark fallback seed message did not return a message_id');
      }

      await this.larkHistoryRepository.upsertLarkThreadState({
        rootMessageId,
        threadId: null,
        sessionId: params.sessionId,
        source: session?.fallbackOrigin ?? 'fallback',
        chatType: null,
        taskType: session?.taskType ?? params.taskType,
        executor: session?.executor ?? params.executor ?? 'claude',
        executorModel: session?.executorModel ?? params.executorModel ?? 'sonnet',
        status: 'active',
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        endedAtMs: null,
      });

      await this.larkHistoryRepository.recordOutboundLarkMessage({
        messageId: rootMessageId,
        source: session?.fallbackOrigin ?? 'fallback',
        rootMessageId,
        sessionId: params.sessionId,
        threadId: null,
        messageType: 'text',
        rawContent: JSON.stringify({ text: fallbackSeedText }),
        normalizedText: fallbackSeedText,
        metadataJson: JSON.stringify({ event_kind: 'fallback_seed', fallback_origin: session?.fallbackOrigin ?? null }),
        createdAtMs: nowMs,
      });

      await this.sessionPlatformLinkRepository.activateClaimedLink({
        sessionId: params.sessionId,
        platform: LARK_PLATFORM,
        claimToken: claim.claimToken,
        externalThreadKey: rootMessageId,
        updatedAtMs: nowMs,
      });

      return {
        rootMessageId,
        threadId: null,
        sessionId: params.sessionId,
        source: session?.fallbackOrigin ?? 'fallback',
        chatType: null,
        taskType: session?.taskType ?? params.taskType,
        executor: session?.executor ?? params.executor ?? 'claude',
        executorModel: session?.executorModel ?? params.executorModel ?? 'sonnet',
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

  private async resolveReplyDestination(result: TaskResult): Promise<ReplyDestination | null> {
    const rootMessageId = await this.resolveLarkRootMessageId(result);
    if (!rootMessageId) {
      return null;
    }

    return {
      replyMessageId: rootMessageId,
      rootMessageId,
    };
  }

  private async resolveLarkRootMessageId(result: TaskResult): Promise<string | null> {
    if (result.context_ref?.platform === 'lark') {
      return result.context_ref.root_key;
    }

    if (result.task_source?.source === 'lark') {
      const sourceMessage = await this.larkHistoryRepository?.getLarkMessageByMessageId(result.task_source.message_id);
      return sourceMessage?.rootMessageId ?? result.task_source.message_id;
    }

    if (result.session_id && this.sessionPlatformLinkRepository?.getLinkBySessionIdAndPlatform) {
      const link = await this.sessionPlatformLinkRepository.getLinkBySessionIdAndPlatform(result.session_id, 'lark');
      if (link?.externalThreadKey) {
        return link.externalThreadKey;
      }
    }

    if (result.session_id && this.sessionBridgeRepository) {
      const bridge = await this.sessionBridgeRepository.getBridgeBySessionId(result.session_id);
      if (bridge) {
        return bridge.larkRootMessageId;
      }
    }

    return null;
  }

  private async persistDirectReply(
    result: TaskResult,
    text: string,
    messageIdFromResponse?: string,
  ): Promise<void> {
    if (!result.session_id || !this.larkHistoryRepository) {
      return;
    }

    const rootMessageId = await this.resolveLarkRootMessageId(result);
    if (!rootMessageId) {
      return;
    }

    const sourceMessage = result.task_source?.source === 'lark'
      ? await this.larkHistoryRepository.getLarkMessageByMessageId(result.task_source.message_id)
      : null;
    const existingThread = await this.larkHistoryRepository.getLarkThreadByRootMessageId(rootMessageId);

    await this.persistThreadReply({
      destination: {
        rootMessageId,
        threadId: sourceMessage?.threadId ?? existingThread?.threadId ?? null,
        sessionId: result.session_id,
        source: 'lark',
        chatType: existingThread?.chatType ?? null,
        taskType: existingThread?.taskType ?? result.task_type,
        executor: existingThread?.executor ?? result.executor ?? 'claude',
        executorModel: existingThread?.executorModel ?? result.executor_model ?? 'sonnet',
        createdAtMs: existingThread?.createdAtMs ?? sourceMessage?.createdAtMs ?? Date.now(),
      },
      sessionId: result.session_id,
      taskType: result.task_type,
      executor: result.executor,
      executorModel: result.executor_model,
      text,
      messageId: messageIdFromResponse ?? this.buildSyntheticOutboundMessageId(result.result_id),
      metadataJson: JSON.stringify({ event_kind: this.getOutboundEventKind(result), result_id: result.result_id }),
      createdAtMs: Date.now(),
      status: result.task_type === 'cleanup' ? 'ended' : 'active',
    });

    if (result.task_type === 'cleanup') {
      const cleanupRootSessionId = await this.resolveCleanupRootSessionId(result, rootMessageId);
      await this.cleanupTerminalSessionRows(cleanupRootSessionId, Date.now());
    }
  }

  private async persistThreadReply(params: {
    destination: LarkThreadDestination;
    sessionId?: string;
    taskType: string;
    executor?: string;
    executorModel?: string;
    text: string;
    messageId: string;
    metadataJson: string;
    createdAtMs: number;
    status: string;
  }): Promise<void> {
    if (!this.larkHistoryRepository || !params.sessionId) {
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
      endedAtMs: params.status === 'ended' ? params.createdAtMs : null,
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

  private async resolveCleanupRootSessionId(result: TaskResult, rootMessageId: string): Promise<string> {
    const thread = await this.larkHistoryRepository?.getLarkThreadByRootMessageId(rootMessageId);
    if (thread?.rootSessionId) {
      return thread.rootSessionId;
    }

    if (result.session_id && this.sessionPlatformLinkRepository?.getLinkBySessionIdAndPlatform) {
      const link = await this.sessionPlatformLinkRepository.getLinkBySessionIdAndPlatform(result.session_id, 'lark');
      if (link?.externalThreadKey) {
        const linkedThread = await this.larkHistoryRepository?.getLarkThreadByRootMessageId(link.externalThreadKey);
        if (linkedThread?.rootSessionId) {
          return linkedThread.rootSessionId;
        }
      }
    }

    return result.session_id ?? '';
  }

  private async cleanupTerminalSessionRows(rootSessionId: string, endedAtMs: number): Promise<void> {
    await this.larkHistoryRepository?.markLarkThreadEnded?.(rootSessionId, endedAtMs);

    const bridge = await this.sessionBridgeRepository?.getBridgeBySessionId(rootSessionId);
    if (bridge) {
      await this.sessionBridgeRepository?.markBridgeEnded(rootSessionId, endedAtMs);
    }

    const descendantSessionIds = this.sessionRepository?.listDescendantSessionIds
      ? await this.sessionRepository.listDescendantSessionIds(rootSessionId)
      : [];
    const sessionIds = [rootSessionId, ...descendantSessionIds];

    for (const sessionId of sessionIds) {
      await this.sessionRepository?.markSessionEnded(sessionId, endedAtMs);
      await this.sessionPlatformLinkRepository?.markLinksEnded(sessionId, endedAtMs);
    }

    if (bridge) {
      await this.sessionBridgeRepository?.deleteBridgeBySessionId(rootSessionId);
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
