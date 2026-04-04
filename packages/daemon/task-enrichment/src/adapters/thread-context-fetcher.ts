import {
  formatLarkPromptHistory,
  type LarkHistoryRepository,
  type LarkMessageRow,
  type TaskExecutorType,
} from '@local-agent/shared';

const NEW_INSTANCE_MARKER = 'New session instance started.';

export type ThreadContextResult =
  | {
      kind: 'thread';
      threadContext: string | null;
      inheritedTaskType: string | null;
      inheritedSessionId: string | null;
      inheritedExecutor: TaskExecutorType | null;
      inheritedExecutorModel: string | null;
    }
  | {
      kind: 'not_thread';
      threadContext: null;
      inheritedTaskType: null;
      inheritedSessionId: null;
      inheritedExecutor: null;
      inheritedExecutorModel: null;
    }
  | {
      kind: 'error';
      reason: string;
      threadContext: null;
      inheritedTaskType: null;
      inheritedSessionId: null;
      inheritedExecutor: null;
      inheritedExecutorModel: null;
    };

type HistoryRepositoryReader = Pick<
  LarkHistoryRepository,
  'getLarkMessageByMessageId' | 'getLarkThreadByRootMessageId' | 'getLarkMessagesForThread'
>;

export class ThreadContextFetcher {
  constructor(private readonly larkHistoryRepository: HistoryRepositoryReader) {}

  async fetchThreadContext(
    messageId: string,
    _validTaskTypes?: Set<string>,
  ): Promise<ThreadContextResult> {
    try {
      const sourceMessage = await this.larkHistoryRepository.getLarkMessageByMessageId(messageId);
      if (!sourceMessage) {
        return this.errorResult(`Failed to recover thread state for message ${messageId}.`);
      }

      if (sourceMessage.messageId === sourceMessage.rootMessageId) {
        return notThreadResult();
      }

      const thread = await this.larkHistoryRepository.getLarkThreadByRootMessageId(
        sourceMessage.rootMessageId,
      );
      if (!thread) {
        return this.errorResult(
          `Failed to recover thread state for root message ${sourceMessage.rootMessageId}.`,
        );
      }

      const messages = await this.larkHistoryRepository.getLarkMessagesForThread(
        sourceMessage.rootMessageId,
      );

      const fencedMessages = applyNewInstanceFence(messages);
      const historyRows = fencedMessages.filter((row) => row.messageId !== messageId);
      const threadContext = formatLarkPromptHistory(historyRows);

      return {
        kind: 'thread',
        threadContext: threadContext.length > 0 ? threadContext : null,
        inheritedTaskType: thread.taskType,
        inheritedSessionId: thread.sessionId,
        inheritedExecutor: normalizeExecutor(thread.executor),
        inheritedExecutorModel: thread.executorModel,
      };
    } catch (error) {
      return this.errorResult(
        error instanceof Error
          ? `Failed to recover thread state: ${error.message}`
          : 'Failed to recover thread state.',
      );
    }
  }

  private errorResult(reason: string): ThreadContextResult {
    return {
      kind: 'error',
      reason,
      threadContext: null,
      inheritedTaskType: null,
      inheritedSessionId: null,
      inheritedExecutor: null,
      inheritedExecutorModel: null,
    };
  }
}

function applyNewInstanceFence(messages: LarkMessageRow[]): LarkMessageRow[] {
  let fenceIndex = -1;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isNewInstanceReply(messages[index])) {
      fenceIndex = index;
      break;
    }
  }

  return fenceIndex >= 0 ? messages.slice(fenceIndex) : messages;
}

function isNewInstanceReply(row: LarkMessageRow): boolean {
  if (row.direction !== 'outbound' || row.senderType !== 'bot') {
    return false;
  }

  if (row.metadataJson) {
    try {
      const parsed = JSON.parse(row.metadataJson) as { event_kind?: string };
      if (parsed.event_kind === 'new_instance_reply') {
        return true;
      }
    } catch {
      // Ignore malformed metadata and fall back to text detection.
    }
  }

  const text = row.normalizedText ?? row.rawContent;
  return text.includes(NEW_INSTANCE_MARKER);
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
