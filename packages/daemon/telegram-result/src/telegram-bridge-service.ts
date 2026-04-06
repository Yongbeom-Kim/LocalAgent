import {
  SessionBridgeRepository,
  TelegramHistoryRepository,
  type SessionBridgeRow,
} from '@local-agent/shared';
import { TelegramTopicManager } from './adapters/telegram-topic-manager';

export class TelegramBridgeService {
  constructor(
    private readonly forumGroupId: string,
    private readonly topicManager: TelegramTopicManager,
    private readonly telegramHistoryRepository?: Pick<
      TelegramHistoryRepository,
      'upsertTelegramThreadState' | 'getTelegramThreadBySessionId'
    >,
    private readonly sessionBridgeRepository?: Pick<
      SessionBridgeRepository,
      'upsertSessionBridge' | 'getBridgeBySessionId'
    >,
  ) {}

  async ensureTelegramTopicForSession(params: {
    sessionId: string;
    larkRootMessageId: string;
    taskType: string;
    executor: string;
    executorModel: string;
  }): Promise<SessionBridgeRow | null> {
    const existing = await this.sessionBridgeRepository?.getBridgeBySessionId(params.sessionId);
    if (existing) {
      return existing;
    }

    if (!this.telegramHistoryRepository || !this.sessionBridgeRepository) {
      return null;
    }

    const existingThread = await this.telegramHistoryRepository.getTelegramThreadBySessionId(params.sessionId);
    const now = Date.now();

    let chatId = this.forumGroupId;
    let topicId: string;

    if (existingThread) {
      chatId = existingThread.chatId;
      topicId = existingThread.topicId;
    } else {
      const topic = await this.topicManager.createForumTopic(
        this.forumGroupId,
        `${params.taskType} • ${params.sessionId.slice(0, 8)}`,
      );
      topicId = String(topic.message_thread_id);

      await this.telegramHistoryRepository.upsertTelegramThreadState({
        chatId,
        topicId,
        sessionId: params.sessionId,
        source: 'telegram',
        taskType: params.taskType,
        executor: params.executor,
        executorModel: params.executorModel,
        status: 'active',
        createdAtMs: now,
        updatedAtMs: now,
      });
    }

    await this.sessionBridgeRepository.upsertSessionBridge({
      sessionId: params.sessionId,
      larkRootMessageId: params.larkRootMessageId,
      telegramChatId: chatId,
      telegramTopicId: topicId,
      createdAtMs: now,
      updatedAtMs: now,
    });

    return this.sessionBridgeRepository.getBridgeBySessionId(params.sessionId);
  }
}
