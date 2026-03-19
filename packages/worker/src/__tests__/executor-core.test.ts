import { describe, it, expect, vi } from "vitest";
import { ExecutorCore } from "../core/executor.js";
import type { ExecutorPort } from "../ports/executor.js";
import type { JobMessage } from "@localagent/shared";

describe("ExecutorCore", () => {
  it("returns ok result on success", async () => {
    const mockExecutor: ExecutorPort = { execute: vi.fn().mockResolvedValue({ success: true, output: "Done!" }) };
    const core = new ExecutorCore(mockExecutor);
    const job: JobMessage = { taskId: "j-1", type: "test", prompt: "do something", timeout: 60_000, outputType: "telegram", outputMeta: { chatId: "123" } };
    const result = await core.run(job);
    expect(result.status).toBe("ok");
    expect(result.output).toBe("Done!");
  });

  it("returns error result on failure", async () => {
    const mockExecutor: ExecutorPort = { execute: vi.fn().mockResolvedValue({ success: false, output: "Timeout" }) };
    const core = new ExecutorCore(mockExecutor);
    const job: JobMessage = { taskId: "j-2", type: "test", prompt: "do something", timeout: 60_000, outputType: "lark", outputMeta: { webhookUrl: "https://example.com" } };
    const result = await core.run(job);
    expect(result.status).toBe("error");
    expect(result.output).toBe("Timeout");
  });
});
