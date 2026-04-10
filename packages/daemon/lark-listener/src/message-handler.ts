import {
  createLogger,
  type LarkHistoryRepository,
} from '@local-agent/shared';
import type { TaskSubmitter } from './adapters/task-submitter';
import type { LarkReactor } from './adapters/lark-reactor';
import type { LarkReplier } from './adapters/lark-replier';
import type { LarkMessageMetadataResolver } from './adapters/lark-message-metadata-resolver';
import { LarkCanonicalTaskBuilder } from './adapters/lark-canonical-task-builder';
import type { LarkSessionResolver } from './adapters/lark-session-resolver';
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
  private readonly canonicalTaskBuilder = new LarkCanonicalTaskBuilder();

  constructor(
    private readonly submitter: TaskSubmitter,
    private readonly reactor: LarkReactor,
    private readonly replier: LarkReplier,
    private readonly dedup: DedupMap,
    private readonly metadataResolver: LarkMessageMetadataResolver,
    private readonly sessionResolver: LarkSessionResolver,
    private readonly larkHistoryRepository?: Pick<LarkHistoryRepository, 'getLarkMessageByMessageId'>,
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

    if (await this.shouldSkipMirroredOrBotMessage(messageId)) {
      logger.info({ message_id: messageId }, 'Skipping mirrored or bot-authored outbound lark message');
      return;
    }

    logger.info(
      { message_id: messageId, message_type: messageType, chat_type: message.chat_type, sender: event.sender.sender_id.open_id },
      'Processing message',
    );

    const threadIdentity = await this.metadataResolver.resolve(messageId);
    const built = this.canonicalTaskBuilder.build(event, threadIdentity);
    const resolved = await this.sessionResolver.resolve(built);

    if (resolved.kind === 'duplicate') {
      logger.info({ message_id: messageId }, 'Duplicate Lark inbound after persistence check');
      return;
    }

    if (resolved.kind === 'rejected') {
      logger.warn({ message_id: messageId, reason: resolved.reason }, 'Rejected Lark message during canonical resolution');
      await this.replier.replyEnqueueFailure(messageId);
      return;
    }

    const taskId = await this.submitter.submit(
      resolved.task.taskType,
      resolved.task.payload,
      {
        sessionId: resolved.task.sessionId,
        contextRef: resolved.task.contextRef,
      },
      resolved.task.taskSource,
      resolved.task.executor,
      resolved.task.executorModel,
    );
    if (!taskId) {
      logger.error({ message_id: messageId }, 'Failed to enqueue task');
      await this.replier.replyEnqueueFailure(messageId);
      return;
    }

    logger.info({ message_id: messageId, task_id: taskId, task_type: resolved.task.taskType }, 'Task enqueued');
    await this.reactor.react(messageId);
  }

  private async shouldSkipMirroredOrBotMessage(messageId: string): Promise<boolean> {
    if (!this.larkHistoryRepository) {
      return false;
    }

    const message = await this.larkHistoryRepository.getLarkMessageByMessageId(messageId);
    if (!message || message.direction !== 'outbound' || message.senderType !== 'bot') {
      return false;
    }

    if (!message.metadataJson) {
      return true;
    }

    try {
      const metadata = JSON.parse(message.metadataJson) as {
        mirror_origin?: string;
        mirrored_by?: string;
      };
      return metadata.mirrored_by === 'local-agent' || typeof metadata.mirror_origin === 'string';
    } catch {
      return true;
    }
  }
}
