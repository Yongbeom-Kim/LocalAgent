import {
  type LarkInboundEnvelope,
  type Task,
  type TaskSource,
} from './types';
import {
  TASK_COMMAND_USAGE,
  formatGcCommandUsageMessage,
  formatThreadOnlyCommandMessage,
  formatThreadReplyHelpMessage,
  formatThreadTaskCommandRejectedMessage,
} from './routing-errors';
import { parseGcCommand } from './gc';

const GC_TASK_TYPE = 'gc';
const NEW_INSTANCE_TASK_TYPE = 'new_instance';
const STATUS_TASK_TYPE = 'status';
const SHELL_COMMAND_TASK_TYPE = 'shell_command';
const CLEANUP_TASK_TYPE = 'cleanup';
const THREAD_REPLY_TASK_TYPE = 'thread_reply';
const LARK_INBOUND_TASK_TYPE = 'lark_inbound';

export const GC_THREAD_REJECTION_REASON = 'The /gc command can only be used as a base message, not inside a thread.';
export const ROOT_TASK_USAGE_HINT = `Usage: ${TASK_COMMAND_USAGE} or /status, /end, /shell (in a thread)`;
export const SHELL_COMMAND_THREAD_ONLY_MESSAGE = formatThreadOnlyCommandMessage('/shell');

export type LarkInboundClassificationResult =
  | {
      kind: 'accepted';
      task: Task;
      envelope: LarkInboundEnvelope;
      shouldMaterializeRootState: boolean;
    }
  | {
      kind: 'rejected';
      task: Task;
      reason: string;
    };

export function classifyLarkInboundEnvelope(
  task: Task,
  envelope: LarkInboundEnvelope,
): LarkInboundClassificationResult {
  const isThreadReply = envelope.message_id !== envelope.root_message_id;
  const taskSource: TaskSource = { source: 'lark', message_id: envelope.message_id };
  const baseTask = {
    ...task,
    task_source: taskSource,
  };

  if (!envelope.is_normalizable) {
    return {
      kind: 'rejected',
      task: { ...baseTask, task_type: isThreadReply ? THREAD_REPLY_TASK_TYPE : LARK_INBOUND_TASK_TYPE },
      reason: isThreadReply ? formatThreadReplyHelpMessage() : ROOT_TASK_USAGE_HINT,
    };
  }

  const normalizedText = envelope.normalized_text;
  const trimmedText = normalizedText.trim();

  if (!trimmedText.startsWith('/')) {
    if (isThreadReply) {
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
      task: { ...baseTask, task_type: LARK_INBOUND_TASK_TYPE },
      reason: ROOT_TASK_USAGE_HINT,
    };
  }

  if (trimmedText.startsWith('/shell')) {
    const parsedShellCommand = parseShellCommand(normalizedText);
    if (parsedShellCommand) {
      return isThreadReply
        ? {
            kind: 'accepted',
            task: {
              ...baseTask,
              task_type: SHELL_COMMAND_TASK_TYPE,
              payload: parsedShellCommand.payload,
              executor: undefined,
              executor_model: undefined,
            },
            envelope,
            shouldMaterializeRootState: false,
          }
        : {
            kind: 'rejected',
            task: { ...baseTask, task_type: SHELL_COMMAND_TASK_TYPE },
            reason: SHELL_COMMAND_THREAD_ONLY_MESSAGE,
          };
    }

    return {
      kind: 'rejected',
      task: { ...baseTask, task_type: SHELL_COMMAND_TASK_TYPE },
      reason: isThreadReply ? formatThreadReplyHelpMessage() : SHELL_COMMAND_THREAD_ONLY_MESSAGE,
    };
  }

  if (trimmedText.startsWith('/task')) {
    if (isThreadReply) {
      const parsedType = parseTaskTypeHint(normalizedText);
      return {
        kind: 'rejected',
        task: { ...baseTask, task_type: parsedType ?? LARK_INBOUND_TASK_TYPE },
        reason: formatThreadTaskCommandRejectedMessage(),
      };
    }

    const parsedTaskCommand = parseRootTaskCommand(normalizedText);
    if (!parsedTaskCommand) {
      return {
        kind: 'rejected',
        task: { ...baseTask, task_type: parseTaskTypeHint(normalizedText) ?? LARK_INBOUND_TASK_TYPE },
        reason: ROOT_TASK_USAGE_HINT,
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
    return isThreadReply
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
    return isThreadReply
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
    return isThreadReply
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
      reason: isThreadReply ? formatThreadReplyHelpMessage() : formatThreadOnlyCommandMessage('/new'),
    };
  }

  const parsedGcCommand = parseGcCommand(trimmedText);
  if (parsedGcCommand) {
    return isThreadReply
      ? {
          kind: 'rejected',
          task: { ...baseTask, task_type: GC_TASK_TYPE },
          reason: GC_THREAD_REJECTION_REASON,
        }
      : {
          kind: 'accepted',
          task: {
            ...baseTask,
            task_type: GC_TASK_TYPE,
            payload: parsedGcCommand.payload,
            executor: undefined,
            executor_model: undefined,
          },
          envelope,
          shouldMaterializeRootState: true,
        };
  }

  if (trimmedText.startsWith('/gc')) {
    return {
      kind: 'rejected',
      task: { ...baseTask, task_type: GC_TASK_TYPE },
      reason: isThreadReply ? formatThreadReplyHelpMessage() : formatGcCommandUsageMessage(),
    };
  }

  return {
    kind: 'rejected',
    task: { ...baseTask, task_type: isThreadReply ? THREAD_REPLY_TASK_TYPE : LARK_INBOUND_TASK_TYPE },
    reason: isThreadReply ? formatThreadReplyHelpMessage() : ROOT_TASK_USAGE_HINT,
  };
}

function parseTaskTypeHint(normalizedText: string): string | null {
  const firstLine = normalizedText.split('\n', 1)[0] ?? '';
  const match = /^\/task\s+(\S+)/.exec(firstLine);
  return match?.[1] ?? null;
}

function parseShellCommand(normalizedText: string): { payload: string } | null {
  const [firstLine, ...restLines] = normalizedText.split('\n');
  if (restLines.length > 0) {
    return null;
  }
  const match = /^\/shell\s+(.+)$/.exec(firstLine ?? '');
  if (!match) {
    return null;
  }
  const payload = match[1]?.trim();
  if (!payload) {
    return null;
  }
  return { payload };
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
