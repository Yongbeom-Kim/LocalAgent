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

// MarkdownV2 special chars that must be escaped outside code blocks
const MARKDOWNV2_ESCAPE_REGEX = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWNV2_ESCAPE_REGEX, '\\$1');
}

export class TelegramNotifier {
  private readonly apiBase: string;

  constructor(
    private readonly botToken: string,
    private readonly forumGroupId: string,
    private readonly telegramHistoryRepository?: Pick<
      TelegramHistoryRepository,
      | 'getTelegramThreadBySessionId'
      | 'getTelegramThreadByTopic'
      | 'listTelegramMessagesForTopic'
      | 'recordOutboundTelegramMessage'
      | 'upsertTelegramThreadState'
      | 'markTelegramThreadEnded'
      | 'deleteTelegramRowsBySessionId'
    >,
    private readonly sessionBridgeRepository?: Pick<
      SessionBridgeRepository,
      'getBridgeBySessionId' | 'getBridgeByTelegramTopic' | 'markBridgeEnded' | 'deleteBridgeBySessionId'
    >,
    private readonly sessionRepository?: Pick<
      SessionRepository,
      'markSessionEnded' | 'deleteSessionById'
    >,
    private readonly sessionPlatformLinkRepository?: Pick<
      SessionPlatformLinkRepository,
      'markLinksEnded' | 'deleteLinksBySessionId'
    >,
  ) {
    this.apiBase = `${TELEGRAM_API_BASE}${botToken}`;
  }

  async validate(): Promise<string> {
    const res = await fetch(`${this.apiBase}/getMe`);
    const data = await res.json() as { ok: boolean; result?: { username: string }; description?: string };

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

    if (!this.telegramHistoryRepository || !destination.topicId || !destination.sessionId) {
      return;
    }

    const thread = await this.telegramHistoryRepository.getTelegramThreadByTopic(destination.chatId, destination.topicId);
    await this.telegramHistoryRepository.upsertTelegramThreadState({
      chatId: destination.chatId,
      topicId: destination.topicId,
      sessionId: destination.sessionId,
      source: 'telegram',
      taskType: thread?.taskType ?? 'status',
      executor: thread?.executor ?? 'claude',
      executorModel: thread?.executorModel ?? 'sonnet',
      status: thread?.status ?? 'active',
      seedMessageId: thread?.seedMessageId,
      statusMessageId: messageId,
      metadataJson: thread?.metadataJson ?? null,
      createdAtMs: thread?.createdAtMs ?? Date.now(),
      updatedAtMs: Date.now(),
      endedAtMs: thread?.endedAtMs ?? null,
    });
  }

  async notifyResult(params: { chatId?: string; topicId?: string; result: TaskResult }): Promise<void> {
    const destination = await this.resolveDestination({
      chatId: params.chatId,
      topicId: params.topicId,
      sessionId: params.result.session_id,
    });

    if (!destination) {
      return;
    }

    const messageId = await this.sendMessageToChat({
      chatId: destination.chatId,
      messageThreadId: destination.topicId ? Number(destination.topicId) : undefined,
      text: this.formatMessage(params.result),
      parseMode: 'MarkdownV2',
    });

    if (!this.telegramHistoryRepository || !destination.topicId || !destination.sessionId) {
      return;
    }

    await this.telegramHistoryRepository.recordOutboundTelegramMessage({
      chatId: destination.chatId,
      topicId: destination.topicId,
      messageId,
      sessionId: destination.sessionId,
      direction: 'outbound',
      senderType: 'bot',
      messageType: 'text',
      rawContent: this.formatMessage(params.result),
      normalizedText: this.formatMessage(params.result),
      metadataJson: JSON.stringify({ event_kind: 'result', result_id: params.result.result_id }),
      createdAtMs: Date.now(),
    });

    if (params.result.task_type === 'cleanup') {
      await this.cleanupTerminalSessionRows(destination.sessionId, Date.now());
    }
  }

  private async cleanupTerminalSessionRows(sessionId: string, endedAtMs: number): Promise<void> {
    await this.sessionRepository?.markSessionEnded(sessionId, endedAtMs);
    await this.sessionPlatformLinkRepository?.markLinksEnded(sessionId, endedAtMs);
    await this.telegramHistoryRepository?.markTelegramThreadEnded(sessionId, endedAtMs);

    if (!this.sessionBridgeRepository) {
      await this.telegramHistoryRepository?.deleteTelegramRowsBySessionId(sessionId);
      await this.sessionPlatformLinkRepository?.deleteLinksBySessionId(sessionId);
      await this.sessionRepository?.deleteSessionById(sessionId);
      return;
    }

    const bridge = await this.sessionBridgeRepository.getBridgeBySessionId(sessionId);
    if (bridge) {
      await this.sessionBridgeRepository.markBridgeEnded(sessionId, endedAtMs);
      await this.sessionBridgeRepository.deleteBridgeBySessionId(sessionId);
    }

    await this.telegramHistoryRepository?.deleteTelegramRowsBySessionId(sessionId);
    await this.sessionPlatformLinkRepository?.deleteLinksBySessionId(sessionId);
    await this.sessionRepository?.deleteSessionById(sessionId);
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

    const data = await res.json() as { ok: boolean; description?: string; result?: { message_id?: number } };

    if (!data.ok) {
      throw new Error(`Telegram sendMessage failed: ${data.description ?? 'unknown error'}`);
    }

    return String(data.result?.message_id ?? `telegram_outbound_${Date.now()}`);
  }

  private async resolveDestination(params: {
    chatId?: string;
    topicId?: string;
    sessionId?: string;
  }): Promise<{ chatId: string; topicId?: string; sessionId?: string } | null> {
    if (params.chatId) {
      return {
        chatId: params.chatId,
        topicId: params.topicId,
        sessionId: params.sessionId,
      };
    }

    if (!params.sessionId || !this.sessionBridgeRepository) {
      return params.sessionId
        ? { chatId: this.forumGroupId, sessionId: params.sessionId }
        : null;
    }

    const bridge = await this.sessionBridgeRepository.getBridgeBySessionId(params.sessionId);
    if (!bridge) {
      return { chatId: this.forumGroupId, sessionId: params.sessionId };
    }

    return {
      chatId: bridge.telegramChatId,
      topicId: bridge.telegramTopicId,
      sessionId: params.sessionId,
    };
  }

  private formatMessage(result: TaskResult): string {
    // Only escape text outside code spans/blocks — inline code renders literally
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
      // Code blocks don't need escaping in MarkdownV2
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
