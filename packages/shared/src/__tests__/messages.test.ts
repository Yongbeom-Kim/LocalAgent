import { describe, it, expect } from "vitest";
import { TaskMessageSchema, JobMessageSchema, ResultMessageSchema } from "../messages.js";

describe("TaskMessageSchema", () => {
  it("validates a correct task message", () => {
    const msg = {
      taskId: "abc-123",
      type: "code_review",
      outputType: "telegram",
      outputMeta: { chatId: "12345" },
      payload: { repo: "foo/bar", pr: 42 },
    };
    expect(TaskMessageSchema.parse(msg)).toEqual(msg);
  });

  it("rejects missing taskId", () => {
    const msg = { type: "code_review", outputType: "telegram", outputMeta: {}, payload: {} };
    expect(() => TaskMessageSchema.parse(msg)).toThrow();
  });
});

describe("JobMessageSchema", () => {
  it("validates a correct job message", () => {
    const msg = {
      taskId: "abc-123",
      type: "code_review",
      prompt: "Review this code...",
      timeout: 3_600_000,
      outputType: "telegram",
      outputMeta: { chatId: "12345" },
    };
    expect(JobMessageSchema.parse(msg)).toEqual(msg);
  });

  it("accepts optional allowedTools and maxTokens", () => {
    const msg = {
      taskId: "abc-123",
      type: "code_review",
      prompt: "Review this code...",
      allowedTools: ["Read", "Grep"],
      maxTokens: 4096,
      timeout: 3_600_000,
      outputType: "telegram",
      outputMeta: { chatId: "12345" },
    };
    const result = JobMessageSchema.parse(msg);
    expect(result.allowedTools).toEqual(["Read", "Grep"]);
    expect(result.maxTokens).toBe(4096);
  });
});

describe("ResultMessageSchema", () => {
  it("validates a success result", () => {
    const msg = {
      taskId: "abc-123",
      status: "ok" as const,
      output: "Looks good!",
      outputType: "telegram",
      outputMeta: { chatId: "12345" },
    };
    expect(ResultMessageSchema.parse(msg)).toEqual(msg);
  });

  it("validates an error result", () => {
    const msg = {
      taskId: "abc-123",
      status: "error" as const,
      output: "Claude CLI exited with code 1",
      outputType: "lark",
      outputMeta: { webhookUrl: "https://lark.example.com/hook" },
    };
    expect(ResultMessageSchema.parse(msg)).toEqual(msg);
  });

  it("rejects invalid status", () => {
    const msg = {
      taskId: "abc-123",
      status: "pending",
      output: "",
      outputType: "telegram",
      outputMeta: {},
    };
    expect(() => ResultMessageSchema.parse(msg)).toThrow();
  });
});
