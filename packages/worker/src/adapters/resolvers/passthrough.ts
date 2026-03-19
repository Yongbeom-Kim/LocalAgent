import type { TaskResolverPort, ResolvedContext } from "../../ports/task-resolver.js";
import type { TaskMessage } from "@localagent/shared";

export class PassthroughResolver implements TaskResolverPort {
  async resolve(task: TaskMessage): Promise<ResolvedContext> {
    return task.payload as ResolvedContext;
  }
}
