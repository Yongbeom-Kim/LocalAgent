import {
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
      | 'upsertLarkThreadState'
      | 'deleteLarkRowsBySessionId'
    >,
    private readonly tokenProvider: TokenProvider = new LarkTenantTokenProvider(appId, appSecret),
  ) {}

  async notify(result: TaskResult): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.sendNotification(result);
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

    let msgRes: Response;

    if (result.task_source?.source === 'lark') {
      await this.clearBotOwnedPhaseReactionsBeforeReply(result.task_source.message_id, token);

      // Reply in thread to the original Lark message
      msgRes = await fetch(LARK_REPLY_URL(result.task_source.message_id), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: JSON.stringify({ text }),
          reply_in_thread: true,
        }),
      });
    } else {
      // Fallback: send DM to fixed recipient
      msgRes = await fetch(LARK_MESSAGE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: this.recipientId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      });
    }

    const msgData = await msgRes.json() as { code: number; data?: { message_id?: string } };

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
    if (result.task_source?.source !== 'lark' || !result.session_id || !this.larkHistoryRepository) {
      return;
    }

    const sourceMessage = await this.larkHistoryRepository.getLarkMessageByMessageId(result.task_source.message_id);
    const rootMessageId = sourceMessage?.rootMessageId ?? result.task_source.message_id;
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
      await this.larkHistoryRepository.deleteLarkRowsBySessionId(result.session_id);
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
