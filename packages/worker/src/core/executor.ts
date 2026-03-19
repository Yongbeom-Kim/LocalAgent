import type { JobMessage, ResultMessage } from "@localagent/shared";
import type { ExecutorPort } from "../ports/executor.js";

export class ExecutorCore {
  constructor(private executor: ExecutorPort) {}

  async run(job: JobMessage): Promise<ResultMessage> {
    const result = await this.executor.execute(job.prompt, {
      allowedTools: job.allowedTools, maxTokens: job.maxTokens, timeout: job.timeout,
    });
    return {
      taskId: job.taskId, status: result.success ? "ok" : "error",
      output: result.output, outputType: job.outputType, outputMeta: job.outputMeta,
    };
  }
}
