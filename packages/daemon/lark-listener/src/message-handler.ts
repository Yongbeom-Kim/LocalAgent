import { createLogger, type TaskSource, extractLarkMessageContent } from '@local-agent/shared';
import type { TaskSubmitter } from './adapters/task-submitter';
import type { LarkReactor } from './adapters/lark-reactor';
import type { LarkReplier } from './adapters/lark-replier';
import type { DedupMap } from './services/dedup';

const logger = createLogger('lark-listener:handler');
const USAGE_HINT = 'Usage: /task <type> <payload> or /end (in a thread)';

interface LarkMessageEvent {
  sender: {
    sender_id: { open_id: string };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{ key: string; name: string; id: { open_id: string } }>;
  };
}

export class MessageHandler {
  constructor(
    private readonly submitter: TaskSubmitter,
    private readonly reactor: LarkReactor,
    private readonly replier: LarkReplier,
    private readonly dedup: DedupMap,
  ) {}

  async handle(event: LarkMessageEvent): Promise<void> {
    const { message } = event;
    const { message_id, message_type } = message;

    if (this.dedup.has(message_id)) {
      logger.debug({ message_id }, 'Duplicate message, skipping');
      return;
    }

    this.dedup.add(message_id);

    const payload = this.buildPayload(message_type, message.content);

    logger.info(
      { message_id, message_type, chat_type: message.chat_type, sender: event.sender.sender_id.open_id },
      'Processing message',
    );

    const { taskType, taskPayload, isCommand } = this.parseCommand(payload);

    if (isCommand && taskType === null) {
      await this.replier.reply(message_id, USAGE_HINT);
      return;
    }

    const taskSource: TaskSource = { source: 'lark' as const, message_id: message.message_id };
    const taskId = await this.submitter.submit(taskType ?? 'generic', taskPayload, taskSource);

    if (taskId) {
      logger.info({ message_id, task_id: taskId, task_type: taskType }, 'Task enqueued');
    } else {
      logger.error({ message_id }, 'Failed to enqueue task');
    }

    await this.reactor.react(message_id);
  }

  private parseCommand(payload: string): { taskType: string | null; taskPayload: string; isCommand: boolean } {
    if (payload === '/gc') {
      return { taskType: 'gc', taskPayload: '', isCommand: true };
    }

    if (payload === '/new') {
      return { taskType: 'new_instance', taskPayload: '', isCommand: true };
    }

    if (payload.startsWith('/new ') || payload.startsWith('/new\n')) {
      const rest = payload.slice('/new'.length).trim();
      const args = rest.split(/\s+/);

      if (args.length === 2) {
        return {
          taskType: 'new_instance',
          taskPayload: JSON.stringify({
            executor: args[0],
            executor_model: args[1],
          }),
          isCommand: true,
        };
      }

      return { taskType: null, taskPayload: '', isCommand: true };
    }

    if (payload === '/end') {
      return { taskType: 'cleanup', taskPayload: '', isCommand: true };
    }

    if (payload.startsWith('/end ') || payload.startsWith('/end\n')) {
      return { taskType: null, taskPayload: '', isCommand: true };
    }

    // Must match exactly "/task" followed by space, newline, or end-of-string.
    // This avoids false positives like "/taskforce" or "/tasklist".
    if (!payload.startsWith('/task ') && !payload.startsWith('/task\n') && payload !== '/task') {
      return { taskType: null, taskPayload: payload, isCommand: false };
    }

    const rest = payload.slice('/task'.length).trimStart();

    if (rest === '') {
      return { taskType: null, taskPayload: '', isCommand: true };
    }

    const spaceIndex = rest.indexOf(' ');
    if (spaceIndex === -1) {
      return { taskType: rest, taskPayload: '', isCommand: true };
    }

    const taskType = rest.substring(0, spaceIndex);
    const taskPayload = rest.substring(spaceIndex + 1);
    return { taskType, taskPayload, isCommand: true };
  }

  private buildPayload(messageType: string, content: string): string {
    if (messageType === 'text') {
      return this.extractText(content);
    }

    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(this.buildStructuredPayload(messageType, parsed));
    } catch {
      // If content is not valid JSON, return as-is
      return content;
    }
  }

  private extractText(content: string): string {
    return extractLarkMessageContent('text', content);
  }

  private buildStructuredPayload(
    messageType: string,
    parsed: Record<string, unknown>,
  ): Record<string, unknown> {
    switch (messageType) {
      case 'image':
        return { type: 'image', key: parsed.image_key };
      case 'file':
        return { type: 'file', key: parsed.file_key, name: parsed.file_name };
      case 'audio':
        return { type: 'audio', key: parsed.file_key };
      case 'post':
        return { type: 'post', content: parsed };
      default:
        return { type: messageType, ...parsed };
    }
  }
}
