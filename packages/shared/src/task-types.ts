import { z } from "zod";
import { DEFAULTS } from "./constants.js";

export interface TaskTypeDefinition<T extends z.ZodType = z.ZodType> {
  name: string;
  payloadSchema: T;
  promptTemplate: string;
  allowedTools?: string[];
  maxTokens?: number;
  timeout: number;
}

const registry = new Map<string, TaskTypeDefinition>();

export function defineTaskType<T extends z.ZodType>(
  config: Omit<TaskTypeDefinition<T>, "timeout"> & { timeout?: number }
): TaskTypeDefinition<T> {
  const def: TaskTypeDefinition<T> = {
    ...config,
    timeout: config.timeout ?? DEFAULTS.TASK_TIMEOUT_MS,
  };
  registry.set(def.name, def as TaskTypeDefinition);
  return def;
}

export function getTaskType(name: string): TaskTypeDefinition | undefined {
  return registry.get(name);
}

export function getAllTaskTypes(): TaskTypeDefinition[] {
  return Array.from(registry.values());
}
