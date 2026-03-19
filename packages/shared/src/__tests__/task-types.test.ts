import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTaskType, getTaskType, getAllTaskTypes } from "../task-types.js";

describe("task type registry", () => {
  it("registers and retrieves a task type", () => {
    const codereview = defineTaskType({
      name: "code_review",
      payloadSchema: z.object({ repo: z.string(), pr: z.number() }),
      promptTemplate: "Review PR #{{pr}} in {{repo}}",
      timeout: 1_800_000,
    });
    expect(codereview.name).toBe("code_review");
    expect(getTaskType("code_review")).toBe(codereview);
  });

  it("validates payload against schema", () => {
    const tt = defineTaskType({
      name: "summarize",
      payloadSchema: z.object({ text: z.string() }),
      promptTemplate: "Summarize: {{text}}",
    });
    expect(() => tt.payloadSchema.parse({ text: "hello" })).not.toThrow();
    expect(() => tt.payloadSchema.parse({ wrong: 123 })).toThrow();
  });

  it("returns all registered task types", () => {
    const all = getAllTaskTypes();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});
