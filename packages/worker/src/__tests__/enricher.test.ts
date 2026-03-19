import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Enricher } from "../core/enricher.js";
import { PassthroughResolver } from "../adapters/resolvers/passthrough.js";
import { defineTaskType } from "@localagent/shared";
import type { TaskMessage } from "@localagent/shared";

defineTaskType({
  name: "test_task",
  payloadSchema: z.object({ text: z.string() }),
  promptTemplate: "Process this: {{text}}",
  timeout: 60_000,
});

describe("Enricher", () => {
  const enricher = new Enricher(new PassthroughResolver());

  it("transforms a TaskMessage into a JobMessage", async () => {
    const task: TaskMessage = {
      taskId: "t-1", type: "test_task", outputType: "telegram",
      outputMeta: { chatId: "123" }, payload: { text: "hello world" },
    };
    const job = await enricher.enrich(task);
    expect(job.taskId).toBe("t-1");
    expect(job.prompt).toBe("Process this: hello world");
    expect(job.timeout).toBe(60_000);
  });

  it("throws for unknown task type", async () => {
    const task: TaskMessage = {
      taskId: "t-2", type: "nonexistent", outputType: "telegram", outputMeta: {}, payload: {},
    };
    await expect(enricher.enrich(task)).rejects.toThrow("Unknown task type");
  });
});
