import {
  SessionPlatformLinkRepository,
  SessionRepository,
  SessionBridgeRepository,
  TelegramHistoryRepository,
  type MirrorTaskEvent,
  TaskResult,
  createLogger,
} from '@local-agent/shared';
import { DEFAULT_TELEGRAM_MAX_RETRIES, MAX_MESSAGE_CHARS } from '../constants';

const logger = createLogger('telegram-daemon:notifier');

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const TELEGRAM_PLATFORM = 'telegram';
const CLAIM_TTL_MS = 60_000;

// MarkdownV2 special chars that must be escaped outside code blocks
const MARKDOWNV2_ESCAPE_REGEX = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWNV2_ESCAPE_REGEX, '\\$1');
}

export interface TelegramTopicManagerLike {
  createForumTopic(chatId: string, name: string): Promise<{ message_thread_id: number; name: string }>;
}

export class TelegramTopicManager implements TelegramTopicManagerLike {
  private readonly apiBase: string;

  constructor(botToken: string) {
    this.apiBase = `${TELEGRAM_API_BASE}${botToken}`;
  }

  async createForumTopic(chatId: string, name: string): Promise<{ message_thread_id: number; name: string }> {
    const res = await fetch(`${this.apiBase}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, name }),
    });
    const data = (await res.json()) as {
      ok: boolean;
      result?: { message_thread_id: number; name: string };
      description?: string;
    };

    if (!data.ok || !data.result) {
      throw new Error(`Telegram createForumTopic failed: ${data.description ?? 'unknown error'}`);
    }

    return data.result;
  }
}

type TelegramHistoryRepositoryLike = Pick<
  TelegramHistoryRepository,
  | 'getTelegramThreadBySessionId'
  | 'getTelegramThreadByTopic'
  | 'listTelegramMessagesForTopic'
  | 'recordOutboundTelegramMessage'
  | 'upsertTelegramThreadState'
  | 'markTelegramThreadEnded'
  | 'deleteTelegramRowsBySessionId'
  | 'deleteTelegramRowsBySessionIds'
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

interface TelegramDestination {
  chatId: string;
  topicId?: string;
  sessionId?: string;
}

export class TelegramNotifier {
  private readonly apiBase: string;

  constructor(
    private readonly botToken: string,
    private readonly forumGroupId: string,
    private readonly telegramHistoryRepository?: TelegramHistoryRepositoryLike,
    private readonly sessionBridgeRepository?: Pick<
      SessionBridgeRepository,
      'getBridgeBySessionId' | 'getBridgeByTelegramTopic' | 'markBridgeEnded' | 'deleteBridgeBySessionId'
    >,
    private readonly sessionRepository?: SessionRepositoryLike,
    private readonly sessionPlatformLinkRepository?: SessionPlatformLinkRepositoryLike,
    private readonly topicManager: TelegramTopicManagerLike = new TelegramTopicManager(botToken),
  ) {
    this.apiBase = `${TELEGRAM_API_BASE}${botToken}`;
  }

  async validate(): Promise<string> {
    const res = await fetch(`${this.apiBase}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { username: string }; description?: string };

    if (!data.ok) {
      throw new Error(`Telegram bot validation failed: ${data.description ?? 'unknown error'}`);
    }

    return data.result!.username;
  }

  async notify(result: TaskResult): Promise<void> {
    for (let attempt = 1; attempt <= DEFAULT_TELEGRAM_MAX_RETRIES; attempt++) {
      try {
        await this.sendMessage(result);
        return;
      } catch (err) {
        logger.warn(
          { result_id: result.result_id, attempt, err },
          'Telegram notification attempt failed',
        );
        if (attempt === DEFAULT_TELEGRAM_MAX_RETRIES) {
          logger.error(
            { result_id: result.result_id },
            `Telegram notification failed after ${DEFAULT_TELEGRAM_MAX_RETRIES} attempts — giving up`,
          );
        }
      }
    }
  }

  async notifyLegacy(result: TaskResult): Promise<void> {
    await this.sendMessageToChat({
      chatId: this.forumGroupId,
      text: this.formatMessage(result),
      parseMode: 'MarkdownV2',
    });
  }

  async notifyMirror(event: MirrorTaskEvent): Promise<void> {
    if (!this.telegramHistoryRepository || !this.sessionBridgeRepository) {
      return;
    }

    const bridge = await this.sessionBridgeRepository.getBridgeBySessionId(event.session_id);
    if (!bridge) {
      return;
    }

    const existingMessages = await this.telegramHistoryRepository.listTelegramMessagesForTopic(
      bridge.telegramChatId,
      bridge.telegramTopicId,
    );
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

    const sentMessageId = await this.sendMessageToChat({
      chatId: bridge.telegramChatId,
      messageThreadId: Number(bridge.telegramTopicId),
      text: event.text,
      parseMode: undefined,
    });

    await this.telegramHistoryRepository.recordOutboundTelegramMessage({
      chatId: bridge.telegramChatId,
      topicId: bridge.telegramTopicId,
      messageId: sentMessageId,
      sessionId: event.session_id,
      direction: 'outbound',
      senderType: 'bot',
      messageType: 'text',
      rawContent: event.text,
      normalizedText: event.text,
      metadataJson: JSON.stringify({
        mirror_origin: event.task_source.source,
        origin_message_id: event.origin_message_id,
        mirror_id: event.mirror_id,
        mirrored_by: 'local-agent',
      }),
      createdAtMs: Date.now(),
    });
  }

  async notifyStatus(params: { chatId?: string; topicId?: string; sessionId?: string; text: string }): Promise<void> {
    const destination = await this.resolveDestination(params);
    if (!destination) {
      return;
    }

    const messageId = await this.sendMessageToChat({
      chatId: destination.chatId,
      messageThreadId: destination.topicId ? Number(destination.topicId) : undefined,
      text: params.text,
      parseMode: 'MarkdownV2',
    });

    await this.persistOutboundMessage({
      destination,
      messageId,
      text: params.text,
      metadataJson: JSON.stringify({ event_kind: 'phase_status' }),
      taskType: 'status',
      createdAtMs: Date.now(),
      statusMessageId: messageId,
    });
  }

  async notifyResult(params: { chatId?: string; topicId?: string; result: TaskResult }): Promise<void> {
    const destination = await this.resolveDestination({
      chatId: params.chatId,
      topicId: params.topicId,
      sessionId: params.result.session_id,
      contextRef: params.result.context_ref,
    });

    if (!destination) {
      return;
    }

    const text = this.formatMessage(params.result);
    const messageId = await this.sendMessageToChat({
      chatId: destination.chatId,
      messageThreadId: destination.topicId ? Number(destination.topicId) : undefined,
      text,
      parseMode: 'MarkdownV2',
    });

    await this.persistOutboundMessage({
      destination,
      messageId,
      text,
      metadataJson: JSON.stringify({ event_kind: 'result', result_id: params.result.result_id }),
      taskType: params.result.task_type,
      executor: params.result.executor,
      executorModel: params.result.executor_model,
      createdAtMs: Date.now(),
    });

    if (params.result.task_type === 'cleanup') {
      const cleanupRootSessionId = await this.resolveCleanupRootSessionId(params.result, destination);
      await this.cleanupTerminalSessionRows(cleanupRootSessionId, Date.now());
    }
  }

  private async resolveCleanupRootSessionId(result: TaskResult, destination: TelegramDestination): Promise<string> {
    if (destination.topicId) {
      const thread = await this.telegramHistoryRepository?.getTelegramThreadByTopic(destination.chatId, destination.topicId);
      if (thread?.rootSessionId) {
        return thread.rootSessionId;
      }
    }

    if (result.session_id && this.sessionPlatformLinkRepository?.getLinkBySessionIdAndPlatform) {
      const link = await this.sessionPlatformLinkRepository.getLinkBySessionIdAndPlatform(result.session_id, TELEGRAM_PLATFORM);
      if (link?.externalThreadKey) {
        const { chatId, topicId } = this.parseExternalThreadKey(link.externalThreadKey);
        const thread = await this.telegramHistoryRepository?.getTelegramThreadByTopic(chatId, topicId);
        if (thread?.rootSessionId) {
          return thread.rootSessionId;
        }
      }
    }

    return result.session_id ?? destination.sessionId ?? '';
  }

  private async cleanupTerminalSessionRows(rootSessionId: string, endedAtMs: number): Promise<void> {
    if (!rootSessionId) {
      return;
    }

    await this.telegramHistoryRepository?.markTelegramThreadEnded(rootSessionId, endedAtMs);

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

    if (this.telegramHistoryRepository?.deleteTelegramRowsBySessionIds) {
      await this.telegramHistoryRepository.deleteTelegramRowsBySessionIds(sessionIds);
    } else {
      for (const sessionId of sessionIds) {
        await this.telegramHistoryRepository?.deleteTelegramRowsBySessionId(sessionId);
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

  private async sendMessage(result: TaskResult): Promise<void> {
    await this.notifyResult({ result });
  }

  private async sendMessageToChat(params: {
    chatId: string;
    text: string;
    messageThreadId?: number;
    parseMode?: 'MarkdownV2';
  }): Promise<string> {
    const res = await fetch(`${this.apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: params.chatId,
        text: params.text,
        ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
        ...(params.messageThreadId !== undefined ? { message_thread_id: params.messageThreadId } : {}),
      }),
    });

    const data = (await res.json()) as { ok: boolean; description?: string; result?: { message_id?: number } };

    if (!data.ok) {
      throw new Error(`Telegram sendMessage failed: ${data.description ?? 'unknown error'}`);
    }

    return String(data.result?.message_id ?? `telegram_outbound_${Date.now()}`);
  }

  private async resolveDestination(params: {
    chatId?: string;
    topicId?: string;
    sessionId?: string;
    contextRef?: { platform: 'lark' | 'telegram'; root_key: string };
  }): Promise<TelegramDestination | null> {
    if (params.chatId) {
      return {
        chatId: params.chatId,
        topicId: params.topicId,
        sessionId: params.sessionId,
      };
    }

    if (params.contextRef?.platform === TELEGRAM_PLATFORM) {
      return {
        ...this.parseExternalThreadKey(params.contextRef.root_key),
        sessionId: params.sessionId,
      };
    }

    if (!params.sessionId) {
      return { chatId: this.forumGroupId };
    }

    const activeLink = await this.sessionPlatformLinkRepository?.getActiveLinkBySessionAndPlatform(
      params.sessionId,
      TELEGRAM_PLATFORM,
    );
    if (activeLink?.externalThreadKey) {
      return {
        ...this.parseExternalThreadKey(activeLink.externalThreadKey),
        sessionId: params.sessionId,
      };
    }

    const bridge = await this.sessionBridgeRepository?.getBridgeBySessionId(params.sessionId);
    if (bridge) {
      return {
        chatId: bridge.telegramChatId,
        topicId: bridge.telegramTopicId,
        sessionId: params.sessionId,
      };
    }

    if (!this.sessionRepository || !this.sessionPlatformLinkRepository || !this.telegramHistoryRepository) {
      return { chatId: this.forumGroupId, sessionId: params.sessionId };
    }

    const session = await this.sessionRepository.getSessionById(params.sessionId);
    const fallbackSeedText = session?.fallbackSeedText?.trim();
    if (!fallbackSeedText) {
      return { chatId: this.forumGroupId, sessionId: params.sessionId };
    }

    const claimToken = this.buildClaimToken(params.sessionId);
    const nowMs = Date.now();
    const claim = await this.sessionPlatformLinkRepository.claimPendingLink({
      sessionId: params.sessionId,
      platform: TELEGRAM_PLATFORM,
      claimToken,
      claimExpiresAtMs: nowMs + CLAIM_TTL_MS,
      nowMs,
    });

    if (claim.linkStatus === 'active' && claim.externalThreadKey) {
      return {
        ...this.parseExternalThreadKey(claim.externalThreadKey),
        sessionId: params.sessionId,
      };
    }

    if (claim.claimToken !== claimToken) {
      const reread = await this.sessionPlatformLinkRepository.getActiveLinkBySessionAndPlatform(
        params.sessionId,
        TELEGRAM_PLATFORM,
      );
      return reread?.externalThreadKey
        ? { ...this.parseExternalThreadKey(reread.externalThreadKey), sessionId: params.sessionId }
        : null;
    }

    try {
      const topic = await this.topicManager.createForumTopic(
        this.forumGroupId,
        this.buildFallbackTopicName(session?.fallbackTitleHint ?? null, fallbackSeedText),
      );
      const topicId = String(topic.message_thread_id);
      const seedMessageId = await this.sendMessageToChat({
        chatId: this.forumGroupId,
        messageThreadId: Number(topicId),
        text: fallbackSeedText,
      });
      const externalThreadKey = this.buildExternalThreadKey(this.forumGroupId, topicId);

      await this.telegramHistoryRepository.upsertTelegramThreadState({
        chatId: this.forumGroupId,
        topicId,
        sessionId: params.sessionId,
        source: session?.fallbackOrigin ?? 'fallback',
        taskType: session?.taskType ?? 'generic',
        executor: session?.executor ?? 'claude',
        executorModel: session?.executorModel ?? 'sonnet',
        status: 'active',
        seedMessageId,
        statusMessageId: null,
        metadataJson: JSON.stringify({ topic_name: topic.name, fallback_origin: session?.fallbackOrigin ?? null }),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        endedAtMs: null,
      });

      await this.telegramHistoryRepository.recordOutboundTelegramMessage({
        chatId: this.forumGroupId,
        topicId,
        messageId: seedMessageId,
        sessionId: params.sessionId,
        direction: 'outbound',
        senderType: 'bot',
        messageType: 'text',
        rawContent: fallbackSeedText,
        normalizedText: fallbackSeedText,
        metadataJson: JSON.stringify({ event_kind: 'fallback_seed', fallback_origin: session?.fallbackOrigin ?? null }),
        createdAtMs: nowMs,
      });

      const activated = await this.sessionPlatformLinkRepository.activateClaimedLink({
        sessionId: params.sessionId,
        platform: TELEGRAM_PLATFORM,
        claimToken: claim.claimToken,
        externalThreadKey,
        updatedAtMs: nowMs,
      });

      if (!activated) {
        const reread = await this.sessionPlatformLinkRepository.getActiveLinkBySessionAndPlatform(
          params.sessionId,
          TELEGRAM_PLATFORM,
        );
        if (!reread?.externalThreadKey) {
          throw new Error(`Failed to activate Telegram fallback topic for session ${params.sessionId}`);
        }

        return { ...this.parseExternalThreadKey(reread.externalThreadKey), sessionId: params.sessionId };
      }

      return {
        chatId: this.forumGroupId,
        topicId,
        sessionId: params.sessionId,
      };
    } catch (error) {
      await this.sessionPlatformLinkRepository.releaseExpiredOrFailedClaim({
        sessionId: params.sessionId,
        platform: TELEGRAM_PLATFORM,
        claimToken: claim.claimToken,
        updatedAtMs: Date.now(),
      });
      throw error;
    }
  }

  private async persistOutboundMessage(params: {
    destination: TelegramDestination;
    messageId: string;
    text: string;
    metadataJson: string;
    taskType: string;
    executor?: string;
    executorModel?: string;
    createdAtMs: number;
    statusMessageId?: string;
  }): Promise<void> {
    if (!this.telegramHistoryRepository || !params.destination.topicId || !params.destination.sessionId) {
      return;
    }

    const thread = await this.telegramHistoryRepository.getTelegramThreadByTopic(
      params.destination.chatId,
      params.destination.topicId,
    );

    await this.telegramHistoryRepository.recordOutboundTelegramMessage({
      chatId: params.destination.chatId,
      topicId: params.destination.topicId,
      messageId: params.messageId,
      sessionId: params.destination.sessionId,
      direction: 'outbound',
      senderType: 'bot',
      messageType: 'text',
      rawContent: params.text,
      normalizedText: params.text,
      metadataJson: params.metadataJson,
      createdAtMs: params.createdAtMs,
    });

    await this.telegramHistoryRepository.upsertTelegramThreadState({
      chatId: params.destination.chatId,
      topicId: params.destination.topicId,
      sessionId: params.destination.sessionId,
      source: thread?.source ?? 'telegram',
      taskType: thread?.taskType ?? params.taskType,
      executor: thread?.executor ?? params.executor ?? 'claude',
      executorModel: thread?.executorModel ?? params.executorModel ?? 'sonnet',
      status: thread?.status ?? 'active',
      seedMessageId: thread?.seedMessageId ?? null,
      statusMessageId: params.statusMessageId ?? thread?.statusMessageId ?? null,
      metadataJson: thread?.metadataJson ?? null,
      createdAtMs: thread?.createdAtMs ?? params.createdAtMs,
      updatedAtMs: params.createdAtMs,
      endedAtMs: thread?.endedAtMs ?? null,
    });
  }

  private buildExternalThreadKey(chatId: string, topicId: string): string {
    return `${chatId}:${topicId}`;
  }

  private parseExternalThreadKey(externalThreadKey: string): { chatId: string; topicId: string } {
    const separatorIndex = externalThreadKey.lastIndexOf(':');
    if (separatorIndex <= 0) {
      throw new Error(`Invalid telegram external thread key: ${externalThreadKey}`);
    }

    return {
      chatId: externalThreadKey.slice(0, separatorIndex),
      topicId: externalThreadKey.slice(separatorIndex + 1),
    };
  }

  private buildFallbackTopicName(titleHint: string | null, fallbackSeedText: string): string {
    const candidate = (titleHint?.trim() || fallbackSeedText.trim() || 'Local Agent').replace(/\s+/g, ' ');
    return candidate.slice(0, 128);
  }

  private buildClaimToken(sessionId: string): string {
    return `telegram-${sessionId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private formatMessage(result: TaskResult): string {
    const status = escapeMarkdownV2(result.status);
    const exitCode = result.exit_code?.toString() ?? 'N/A';

    let outputSection: string;
    if (!result.stdout && !result.stderr) {
      outputSection = '_No output_';
    } else {
      let snippet = result.stdout || result.stderr;
      let truncated = false;
      if (snippet.length > MAX_MESSAGE_CHARS) {
        snippet = snippet.substring(0, MAX_MESSAGE_CHARS);
        truncated = true;
      }
      outputSection = '```\n' + snippet + (truncated ? '\n[truncated]' : '') + '\n```';
    }

    return [
      `*Job* \`${result.job_id}\` \\(Task \`${result.task_id}\`\\) — *${status}*`,
      `*Exit code:* \`${exitCode}\``,
      `*Output:*`,
      outputSection,
    ].join('\n');
  }
}
