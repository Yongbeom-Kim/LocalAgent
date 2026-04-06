import {
  formatTelegramPromptHistory,
  type TaskExecutorType,
  type TelegramHistoryRepository,
} from '@local-agent/shared';
import type { ThreadContextResult } from './thread-context-fetcher';

type TelegramHistoryReader = Pick<
  TelegramHistoryRepository,
  'getTelegramThreadByTopic' | 'listTelegramMessagesForTopic'
>;

export class TelegramThreadContextFetcher {
  constructor(private readonly telegramHistoryRepository: TelegramHistoryReader) {}

  async fetchThreadContext(chatId: string, topicId: string): Promise<ThreadContextResult> {
    const thread = await this.telegramHistoryRepository.getTelegramThreadByTopic(chatId, topicId);
    if (!thread) {
      return notThreadResult();
    }

    const messages = await this.telegramHistoryRepository.listTelegramMessagesForTopic(chatId, topicId);
    const threadContext = formatTelegramPromptHistory(messages);

    return {
      kind: 'thread',
      threadContext: threadContext.length > 0 ? threadContext : null,
      inheritedTaskType: thread.taskType,
      inheritedSessionId: thread.sessionId,
      inheritedExecutor: normalizeExecutor(thread.executor),
      inheritedExecutorModel: thread.executorModel,
    };
  }
}

function normalizeExecutor(executor: string): TaskExecutorType | null {
  return executor === 'claude' || executor === 'cursor' || executor === 'ttcodex'
    ? executor
    : null;
}

function notThreadResult(): ThreadContextResult {
  return {
    kind: 'not_thread',
    threadContext: null,
    inheritedTaskType: null,
    inheritedSessionId: null,
    inheritedExecutor: null,
    inheritedExecutorModel: null,
  };
}
