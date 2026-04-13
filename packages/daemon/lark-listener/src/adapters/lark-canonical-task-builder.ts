import {
  classifyLarkInboundEnvelope,
  LARK_INBOUND_SCHEMA_VERSION_V1,
  normalizeLarkInboundContent,
  type LarkInboundClassificationResult,
  type LarkInboundEnvelope,
  type Task,
} from '@local-agent/shared';
import type { ResolvedThreadIdentity } from './lark-message-metadata-resolver';

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

export interface BuiltLarkCanonicalTask {
  envelope: LarkInboundEnvelope;
  classification: LarkInboundClassificationResult;
}

export class LarkCanonicalTaskBuilder {
  build(event: LarkMessageEvent, threadIdentity: ResolvedThreadIdentity): BuiltLarkCanonicalTask {
    const envelope = this.buildEnvelope(event, threadIdentity);
    const baseTask: Task = {
      task_id: `lark:${envelope.message_id}`,
      task_type: 'lark_inbound',
      payload: envelope.is_normalizable ? envelope.normalized_text : envelope.raw_content,
      submitted_at: new Date(envelope.occurred_at_ms).toISOString(),
      session_id: `pending:lark:${envelope.root_message_id}`,
    };

    return {
      envelope,
      classification: classifyLarkInboundEnvelope(baseTask, envelope),
    };
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
      return n < 10_000_000_000 ? n * 1000 : n;
    }
    return null;
  }
}
