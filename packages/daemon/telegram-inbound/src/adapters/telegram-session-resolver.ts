import {
  classifyTelegramInboundEnvelope,
  generateSessionId,
  SessionPlatformLinkRepository,
  SessionRepository,
  type TaskContextRef,
  type TaskSource,
  type TelegramHistoryRepository,
  type TelegramInboundEnvelope,
} from '@local-agent/shared';

export interface ResolvedTelegramCanonicalTask {
  taskType: string;
  payload: string;
  taskSource: TaskSource;
  sessionId: string;
  contextRef: TaskContextRef;
  executor?: string;
  executorModel?: string;
}

export type TelegramSessionResolutionResult =
  | { kind: 'accepted'; task: ResolvedTelegramCanonicalTask }
  | { kind: 'duplicate'; reason: string }
  | { kind: 'rejected'; reason: string };

type TelegramHistoryWriter = Pick<
  TelegramHistoryRepository,
  | 'getTelegramThreadByTopic'
  | 'getTelegramMessageByChatAndMessageId'
  | 'recordInboundTelegramMessage'
  | 'upsertTelegramThreadState'
>;

function buildExternalThreadKey(chatId: string, topicId: string): string {
  return `${chatId}:${topicId}`;
}

export class TelegramSessionResolver {
  constructor(
    private readonly telegramHistoryRepository: TelegramHistoryWriter,
    private readonly sessionRepository: SessionRepository,
    private readonly sessionPlatformLinkRepository: SessionPlatformLinkRepository,
  ) {}

  async resolve(envelope: TelegramInboundEnvelope): Promise<TelegramSessionResolutionResult> {
    const existingMessage = await this.telegramHistoryRepository.getTelegramMessageByChatAndMessageId(
      envelope.chat_id,
      envelope.message_id,
    );
    if (existingMessage) {
      return { kind: 'duplicate', reason: 'Duplicate inbound Telegram delivery.' };
    }

    const externalThreadKey = buildExternalThreadKey(envelope.chat_id, envelope.topic_id);
    const existingThread = await this.telegramHistoryRepository.getTelegramThreadByTopic(
      envelope.chat_id,
      envelope.topic_id,
    );
    const existingLinks = await this.sessionPlatformLinkRepository.listLinksByPlatformAndExternalThreadKey(
      'telegram',
      externalThreadKey,
    );
    const existingLink = existingLinks[0] ?? null;
    const classification = classifyTelegramInboundEnvelope(
      {
        task_id: `telegram:${envelope.chat_id}:${envelope.message_id}`,
        task_type: 'telegram_inbound',
        payload: envelope.is_normalizable ? envelope.normalized_text : envelope.raw_content,
        submitted_at: new Date(envelope.occurred_at_ms).toISOString(),
      },
      envelope,
      Boolean(existingLink ?? existingThread),
    );

    let sessionId = existingThread?.sessionId ?? existingLink?.sessionId ?? null;
    if (!sessionId && classification.kind === 'accepted' && classification.shouldMaterializeRootState) {
      sessionId = generateSessionId();
    }
    if (!sessionId) {
      sessionId = `telegram-topic:${externalThreadKey}`;
    }

    await this.telegramHistoryRepository.recordInboundTelegramMessage({
      chatId: envelope.chat_id,
      topicId: envelope.topic_id,
      messageId: envelope.message_id,
      sessionId,
      direction: 'inbound',
      senderType: 'user',
      messageType: envelope.message_type,
      rawContent: envelope.raw_content,
      normalizedText: envelope.is_normalizable ? envelope.normalized_text : null,
      metadataJson: JSON.stringify({ sender_id: envelope.sender_id }),
      createdAtMs: envelope.occurred_at_ms,
    });

    if (classification.kind === 'rejected') {
      return { kind: 'rejected', reason: classification.reason };
    }

    const taskType = classification.task.task_type;
    const executor = classification.task.executor ?? existingThread?.executor ?? null;
    const executorModel = classification.task.executor_model ?? existingThread?.executorModel ?? null;

    await this.sessionRepository.upsertSession({
      sessionId,
      taskType: classification.shouldMaterializeRootState ? taskType : existingThread?.taskType ?? taskType,
      executor,
      executorModel,
      status: 'active',
      createdAtMs: existingThread?.createdAtMs ?? envelope.occurred_at_ms,
      updatedAtMs: envelope.occurred_at_ms,
      endedAtMs: null,
    });
    await this.sessionPlatformLinkRepository.upsertLink({
      sessionId,
      platform: 'telegram',
      externalThreadKey,
      createdAtMs: existingLink?.createdAtMs ?? existingThread?.createdAtMs ?? envelope.occurred_at_ms,
      updatedAtMs: envelope.occurred_at_ms,
      endedAtMs: null,
    });
    await this.telegramHistoryRepository.upsertTelegramThreadState({
      chatId: envelope.chat_id,
      topicId: envelope.topic_id,
      sessionId,
      source: 'telegram',
      taskType: classification.shouldMaterializeRootState ? taskType : existingThread?.taskType ?? taskType,
      executor: executor ?? 'claude',
      executorModel: executorModel ?? 'sonnet',
      status: 'active',
      seedMessageId: existingThread?.seedMessageId ?? envelope.message_id,
      createdAtMs: existingThread?.createdAtMs ?? envelope.occurred_at_ms,
      updatedAtMs: envelope.occurred_at_ms,
      endedAtMs: null,
    });

    return {
      kind: 'accepted',
      task: {
        taskType,
        payload: classification.task.payload,
        taskSource: {
          source: 'telegram',
          chat_id: envelope.chat_id,
          topic_id: envelope.topic_id,
          message_id: envelope.message_id,
        },
        sessionId,
        contextRef: { platform: 'telegram', root_key: externalThreadKey },
        ...(classification.task.executor ? { executor: classification.task.executor } : {}),
        ...(classification.task.executor_model ? { executorModel: classification.task.executor_model } : {}),
      },
    };
  }
}
