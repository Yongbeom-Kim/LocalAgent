import {
  generateSessionId,
  SessionPlatformLinkRepository,
  SessionRepository,
  type LarkHistoryRepository,
  type LarkInboundClassificationResult,
  type LarkInboundEnvelope,
  type TaskContextRef,
  type TaskSource,
} from '@local-agent/shared';

export interface ResolvedLarkCanonicalTask {
  taskType: string;
  payload: string;
  taskSource: TaskSource;
  sessionId: string;
  contextRef: TaskContextRef;
  executor?: string;
  executorModel?: string;
}

export type LarkSessionResolutionResult =
  | { kind: 'accepted'; task: ResolvedLarkCanonicalTask }
  | { kind: 'duplicate'; reason: string }
  | { kind: 'rejected'; reason: string; sessionId?: string };

type LarkHistoryWriter = Pick<
  LarkHistoryRepository,
  | 'recordInboundAuditMessage'
  | 'getLarkThreadByRootMessageId'
  | 'upsertLarkThreadState'
>;

export class LarkSessionResolver {
  constructor(
    private readonly larkHistoryRepository: LarkHistoryWriter,
    private readonly sessionRepository: SessionRepository,
    private readonly sessionPlatformLinkRepository: SessionPlatformLinkRepository,
  ) {}

  async resolve(params: {
    envelope: LarkInboundEnvelope;
    classification: LarkInboundClassificationResult;
  }): Promise<LarkSessionResolutionResult> {
    const { envelope, classification } = params;
    const inserted = await this.larkHistoryRepository.recordInboundAuditMessage({ envelope });
    if (!inserted) {
      return { kind: 'duplicate', reason: 'Duplicate inbound Lark delivery.' };
    }

    if (classification.kind === 'rejected') {
      return { kind: 'rejected', reason: classification.reason };
    }

    const existingThread = await this.larkHistoryRepository.getLarkThreadByRootMessageId(envelope.root_message_id);
    const liveThread = existingThread && existingThread.status !== 'audit_only' ? existingThread : null;

    let sessionId = liveThread?.sessionId ?? null;
    if (!sessionId) {
      if (!classification.shouldMaterializeRootState) {
        return {
          kind: 'rejected',
          reason: 'Thread session is not ready yet. Retry after the root message is processed.',
          sessionId: envelope.root_message_id,
        };
      }

      sessionId = generateSessionId();
    }

    const taskType = classification.task.task_type;
    const executor = classification.task.executor ?? liveThread?.executor ?? null;
    const executorModel = classification.task.executor_model ?? liveThread?.executorModel ?? null;

    await this.sessionRepository.upsertSession({
      sessionId,
      taskType: classification.shouldMaterializeRootState ? taskType : (liveThread?.taskType ?? taskType),
      executor,
      executorModel,
      status: 'active',
      createdAtMs: liveThread?.createdAtMs ?? envelope.occurred_at_ms,
      updatedAtMs: envelope.occurred_at_ms,
    });

    await this.sessionPlatformLinkRepository.upsertLink({
      sessionId,
      platform: 'lark',
      externalThreadKey: envelope.root_message_id,
      createdAtMs: liveThread?.createdAtMs ?? envelope.occurred_at_ms,
      updatedAtMs: envelope.occurred_at_ms,
    });

    await this.larkHistoryRepository.upsertLarkThreadState({
      rootMessageId: envelope.root_message_id,
      threadId: envelope.thread_id ?? null,
      sessionId,
      source: 'lark',
      chatType: envelope.chat_type,
      taskType: classification.shouldMaterializeRootState ? taskType : (liveThread?.taskType ?? taskType),
      executor: executor ?? 'claude',
      executorModel: executorModel ?? 'sonnet',
      status: 'active',
      createdAtMs: liveThread?.createdAtMs ?? envelope.occurred_at_ms,
      updatedAtMs: envelope.occurred_at_ms,
    });

    return {
      kind: 'accepted',
      task: {
        taskType,
        payload: classification.task.payload,
        taskSource: { source: 'lark', message_id: envelope.message_id },
        sessionId,
        contextRef: { platform: 'lark', root_key: envelope.root_message_id },
        ...(classification.task.executor ? { executor: classification.task.executor } : {}),
        ...(classification.task.executor_model ? { executorModel: classification.task.executor_model } : {}),
      },
    };
  }
}
