import { routingKey, type TaskMessage, type JobMessage, type ResultMessage } from "@localagent/shared";
import type { QueuePort } from "../ports/queue.js";
import type { EmitterPort } from "../ports/emitter.js";
import type { Enricher } from "./enricher.js";
import type { ExecutorCore } from "./executor.js";

export type WorkerMode = "enrich" | "execute" | "emit";

const MODE_QUEUES: Record<WorkerMode, string> = {
  enrich: "tasks",
  execute: "jobs",
  emit: "results",
};

interface PipelineDeps {
  queue: QueuePort;
  enricher?: Enricher;
  executorCore?: ExecutorCore;
  emitters?: EmitterPort[];
}

export class Pipeline {
  private running = false;
  private deps: PipelineDeps;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
  }

  async processOne(mode: WorkerMode): Promise<boolean> {
    const queueName = MODE_QUEUES[mode];
    const consumed = await this.deps.queue.consume(queueName);
    if (!consumed) return false;

    const { receiptHandle, message } = consumed;

    try {
      switch (mode) {
        case "enrich": {
          if (!this.deps.enricher) throw new Error("Enricher not configured");
          const task = message as TaskMessage;
          const job = await this.deps.enricher.enrich(task);
          await this.deps.queue.publish("jobs", job, routingKey("job", job.type));
          break;
        }
        case "execute": {
          if (!this.deps.executorCore) throw new Error("Executor not configured");
          const job = message as JobMessage;
          const result = await this.deps.executorCore.run(job);
          await this.deps.queue.publish("results", result, routingKey("result", result.outputType));
          break;
        }
        case "emit": {
          const result = message as ResultMessage;
          const emitter = this.deps.emitters?.find((e) => e.outputType === result.outputType);
          if (!emitter) { console.error(`No emitter for output type: ${result.outputType}`); break; }
          await emitter.emit(result);
          break;
        }
      }
      await this.deps.queue.ack(receiptHandle);
    } catch (err) {
      console.error(`Pipeline error in ${mode} mode:`, err);
      if (mode === "execute") {
        const job = message as JobMessage;
        const errorResult: ResultMessage = {
          taskId: job.taskId, status: "error",
          output: err instanceof Error ? err.message : String(err),
          outputType: job.outputType, outputMeta: job.outputMeta,
        };
        try { await this.deps.queue.publish("results", errorResult, routingKey("result", errorResult.outputType)); } catch { /* best effort */ }
      }
      await this.deps.queue.ack(receiptHandle);
    }

    return true;
  }

  async startPolling(modes: WorkerMode[], intervalMs: number): Promise<void> {
    this.running = true;
    const loops = modes.map((mode) => this.pollLoop(mode, intervalMs));
    await Promise.all(loops);
  }

  stop(): void { this.running = false; }

  private async pollLoop(mode: WorkerMode, intervalMs: number): Promise<void> {
    while (this.running) {
      const processed = await this.processOne(mode);
      if (!processed) await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
