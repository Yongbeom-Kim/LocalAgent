import { TASK_EXECUTOR_OPTIONS, getExecutorModelOptions, type TaskExecutorType } from './types';

export type RoutingCommandLabel = '/task' | '/new';

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
