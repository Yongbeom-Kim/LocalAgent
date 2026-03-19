import type { TaskMessage } from "@localagent/shared";

export interface ResolvedContext {
  [key: string]: unknown;
}

export interface TaskResolverPort {
  resolve(task: TaskMessage): Promise<ResolvedContext>;
}
