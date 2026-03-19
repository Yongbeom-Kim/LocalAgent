import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramEmitter } from "../adapters/emitters/telegram.js";
import { LarkEmitter } from "../adapters/emitters/lark.js";
import type { ResultMessage } from "@localagent/shared";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const okResult: ResultMessage = { taskId: "r-1", status: "ok", output: "Review complete", outputType: "telegram", outputMeta: { chatId: "12345" } };
const errorResult: ResultMessage = { taskId: "r-2", status: "error", output: "Timed out", outputType: "lark", outputMeta: { webhookUrl: "https://lark.example.com/hook/abc" } };

describe("TelegramEmitter", () => {
  const emitter = new TelegramEmitter("bot-token-123");
  beforeEach(() => mockFetch.mockReset());

  it("sends a message to the correct chat", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await emitter.emit(okResult);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("bot-token-123/sendMessage"),
      expect.objectContaining({ method: "POST", body: expect.stringContaining("12345") })
    );
  });
});

describe("LarkEmitter", () => {
  const emitter = new LarkEmitter();
  beforeEach(() => mockFetch.mockReset());

  it("sends a message to the webhook URL from outputMeta", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await emitter.emit(errorResult);
    expect(mockFetch).toHaveBeenCalledWith("https://lark.example.com/hook/abc", expect.objectContaining({ method: "POST" }));
  });
});
