import type { Task, TaskSource, TelegramInboundEnvelope } from './types';
import {
  TASK_COMMAND_USAGE,
  formatThreadOnlyCommandMessage,
  formatThreadReplyHelpMessage,
  formatThreadTaskCommandRejectedMessage,
} from './routing-errors';

const NEW_INSTANCE_TASK_TYPE = 'new_instance';
const STATUS_TASK_TYPE = 'status';
const CLEANUP_TASK_TYPE = 'cleanup';
const THREAD_REPLY_TASK_TYPE = 'thread_reply';
const TELEGRAM_INBOUND_TASK_TYPE = 'telegram_inbound';

export const TELEGRAM_ROOT_USAGE_HINT = `Usage: ${TASK_COMMAND_USAGE} or /status, /end (in a topic)`;

export type TelegramInboundClassificationResult =
  | {
      kind: 'accepted';
      task: Task;
      envelope: TelegramInboundEnvelope;
      shouldMaterializeRootState: boolean;
    }
  | {
      kind: 'rejected';
      task: Task;
      reason: string;
    };

export function classifyTelegramInboundEnvelope(
  task: Task,
  envelope: TelegramInboundEnvelope,
  topicMapped: boolean,
): TelegramInboundClassificationResult {
  const taskSource: TaskSource = {
    source: 'telegram',
    chat_id: envelope.chat_id,
    topic_id: envelope.topic_id,
    message_id: envelope.message_id,
  };
  const baseTask = {
    ...task,
    task_source: taskSource,
  };

  if (!envelope.is_normalizable) {
    return {
      kind: 'rejected',
      task: { ...baseTask, task_type: topicMapped ? THREAD_REPLY_TASK_TYPE : TELEGRAM_INBOUND_TASK_TYPE },
      reason: topicMapped ? formatThreadReplyHelpMessage() : TELEGRAM_ROOT_USAGE_HINT,
    };
  }

  const normalizedText = envelope.normalized_text;
  const trimmedText = normalizedText.trim();

  if (!trimmedText.startsWith('/')) {
    if (topicMapped) {
      return {
        kind: 'accepted',
        task: {
          ...baseTask,
          task_type: THREAD_REPLY_TASK_TYPE,
          payload: normalizedText,
          executor: undefined,
          executor_model: undefined,
        },
        envelope,
        shouldMaterializeRootState: false,
      };
    }

    return {
      kind: 'rejected',
      task: { ...baseTask, task_type: TELEGRAM_INBOUND_TASK_TYPE },
      reason: TELEGRAM_ROOT_USAGE_HINT,
    };
  }

  if (trimmedText.startsWith('/task')) {
    if (topicMapped) {
      const parsedType = parseTaskTypeHint(normalizedText);
      return {
        kind: 'rejected',
        task: { ...baseTask, task_type: parsedType ?? TELEGRAM_INBOUND_TASK_TYPE },
        reason: formatThreadTaskCommandRejectedMessage(),
      };
    }

    const parsedTaskCommand = parseRootTaskCommand(normalizedText);
    if (!parsedTaskCommand) {
      return {
        kind: 'rejected',
        task: { ...baseTask, task_type: parseTaskTypeHint(normalizedText) ?? TELEGRAM_INBOUND_TASK_TYPE },
        reason: TELEGRAM_ROOT_USAGE_HINT,
      };
    }

    return {
      kind: 'accepted',
      task: {
        ...baseTask,
        task_type: parsedTaskCommand.taskType,
        payload: parsedTaskCommand.payload,
        executor: parsedTaskCommand.executor,
        executor_model: parsedTaskCommand.executorModel,
      },
      envelope,
      shouldMaterializeRootState: true,
    };
  }

  if (trimmedText === '/status') {
    return topicMapped
      ? {
          kind: 'accepted',
          task: { ...baseTask, task_type: STATUS_TASK_TYPE, payload: '', executor: undefined, executor_model: undefined },
          envelope,
          shouldMaterializeRootState: false,
        }
      : {
          kind: 'rejected',
          task: { ...baseTask, task_type: STATUS_TASK_TYPE },
          reason: formatThreadOnlyCommandMessage('/status'),
        };
  }

  if (trimmedText === '/end') {
    return topicMapped
      ? {
          kind: 'accepted',
          task: { ...baseTask, task_type: CLEANUP_TASK_TYPE, payload: '', executor: undefined, executor_model: undefined },
          envelope,
          shouldMaterializeRootState: false,
        }
      : {
          kind: 'rejected',
          task: { ...baseTask, task_type: CLEANUP_TASK_TYPE },
          reason: formatThreadOnlyCommandMessage('/end'),
        };
  }

  const parsedNewInstance = parseNewInstanceCommand(trimmedText);
  if (parsedNewInstance) {
    return topicMapped
      ? {
          kind: 'accepted',
          task: {
            ...baseTask,
            task_type: NEW_INSTANCE_TASK_TYPE,
            payload: '',
            executor: parsedNewInstance.executor,
            executor_model: parsedNewInstance.executorModel,
          },
          envelope,
          shouldMaterializeRootState: false,
        }
      : {
          kind: 'rejected',
          task: { ...baseTask, task_type: NEW_INSTANCE_TASK_TYPE },
          reason: formatThreadOnlyCommandMessage('/new'),
        };
  }

  if (trimmedText.startsWith('/new')) {
    return {
      kind: 'rejected',
      task: { ...baseTask, task_type: NEW_INSTANCE_TASK_TYPE },
      reason: topicMapped ? formatThreadReplyHelpMessage() : formatThreadOnlyCommandMessage('/new'),
    };
  }

  return {
    kind: 'rejected',
    task: { ...baseTask, task_type: topicMapped ? THREAD_REPLY_TASK_TYPE : TELEGRAM_INBOUND_TASK_TYPE },
    reason: topicMapped ? formatThreadReplyHelpMessage() : TELEGRAM_ROOT_USAGE_HINT,
  };
}

function parseTaskTypeHint(normalizedText: string): string | null {
  const firstLine = normalizedText.split('\n', 1)[0] ?? '';
  const match = /^\/task\s+(\S+)/.exec(firstLine);
  return match?.[1] ?? null;
}

function parseRootTaskCommand(normalizedText: string): {
  taskType: string;
  executor: string;
  executorModel: string;
  payload: string;
} | null {
  const [firstLine, ...restLines] = normalizedText.split('\n');
  const match = /^\/task\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(firstLine ?? '');
  if (!match) {
    return null;
  }

  const [, taskType, executor, executorModel, firstPayloadLine] = match;
  const payload = [firstPayloadLine, ...restLines].join('\n');
  return { taskType, executor, executorModel, payload };
}

function parseNewInstanceCommand(trimmedText: string): {
  executor?: string;
  executorModel?: string;
} | null {
  const parts = trimmedText.split(/\s+/);
  if (parts[0] !== '/new') {
    return null;
  }
  if (parts.length === 1) {
    return {};
  }
  if (parts.length === 3) {
    return { executor: parts[1], executorModel: parts[2] };
  }
  return null;
}
