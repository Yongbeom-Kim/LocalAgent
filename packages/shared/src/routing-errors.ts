import { TASK_EXECUTOR_OPTIONS, getExecutorModelOptions, type TaskExecutorType } from './types';

export const TASK_COMMAND_USAGE = '/task <type> <executor> <model> <payload>';
export const GC_COMMAND_USAGE = '/gc [age]';
export const SHELL_COMMAND_USAGE = '/shell <command>';

export type RoutingCommandLabel = '/task' | '/new';

export function formatMissingTaskTypeMessage(validTypes: string[]): string {
  return `Usage: ${TASK_COMMAND_USAGE}\nAvailable task types: ${validTypes.join(', ')}`;
}

export function formatUnknownTaskTypeMessage(taskType: string, validTypes: string[]): string {
  return `Invalid task type "${taskType}". Available task types: ${validTypes.join(', ')}`;
}

export function formatMissingExecutorMessage(taskType: string): string {
  return `Missing executor for task type "${taskType}". Available executors: ${TASK_EXECUTOR_OPTIONS}`;
}

export function formatMissingModelMessage(executor: TaskExecutorType): string {
  return `Missing model for executor "${executor}". Available models: ${getExecutorModelOptions(executor)}`;
}

export function formatMissingPayloadMessage(): string {
  return `Usage: ${TASK_COMMAND_USAGE}\nPayload is required.`;
}

export function formatInvalidExecutorMessage(
  command: RoutingCommandLabel,
  executor: string,
): string {
  if (command === '/new') {
    return `Invalid executor "${executor}" for /new. Available executors: ${TASK_EXECUTOR_OPTIONS}`;
  }
  return `Invalid executor "${executor}". Available executors: ${TASK_EXECUTOR_OPTIONS}`;
}

export function formatInvalidModelMessage(
  command: RoutingCommandLabel,
  executor: TaskExecutorType,
  model: string,
): string {
  const availableModels = getExecutorModelOptions(executor);
  if (command === '/new') {
    return `Invalid model "${model}" for /new executor "${executor}". Available models: ${availableModels}`;
  }
  return `Invalid model "${model}" for executor "${executor}". Available models: ${availableModels}`;
}

export function formatThreadReplyHelpMessage(): string {
  return 'Thread replies must be natural language, /status, /new, /end, or /shell.';
}

export function formatThreadTaskCommandRejectedMessage(): string {
  return 'Cannot use /task in a thread. Reply with natural language, /status, /new, /end, or /shell.\nUse /task only as a new root message.';
}

export function formatThreadOnlyCommandMessage(command: '/status' | '/new' | '/end' | '/shell'): string {
  return `The ${command} command can only be used inside a thread.`;
}

export function formatShellDisabledMessage(): string {
  return 'The /shell command is disabled.';
}

export function formatGcCommandUsageMessage(): string {
  return `Usage: ${GC_COMMAND_USAGE}\nAge must be a positive integer followed by s, m, h, d, or w.`;
}
