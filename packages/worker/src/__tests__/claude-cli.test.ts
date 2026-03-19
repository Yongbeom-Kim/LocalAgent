import { describe, it, expect, vi } from "vitest";
import { ClaudeCliExecutor } from "../adapters/executor/claude-cli.js";
import * as child_process from "node:child_process";

vi.mock("node:child_process");

describe("ClaudeCliExecutor", () => {
  const executor = new ClaudeCliExecutor();

  it("returns success with parsed output on exit code 0", async () => {
    const mockSpawn = vi.mocked(child_process.spawn);
    const mockProcess = {
      stdout: {
        on: vi.fn((event, cb) => {
          if (event === "data") {
            cb(Buffer.from(JSON.stringify({ type: "assistant", content: [{ type: "text", text: "Hello world" }] }) + "\n"));
          }
        }),
      },
      stderr: { on: vi.fn() },
      on: vi.fn((event, cb) => { if (event === "close") cb(0); }),
      kill: vi.fn(),
      pid: 123,
    } as any;
    mockSpawn.mockReturnValue(mockProcess);

    const result = await executor.execute("test prompt", { timeout: 60_000 });
    expect(result.success).toBe(true);
    expect(result.output).toBe("Hello world");
  });

  it("returns error on non-zero exit code", async () => {
    const mockSpawn = vi.mocked(child_process.spawn);
    const mockProcess = {
      stdout: { on: vi.fn() },
      stderr: {
        on: vi.fn((event, cb) => { if (event === "data") cb(Buffer.from("error message")); }),
      },
      on: vi.fn((event, cb) => { if (event === "close") cb(1); }),
      kill: vi.fn(),
      pid: 123,
    } as any;
    mockSpawn.mockReturnValue(mockProcess);

    const result = await executor.execute("test prompt", { timeout: 60_000 });
    expect(result.success).toBe(false);
    expect(result.output).toContain("error");
  });
});
