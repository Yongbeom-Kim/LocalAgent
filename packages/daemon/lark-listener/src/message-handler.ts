import { createLogger, type TaskSource, extractLarkMessageContent } from '@local-agent/shared';
import type { TaskSubmitter } from './adapters/task-submitter';
import type { LarkReactor } from './adapters/lark-reactor';
import type { LarkReplier } from './adapters/lark-replier';
import type { DedupMap } from './services/dedup';

const logger = createLogger('lark-listener:handler');
const USAGE_HINT = 'Usage: /task <type> <executor> <model> <payload> or /end (in a thread)';

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

type ParsedSubmit =
  | { kind: 'submit'; taskType: string; taskPayload: string; executor?: string; executorModel?: string }
  | { kind: 'usage' };

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

    logger.info(
      { message_id, message_type, chat_type: message.chat_type, sender: event.sender.sender_id.open_id },
      'Processing message',
    );

    const text = this.extractText(message_type, message.content);
    const parsed = this.parseCommand(text);

    if (parsed.kind === 'usage') {
      await this.replier.reply(message_id, USAGE_HINT);
      return;
    }

    const taskSource: TaskSource = { source: 'lark' as const, message_id: message.message_id };
    const taskId = await this.submitter.submit(
      parsed.taskType,
      parsed.taskPayload,
      taskSource,
      parsed.executor,
      parsed.executorModel,
    );

    if (taskId) {
      logger.info({ message_id, task_id: taskId, task_type: parsed.taskType }, 'Task enqueued');
    } else {
      logger.error({ message_id }, 'Failed to enqueue task');
    }

    await this.reactor.react(message_id);
  }

  private parseCommand(payload: string): ParsedSubmit {
    if (payload === '/gc') {
      return { kind: 'submit', taskType: 'gc', taskPayload: '' };
    }

    if (payload === '/new') {
      return { kind: 'submit', taskType: 'new_instance', taskPayload: '' };
    }

    if (payload.startsWith('/new ') || payload.startsWith('/new\n')) {
      const rest = payload.slice('/new'.length).trim();
      const args = rest.split(/\s+/);

      if (args.length === 2) {
        return {
          kind: 'submit',
          taskType: 'new_instance',
          taskPayload: '',
          executor: args[0],
          executorModel: args[1],
        };
      }

      return { kind: 'usage' };
    }

    if (payload === '/end') {
      return { kind: 'submit', taskType: 'cleanup', taskPayload: '' };
    }

    if (payload.startsWith('/end ') || payload.startsWith('/end\n')) {
      return { kind: 'usage' };
    }

    if (payload === '/task' || payload.startsWith('/task ') || payload.startsWith('/task\n')) {
      const taskParse = this.parseTaskCommand(payload);
      if (taskParse === null) {
        return { kind: 'usage' };
      }

      return {
        kind: 'submit',
        taskType: taskParse.taskType,
        taskPayload: taskParse.taskPayload,
        executor: taskParse.executor,
        executorModel: taskParse.executorModel,
      };
    }

    if (payload.startsWith('/task')) {
      return { kind: 'usage' };
    }

    if (payload.startsWith('/new') || payload.startsWith('/end') || payload.startsWith('/gc')) {
      return { kind: 'usage' };
    }

    return {
      kind: 'submit',
      taskType: 'thread_reply',
      taskPayload: payload,
    };
  }

  private parseTaskCommand(text: string): {
    taskType: string;
    taskPayload: string;
    executor: string;
    executorModel: string;
  } | null {
    const firstNl = text.indexOf('\n');
    const firstLine = firstNl === -1 ? text : text.substring(0, firstNl);
    const restAfterFirstLine = firstNl === -1 ? '' : text.substring(firstNl + 1);
    if (!firstLine.startsWith('/task ')) {
      return null;
    }

    const afterCmd = firstLine.slice('/task'.length).trimStart();
    const parsed = /^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(afterCmd);
    if (!parsed) {
      return null;
    }

    const [, taskType, executor, executorModel, payloadStart] = parsed;
    const taskPayload = restAfterFirstLine ? `${payloadStart}\n${restAfterFirstLine}` : payloadStart;

    return { taskType, taskPayload, executor, executorModel };
  }

  private extractText(messageType: string, content: string): string {
    return extractLarkMessageContent(messageType, content);
  }
}
