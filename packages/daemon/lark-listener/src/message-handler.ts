import {
  createLogger,
  type TaskSource,
  LARK_INBOUND_SCHEMA_VERSION_V1,
  type LarkInboundEnvelope,
  normalizeLarkInboundContent,
} from '@local-agent/shared';
import type { TaskSubmitter } from './adapters/task-submitter';
import type { LarkReactor } from './adapters/lark-reactor';
import type { LarkReplier } from './adapters/lark-replier';
import type { LarkMessageMetadataResolver, ResolvedThreadIdentity } from './adapters/lark-message-metadata-resolver';
import type { DedupMap } from './services/dedup';

const logger = createLogger('lark-listener:handler');

interface LarkMessageEvent {
  event_time?: string;
  timestamp?: string;
  create_time?: string;
  sender: {
    sender_id: { open_id: string };
    sender_type: string;
  };
  message: {
    message_id?: string;
    chat_type: string;
    message_type: string;
    content?: string;
    mentions?: Array<{ key: string; name: string; id: { open_id: string } }>;
  };
}

export type { LarkMessageMetadataResolver };

export class MessageHandler {
  constructor(
    private readonly submitter: TaskSubmitter,
    private readonly reactor: LarkReactor,
    private readonly replier: LarkReplier,
    private readonly dedup: DedupMap,
    private readonly metadataResolver: LarkMessageMetadataResolver,
  ) {}

  async handle(event: LarkMessageEvent): Promise<void> {
    const { message } = event;
    const messageId = message.message_id;
    const messageType = message.message_type;
    const rawContent = message.content;

    if (!messageId || !rawContent) {
      logger.warn(
        {
          has_message_id: Boolean(messageId),
          has_content: Boolean(rawContent),
          message_type: messageType,
        },
        'Skipping enqueue: cannot construct minimally valid inbound envelope',
      );

      if (messageId) {
        await this.replier.replyEnqueueFailure(messageId);
      }
      return;
    }

    if (this.dedup.has(messageId)) {
      logger.debug({ message_id: messageId }, 'Duplicate message, skipping');
      return;
    }

    this.dedup.add(messageId);

    logger.info(
      { message_id: messageId, message_type: messageType, chat_type: message.chat_type, sender: event.sender.sender_id.open_id },
      'Processing message',
    );

    const threadIdentity = await this.metadataResolver.resolve(messageId);

    const envelope = this.buildEnvelope(event, threadIdentity);
    const taskSource: TaskSource = { source: 'lark', message_id: messageId };

    const taskId = await this.submitter.submit('lark_inbound', JSON.stringify(envelope), taskSource);
    if (!taskId) {
      logger.error({ message_id: messageId }, 'Failed to enqueue task');
      await this.replier.replyEnqueueFailure(messageId);
      return;
    }

    logger.info({ message_id: messageId, task_id: taskId, task_type: 'lark_inbound' }, 'Task enqueued');
    await this.reactor.react(messageId);
  }

  private buildEnvelope(event: LarkMessageEvent, threadIdentity: ResolvedThreadIdentity): LarkInboundEnvelope {
    const messageId = event.message.message_id as string;
    const rawContent = event.message.content as string;
    const messageType = event.message.message_type;
    const occurredAtMs = this.extractOccurredAtMs(event) ?? Date.now();

    const mentions = (event.message.mentions ?? [])
      .filter((m) => Boolean(m?.id?.open_id))
      .map((m) => ({
        key: m.key,
        name: m.name,
        open_id: m.id.open_id,
      }));

    const normalized = normalizeLarkInboundContent(messageType, rawContent);
    const base = {
      platform: 'lark' as const,
      schema_version: LARK_INBOUND_SCHEMA_VERSION_V1,
      message_id: messageId,
      root_message_id: threadIdentity.rootMessageId,
      thread_id: threadIdentity.threadId,
      chat_type: event.message.chat_type,
      sender_open_id: event.sender.sender_id.open_id,
      sender_type: event.sender.sender_type,
      message_type: messageType,
      raw_content: rawContent,
      mentions,
      occurred_at_ms: occurredAtMs,
    };

    if (normalized.is_normalizable) {
      return {
        ...base,
        is_normalizable: true,
        normalized_text: normalized.normalized_text,
      };
    }

    return {
      ...base,
      is_normalizable: false,
    };
  }

  private extractOccurredAtMs(event: LarkMessageEvent): number | null {
    const candidates = [event.event_time, event.timestamp, event.create_time];
    for (const c of candidates) {
      if (!c) continue;
      const n = Number(c);
      if (!Number.isFinite(n)) continue;
      // Heuristic: allow seconds or ms.
      return n < 10_000_000_000 ? n * 1000 : n;
    }
    return null;
  }
}
