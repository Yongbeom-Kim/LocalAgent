import { asc, eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { LarkInboundEnvelope } from '../types';
import { larkMessagesTable, larkThreadsTable, type SqliteSchema } from './schema';

const DEFAULT_AUDIT_ONLY_TASK_TYPE = 'unknown';
const DEFAULT_AUDIT_ONLY_STATUS = 'audit_only';
const DEFAULT_EXECUTOR = 'claude';
const DEFAULT_EXECUTOR_MODEL = 'sonnet';

export interface RecordInboundAuditMessageParams {
  envelope: LarkInboundEnvelope;
}

export interface UpsertInboundLarkMessageParams {
  rootMessageId: string;
  threadId: string | null;
  sessionId: string;
  source: string;
  chatType: string | null;
  taskType: string;
  executor: string;
  executorModel: string;
  status: string;
  threadCreatedAtMs: number;
  threadUpdatedAtMs: number;
  message: {
    messageId: string;
    messageType: string;
    rawContent: string;
    normalizedText: string | null;
    metadataJson: string | null;
    createdAtMs: number;
  };
}

export interface RecordOutboundLarkMessageParams {
  messageId: string;
  source: string;
  rootMessageId: string;
  sessionId: string;
  threadId: string | null;
  messageType: string;
  rawContent: string;
  normalizedText: string | null;
  metadataJson: string | null;
  createdAtMs: number;
}

export interface MarkLarkThreadNewInstanceParams {
  sessionId: string;
  executor: string;
  executorModel: string;
  updatedAtMs: number;
}

export interface UpsertLarkThreadStateParams {
  rootMessageId: string;
  threadId: string | null;
  sessionId: string;
  source: string;
  chatType: string | null;
  taskType: string;
  executor: string;
  executorModel: string;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number | null;
}

export interface LarkThreadRow {
  rootMessageId: string;
  threadId: string | null;
  sessionId: string;
  source: string;
  chatType: string | null;
  taskType: string;
  executor: string;
  executorModel: string;
  status: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs: number | null;
}

export interface LarkMessageRow {
  messageId: string;
  source: string;
  rootMessageId: string;
  sessionId: string;
  threadId: string | null;
  direction: string;
  senderType: string;
  messageType: string;
  rawContent: string;
  normalizedText: string | null;
  metadataJson: string | null;
  createdAtMs: number;
}

export type LarkPhaseReactionAction = 'set' | 'clear';

export interface LarkPhaseReactionAttempt {
  phase: string;
  action: LarkPhaseReactionAction;
  ok: boolean;
  at: string;
  event_id?: string;
  error?: string;
}

export class LarkHistoryRepository {
  constructor(private readonly db: LibSQLDatabase<SqliteSchema>) {}

  async upsertInboundLarkMessage(params: UpsertInboundLarkMessageParams): Promise<void> {
    const metadata = this.parseMetadata(params.message.metadataJson);
    const envelope = {
      platform: 'lark' as const,
      schema_version: 1 as const,
      message_id: params.message.messageId,
      root_message_id: params.rootMessageId,
      thread_id: params.threadId,
      chat_type: params.chatType ?? 'unknown',
      sender_open_id:
        typeof metadata.sender_open_id === 'string' && metadata.sender_open_id.length > 0
          ? metadata.sender_open_id
          : 'unknown',
      sender_type: 'user',
      message_type: params.message.messageType,
      raw_content: params.message.rawContent,
      mentions: Array.isArray(metadata.mentions)
        ? metadata.mentions.filter((entry): entry is { key: string; name: string; open_id: string } => {
            if (!this.isObject(entry)) {
              return false;
            }
            return (
              typeof entry.key === 'string' &&
              typeof entry.name === 'string' &&
              typeof entry.open_id === 'string'
            );
          })
        : [],
      occurred_at_ms: params.message.createdAtMs,
      ...(params.message.normalizedText !== null
        ? {
            is_normalizable: true as const,
            normalized_text: params.message.normalizedText,
          }
        : { is_normalizable: false as const }),
    };

    await this.recordInboundAuditMessage({ envelope });
    await this.upsertLarkThreadState({
      rootMessageId: params.rootMessageId,
      threadId: params.threadId,
      sessionId: params.sessionId,
      source: params.source,
      chatType: params.chatType,
      taskType: params.taskType,
      executor: params.executor,
      executorModel: params.executorModel,
      status: params.status,
      createdAtMs: params.threadCreatedAtMs,
      updatedAtMs: params.threadUpdatedAtMs,
      endedAtMs: null,
    });

    if (params.message.metadataJson !== null) {
      await this.db
        .update(larkMessagesTable)
        .set({ metadataJson: params.message.metadataJson })
        .where(eq(larkMessagesTable.messageId, params.message.messageId));
    }
  }

  async recordInboundAuditMessage(params: RecordInboundAuditMessageParams): Promise<boolean> {
    const { envelope } = params;
    const metadataJson = JSON.stringify({
      platform: envelope.platform,
      schema_version: envelope.schema_version,
      sender_open_id: envelope.sender_open_id,
      mentions: envelope.mentions,
    });

    return this.db.transaction(async (tx) => {
      const existingMessage = await tx
        .select({ messageId: larkMessagesTable.messageId })
        .from(larkMessagesTable)
        .where(eq(larkMessagesTable.messageId, envelope.message_id))
        .get();

      if (existingMessage) {
        return false;
      }

      await tx
        .insert(larkThreadsTable)
        .values({
          rootMessageId: envelope.root_message_id,
          threadId: envelope.thread_id ?? null,
          sessionId: envelope.root_message_id,
          source: 'lark',
          chatType: envelope.chat_type,
          taskType: DEFAULT_AUDIT_ONLY_TASK_TYPE,
          executor: DEFAULT_EXECUTOR,
          executorModel: DEFAULT_EXECUTOR_MODEL,
          status: DEFAULT_AUDIT_ONLY_STATUS,
          createdAtMs: envelope.occurred_at_ms,
          updatedAtMs: envelope.occurred_at_ms,
          endedAtMs: null,
        })
        .onConflictDoUpdate({
          target: larkThreadsTable.rootMessageId,
          set: {
            threadId: sql`COALESCE(excluded.thread_id, ${larkThreadsTable.threadId})`,
            chatType: sql`COALESCE(excluded.chat_type, ${larkThreadsTable.chatType})`,
            updatedAtMs: sql`CASE
              WHEN ${larkThreadsTable.status} = ${DEFAULT_AUDIT_ONLY_STATUS}
                THEN MAX(${larkThreadsTable.updatedAtMs}, excluded.updated_at_ms)
              ELSE ${larkThreadsTable.updatedAtMs}
            END`,
          },
        });

      await tx.insert(larkMessagesTable).values({
        messageId: envelope.message_id,
        source: 'lark',
        rootMessageId: envelope.root_message_id,
        sessionId: envelope.root_message_id,
        threadId: envelope.thread_id ?? null,
        direction: 'inbound',
        senderType: envelope.sender_type,
        messageType: envelope.message_type,
        rawContent: envelope.raw_content,
        normalizedText: envelope.is_normalizable ? envelope.normalized_text : null,
        metadataJson,
        createdAtMs: envelope.occurred_at_ms,
      });

      return true;
    });
  }

  async recordOutboundLarkMessage(params: RecordOutboundLarkMessageParams): Promise<void> {
    await this.db
      .insert(larkMessagesTable)
      .values({
        messageId: params.messageId,
        source: params.source,
        rootMessageId: params.rootMessageId,
        sessionId: params.sessionId,
        threadId: params.threadId,
        direction: 'outbound',
        senderType: 'bot',
        messageType: params.messageType,
        rawContent: params.rawContent,
        normalizedText: params.normalizedText,
        metadataJson: params.metadataJson,
        createdAtMs: params.createdAtMs,
      })
      .onConflictDoNothing({ target: larkMessagesTable.messageId });

    await this.db
      .update(larkThreadsTable)
      .set({
        threadId: sql`COALESCE(${params.threadId}, ${larkThreadsTable.threadId})`,
        updatedAtMs: params.createdAtMs,
      })
      .where(eq(larkThreadsTable.rootMessageId, params.rootMessageId));
  }

  async getLarkThreadByThreadId(threadId: string): Promise<LarkThreadRow | null> {
    if (threadId.length === 0) {
      return null;
    }

    const row = await this.db
      .select()
      .from(larkThreadsTable)
      .where(eq(larkThreadsTable.threadId, threadId))
      .get();

    return row ?? null;
  }

  async getLarkThreadBySessionId(sessionId: string): Promise<LarkThreadRow | null> {
    const row = await this.db
      .select()
      .from(larkThreadsTable)
      .where(eq(larkThreadsTable.sessionId, sessionId))
      .get();

    return row ?? null;
  }

  async getLarkThreadByRootMessageId(rootMessageId: string): Promise<LarkThreadRow | null> {
    const row = await this.db
      .select()
      .from(larkThreadsTable)
      .where(eq(larkThreadsTable.rootMessageId, rootMessageId))
      .get();

    return row ?? null;
  }

  async getLarkMessageByMessageId(messageId: string): Promise<LarkMessageRow | null> {
    const row = await this.db
      .select()
      .from(larkMessagesTable)
      .where(eq(larkMessagesTable.messageId, messageId))
      .get();

    return row ?? null;
  }

  async getLarkMessagesForThread(rootMessageId: string): Promise<LarkMessageRow[]> {
    return this.db
      .select()
      .from(larkMessagesTable)
      .where(eq(larkMessagesTable.rootMessageId, rootMessageId))
      .orderBy(asc(larkMessagesTable.createdAtMs), asc(larkMessagesTable.messageId));
  }

  async markLarkThreadNewInstance(params: MarkLarkThreadNewInstanceParams): Promise<void> {
    await this.db
      .update(larkThreadsTable)
      .set({
        executor: params.executor,
        executorModel: params.executorModel,
        status: 'active',
        updatedAtMs: params.updatedAtMs,
        endedAtMs: null,
      })
      .where(eq(larkThreadsTable.sessionId, params.sessionId));
  }

  async markLarkThreadEnded(sessionId: string, endedAtMs: number): Promise<void> {
    await this.db
      .update(larkThreadsTable)
      .set({
        status: 'ended',
        endedAtMs,
        updatedAtMs: endedAtMs,
      })
      .where(eq(larkThreadsTable.sessionId, sessionId));
  }

  async upsertLarkThreadState(params: UpsertLarkThreadStateParams): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(larkThreadsTable)
        .values({
          rootMessageId: params.rootMessageId,
          threadId: params.threadId,
          sessionId: params.sessionId,
          source: params.source,
          chatType: params.chatType,
          taskType: params.taskType,
          executor: params.executor,
          executorModel: params.executorModel,
          status: params.status,
          createdAtMs: params.createdAtMs,
          updatedAtMs: params.updatedAtMs,
          endedAtMs: params.endedAtMs ?? null,
        })
        .onConflictDoUpdate({
          target: larkThreadsTable.rootMessageId,
          set: {
            threadId: sql`COALESCE(excluded.thread_id, ${larkThreadsTable.threadId})`,
            sessionId: params.sessionId,
            source: params.source,
            chatType: sql`COALESCE(excluded.chat_type, ${larkThreadsTable.chatType})`,
            taskType: params.taskType,
            executor: params.executor,
            executorModel: params.executorModel,
            status: params.status,
            updatedAtMs: params.updatedAtMs,
            endedAtMs: params.endedAtMs ?? null,
          },
        });

      await tx
        .update(larkMessagesTable)
        .set({
          sessionId: params.sessionId,
          threadId: sql`COALESCE(${params.threadId}, ${larkMessagesTable.threadId})`,
        })
        .where(eq(larkMessagesTable.rootMessageId, params.rootMessageId));
    });
  }

  async appendLarkPhaseReactionAttempt(
    messageId: string,
    attempt: LarkPhaseReactionAttempt,
  ): Promise<void> {
    const message = await this.getLarkMessageByMessageId(messageId);
    if (!message) {
      return;
    }

    const metadata = this.parseMetadata(message.metadataJson);
    const phaseReactions = this.parseObject(metadata.phase_reactions);
    const existingAttempts = Array.isArray(phaseReactions.attempts)
      ? phaseReactions.attempts.filter((entry): entry is Record<string, unknown> => this.isObject(entry))
      : [];

    const nextAttempt: Record<string, unknown> = {
      phase: attempt.phase,
      action: attempt.action,
      ok: attempt.ok,
      at: attempt.at,
      ...(attempt.event_id ? { event_id: attempt.event_id } : {}),
      ...(attempt.error ? { error: attempt.error } : {}),
    };

    const attempts = [...existingAttempts, nextAttempt].slice(-20);

    phaseReactions.attempts = attempts;
    if (attempt.ok) {
      phaseReactions.last = {
        phase: attempt.phase,
        applied_at: attempt.at,
        ...(attempt.event_id ? { event_id: attempt.event_id } : {}),
      };
    }

    metadata.phase_reactions = phaseReactions;

    await this.db
      .update(larkMessagesTable)
      .set({ metadataJson: JSON.stringify(metadata) })
      .where(eq(larkMessagesTable.messageId, messageId));
  }

  async deleteLarkRowsBySessionId(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(larkMessagesTable).where(eq(larkMessagesTable.sessionId, sessionId));
      await tx.delete(larkThreadsTable).where(eq(larkThreadsTable.sessionId, sessionId));
    });
  }

  private parseMetadata(metadataJson: string | null): Record<string, unknown> {
    if (!metadataJson) {
      return {};
    }

    try {
      const parsed = JSON.parse(metadataJson);
      return this.parseObject(parsed);
    } catch {
      return {};
    }
  }

  private parseObject(value: unknown): Record<string, unknown> {
    if (!this.isObject(value)) {
      return {};
    }
    return { ...value };
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
