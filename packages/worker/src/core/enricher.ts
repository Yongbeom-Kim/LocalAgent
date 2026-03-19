import { getTaskType, type TaskMessage, type JobMessage } from "@localagent/shared";
import type { TaskResolverPort } from "../ports/task-resolver.js";

export class Enricher {
  constructor(private resolver: TaskResolverPort) {}

  async enrich(task: TaskMessage): Promise<JobMessage> {
    const taskType = getTaskType(task.type);
    if (!taskType) throw new Error(`Unknown task type: ${task.type}`);

    const context = await this.resolver.resolve(task);
    const prompt = fillTemplate(taskType.promptTemplate, context);

    return {
      taskId: task.taskId, type: task.type, prompt,
      allowedTools: taskType.allowedTools, maxTokens: taskType.maxTokens,
      timeout: taskType.timeout, outputType: task.outputType, outputMeta: task.outputMeta,
    };
  }
}

function fillTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = context[key];
    return value !== undefined ? String(value) : `{{${key}}}`;
  });
}
