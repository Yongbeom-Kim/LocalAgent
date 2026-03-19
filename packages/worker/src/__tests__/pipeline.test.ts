import { describe, it, expect, vi } from "vitest";
import { Pipeline } from "../core/pipeline.js";
import type { QueuePort, ConsumedMessage } from "../ports/queue.js";
import type { Enricher } from "../core/enricher.js";
import type { ExecutorCore } from "../core/executor.js";
import type { EmitterPort } from "../ports/emitter.js";

function mockQueue(messages: ConsumedMessage[]): QueuePort {
  let idx = 0;
  return {
    consume: vi.fn(async () => messages[idx++] ?? null),
    ack: vi.fn(async () => {}),
    nack: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
  };
}

describe("Pipeline", () => {
  it("enrich mode: consumes task, enriches, publishes job, acks", async () => {
    const task = { taskId: "t-1", type: "test", outputType: "telegram", outputMeta: {}, payload: {} };
    const job = { taskId: "t-1", type: "test", prompt: "hello", timeout: 60000, outputType: "telegram", outputMeta: {} };

    const queue = mockQueue([{ receiptHandle: "rh-1", message: task }]);
    const enricher = { enrich: vi.fn().mockResolvedValue(job) } as unknown as Enricher;

    const pipeline = new Pipeline({ queue, enricher });
    await pipeline.processOne("enrich");

    expect(enricher.enrich).toHaveBeenCalledWith(task);
    expect(queue.publish).toHaveBeenCalledWith("jobs", job, "job.test");
    expect(queue.ack).toHaveBeenCalledWith("rh-1");
  });

  it("execute mode: consumes job, executes, publishes result, acks", async () => {
    const job = { taskId: "j-1", type: "test", prompt: "do it", timeout: 60000, outputType: "telegram", outputMeta: { chatId: "1" } };
    const result = { taskId: "j-1", status: "ok" as const, output: "done", outputType: "telegram", outputMeta: { chatId: "1" } };

    const queue = mockQueue([{ receiptHandle: "rh-2", message: job }]);
    const executorCore = { run: vi.fn().mockResolvedValue(result) } as unknown as ExecutorCore;

    const pipeline = new Pipeline({ queue, executorCore });
    await pipeline.processOne("execute");

    expect(executorCore.run).toHaveBeenCalledWith(job);
    expect(queue.publish).toHaveBeenCalledWith("results", result, "result.telegram");
    expect(queue.ack).toHaveBeenCalledWith("rh-2");
  });

  it("emit mode: consumes result, emits via adapter, acks", async () => {
    const result = { taskId: "r-1", status: "ok" as const, output: "done", outputType: "telegram", outputMeta: { chatId: "1" } };

    const queue = mockQueue([{ receiptHandle: "rh-3", message: result }]);
    const telegramEmitter = { outputType: "telegram", emit: vi.fn().mockResolvedValue(undefined) } as EmitterPort;

    const pipeline = new Pipeline({ queue, emitters: [telegramEmitter] });
    await pipeline.processOne("emit");

    expect(telegramEmitter.emit).toHaveBeenCalledWith(result);
    expect(queue.ack).toHaveBeenCalledWith("rh-3");
  });

  it("execute mode: on failure, publishes error result then acks", async () => {
    const job = { taskId: "j-2", type: "test", prompt: "fail", timeout: 60000, outputType: "lark", outputMeta: { webhookUrl: "x" } };
    const result = { taskId: "j-2", status: "error" as const, output: "boom", outputType: "lark", outputMeta: { webhookUrl: "x" } };

    const queue = mockQueue([{ receiptHandle: "rh-4", message: job }]);
    const executorCore = { run: vi.fn().mockResolvedValue(result) } as unknown as ExecutorCore;

    const pipeline = new Pipeline({ queue, executorCore });
    await pipeline.processOne("execute");

    expect(queue.publish).toHaveBeenCalledWith("results", result, "result.lark");
    expect(queue.ack).toHaveBeenCalledWith("rh-4");
  });
});
