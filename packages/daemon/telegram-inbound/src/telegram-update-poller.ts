import {
  TELEGRAM_INBOUND_SCHEMA_VERSION_V1,
  createLogger,
  isValidTelegramTopicTaskSource,
  normalizeTelegramInboundContent,
  type TaskSource,
} from '@local-agent/shared';
import { TelegramPhasePublisher } from './adapters/telegram-phase-publisher';
import type { TelegramSessionResolver } from './adapters/telegram-session-resolver';
import { TelegramTaskSubmitter } from './adapters/telegram-task-submitter';
import { TelegramTopicManager } from './adapters/telegram-topic-manager';

const logger = createLogger('telegram-inbound:update-poller');
const TELEGRAM_INBOUND_TASK_TYPE = 'telegram_inbound';
const NON_FORUM_GROUP_REASON = 'This Telegram group does not support forum topics. Please use a forum-enabled group.';
const MISSING_TOPIC_REASON = 'Telegram messages must be sent inside a forum topic.';

interface TelegramUser {
  id: number;
  is_bot?: boolean;
}

interface TelegramChat {
  id: number;
  type?: string;
  is_forum?: boolean;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  message_thread_id?: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: Array<unknown>;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramUpdatePoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private nextOffset = 0;

  constructor(
    private readonly forumGroupId: string,
    private readonly topicManager: Pick<TelegramTopicManager, 'getUpdates' | 'getChat'>,
    private readonly taskSubmitter: TelegramTaskSubmitter,
    private readonly phasePublisher: TelegramPhasePublisher,
    private readonly sessionResolver: TelegramSessionResolver,
  ) {}

  async pollOnce(): Promise<void> {
    try {
      const updates = await this.topicManager.getUpdates(this.nextOffset);
      for (const update of updates) {
        await this.handleUpdate(update);
        this.nextOffset = Math.max(this.nextOffset, update.update_id + 1);
      }
    } catch (err) {
      logger.error({ err }, 'Telegram update poll error');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs }, 'Starting telegram update poller');
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
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message) {
      return;
    }

    const chatId = String(message.chat.id);
    if (chatId !== this.forumGroupId) {
      return;
    }

    const messageId = String(message.message_id);
    if (this.isBotAuthored(message) || this.isMirroredMessage(message)) {
      return;
    }

    const taskSource: TaskSource = message.message_thread_id
      ? { source: 'telegram', chat_id: chatId, topic_id: String(message.message_thread_id), message_id: messageId }
      : { source: 'telegram', chat_id: chatId, message_id: messageId };

    const chat = await this.topicManager.getChat(chatId);
    if (chat.is_forum !== true) {
      await this.publishSyntheticFailure(taskSource, NON_FORUM_GROUP_REASON);
      return;
    }

    if (!isValidTelegramTopicTaskSource(taskSource)) {
      await this.publishSyntheticFailure(taskSource, MISSING_TOPIC_REASON);
      return;
    }

    const messageType = this.resolveMessageType(message);
    const rawContent = this.extractRawContent(message, messageType);
    const normalized = normalizeTelegramInboundContent(messageType, rawContent);
    const envelope = {
      platform: 'telegram' as const,
      schema_version: TELEGRAM_INBOUND_SCHEMA_VERSION_V1,
      chat_id: chatId,
      topic_id: taskSource.topic_id,
      message_id: messageId,
      sender_id: String(message.from?.id ?? message.sender_chat?.id ?? 'unknown'),
      sender_is_bot: message.from?.is_bot === true,
      message_type: messageType,
      raw_content: rawContent,
      occurred_at_ms: message.date * 1000,
      ...(normalized.is_normalizable
        ? { is_normalizable: true as const, normalized_text: normalized.normalized_text }
        : { is_normalizable: false as const }),
    };

    const resolved = await this.sessionResolver.resolve(envelope);
    if (resolved.kind === 'duplicate') {
      return;
    }
    if (resolved.kind === 'rejected') {
      await this.publishSyntheticFailure(taskSource, resolved.reason);
      return;
    }

    const taskId = await this.taskSubmitter.submit(
      resolved.task.taskType,
      resolved.task.payload,
      resolved.task.taskSource,
      resolved.task.executor,
      resolved.task.executorModel,
      {
        sessionId: resolved.task.sessionId,
        contextRef: resolved.task.contextRef,
      },
    );
    if (!taskId) {
      logger.error({ update_id: update.update_id, message_id: messageId }, 'Failed to submit telegram canonical task');
      return;
    }

    await this.phasePublisher.publishReceived({
      taskId,
      taskType: resolved.task.taskType,
      taskSource: resolved.task.taskSource,
      sessionId: resolved.task.sessionId,
    });
  }

  private async publishSyntheticFailure(taskSource: TaskSource, reason: string): Promise<void> {
    if (taskSource.source !== 'telegram') {
      return;
    }

    const syntheticTaskId = `telegram-reject:${taskSource.chat_id}:${taskSource.message_id}`;
    const syntheticSessionId = `telegram-reject:${taskSource.chat_id}:${'topic_id' in taskSource ? taskSource.topic_id : taskSource.message_id}`;

    await this.phasePublisher.publishCompletedSyntheticFailure({
      taskId: syntheticTaskId,
      taskType: TELEGRAM_INBOUND_TASK_TYPE,
      taskSource,
      sessionId: syntheticSessionId,
      reason,
    });
  }

  private isBotAuthored(message: TelegramMessage): boolean {
    return message.from?.is_bot === true;
  }

  private isMirroredMessage(message: TelegramMessage): boolean {
    return typeof message.text === 'string' && message.text.startsWith('[mirror] ');
  }

  private resolveMessageType(message: TelegramMessage): string {
    if (typeof message.text === 'string') {
      return 'text';
    }
    if (typeof message.caption === 'string' && Array.isArray(message.photo)) {
      return 'photo';
    }
    if (Array.isArray(message.photo)) {
      return 'photo';
    }
    return 'unknown';
  }

  private extractRawContent(message: TelegramMessage, messageType: string): string {
    if (messageType === 'text') {
      return message.text ?? '';
    }
    if (messageType === 'photo') {
      return message.caption ?? '[photo]';
    }
    return '';
  }
}
