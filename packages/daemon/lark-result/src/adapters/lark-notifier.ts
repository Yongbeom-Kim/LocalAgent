import {
  MirrorTaskEvent,
  SessionPlatformLinkRepository,
  SessionRepository,
  SessionBridgeRepository,
  TaskResult,
  createLogger,
  LarkHistoryRepository,
  type RecordOutboundLarkMessageParams,
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

interface ReplyDestination {
  replyMessageId: string;
  rootMessageId: string;
}

export class LarkNotifier {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly recipientId: string,
    private readonly larkHistoryRepository?: Pick<
      LarkHistoryRepository,
      | 'recordOutboundLarkMessage'
      | 'markLarkThreadNewInstance'
      | 'getLarkMessageByMessageId'
      | 'getLarkThreadByRootMessageId'
      | 'getLarkMessagesForThread'
      | 'upsertLarkThreadState'
      | 'markLarkThreadEnded'
      | 'deleteLarkRowsBySessionId'
    >,
    private readonly tokenProvider: TokenProvider = new LarkTenantTokenProvider(appId, appSecret),
    private readonly sessionBridgeRepository?: Pick<
      SessionBridgeRepository,
      'getBridgeBySessionId' | 'markBridgeEnded' | 'deleteBridgeBySessionId'
    >,
    private readonly sessionRepository?: Pick<
      SessionRepository,
      'markSessionEnded' | 'deleteSessionById' | 'listDescendantSessionIds' | 'deleteSessionsByIds'
    >,
    private readonly sessionPlatformLinkRepository?: Pick<
      SessionPlatformLinkRepository,
      'markLinksEnded' | 'deleteLinksBySessionId' | 'getLinkBySessionIdAndPlatform' | 'deleteLinksBySessionIds'
    >,
  ) {}

  async notify(result: TaskResult): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.sendNotification(result);
        return;
      } catch (err) {
        logger.warn({ result_id: result.result_id, attempt, err }, 'Lark notification attempt failed');
        if (attempt === MAX_RETRIES) {
          logger.error(
            { result_id: result.result_id },
            `Lark notification failed after ${MAX_RETRIES} attempts - giving up`,
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

  private async sendNotification(result: TaskResult): Promise<void> {
    const token = await this.tokenProvider.getTenantAccessToken();
    const text = [
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

    const destination = await this.resolveReplyDestination(result);
    let msgRes: Response;

    if (destination) {
      await this.clearBotOwnedPhaseReactionsBeforeReply(destination.replyMessageId, token);
      msgRes = await fetch(LARK_REPLY_URL(destination.replyMessageId), {
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
    } else {
      msgRes = await fetch(LARK_MESSAGE_URL, {
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
    }

    const msgData = (await msgRes.json()) as { code: number; data?: { message_id?: string } };
    if (msgData.code !== 0) {
      throw new Error(`Lark message send failed with code ${msgData.code}`);
    }

    await this.persistOutboundReply(result, text, msgData.data?.message_id);
  }

  private async persistOutboundReply(
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
    const createdAtMs = Date.now();
    const eventKind = this.getOutboundEventKind(result);
    const metadataJson = eventKind ? JSON.stringify({ event_kind: eventKind }) : null;

    await this.larkHistoryRepository.upsertLarkThreadState({
      rootMessageId,
      threadId: sourceMessage?.threadId ?? existingThread?.threadId ?? null,
      sessionId: result.session_id,
      source: 'lark',
      chatType: existingThread?.chatType ?? null,
      taskType: result.task_type,
      executor: result.executor ?? existingThread?.executor ?? 'claude',
      executorModel: result.executor_model ?? existingThread?.executorModel ?? 'sonnet',
      status: result.task_type === 'cleanup' ? 'ended' : 'active',
      createdAtMs: existingThread?.createdAtMs ?? sourceMessage?.createdAtMs ?? createdAtMs,
      updatedAtMs: createdAtMs,
      endedAtMs: result.task_type === 'cleanup' ? createdAtMs : null,
    });

    const outboundParams: RecordOutboundLarkMessageParams = {
      messageId: messageIdFromResponse ?? this.buildSyntheticOutboundMessageId(result.result_id),
      source: 'lark',
      rootMessageId,
      sessionId: result.session_id,
      threadId: sourceMessage?.threadId ?? existingThread?.threadId ?? null,
      messageType: 'text',
      rawContent: JSON.stringify({ text }),
      normalizedText: text,
      metadataJson,
      createdAtMs,
    };

    await this.larkHistoryRepository.recordOutboundLarkMessage(outboundParams);

    if (this.isNewInstanceReply(result) && result.executor && result.executor_model) {
      await this.larkHistoryRepository.markLarkThreadNewInstance({
        sessionId: result.session_id,
        executor: result.executor,
        executorModel: result.executor_model,
        updatedAtMs: createdAtMs,
      });
    }

    if (result.task_type === 'cleanup') {
      const cleanupRootSessionId = await this.resolveCleanupRootSessionId(result, rootMessageId);
      await this.cleanupTerminalSessionRows(cleanupRootSessionId, createdAtMs);
    }
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
      if (link) {
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

  private async resolveCleanupRootSessionId(result: TaskResult, rootMessageId: string): Promise<string> {
    const thread = await this.larkHistoryRepository?.getLarkThreadByRootMessageId(rootMessageId);
    if (thread?.rootSessionId) {
      return thread.rootSessionId;
    }

    if (result.session_id && this.sessionPlatformLinkRepository?.getLinkBySessionIdAndPlatform) {
      const link = await this.sessionPlatformLinkRepository.getLinkBySessionIdAndPlatform(result.session_id, 'lark');
      if (link) {
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

    const deleteLarkRowsBySessionIds = (this.larkHistoryRepository as { deleteLarkRowsBySessionIds?: (sessionIds: string[]) => Promise<void> } | undefined)?.deleteLarkRowsBySessionIds;
    if (deleteLarkRowsBySessionIds) {
      await deleteLarkRowsBySessionIds(sessionIds);
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

  private getOutboundEventKind(result: TaskResult): string | null {
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
