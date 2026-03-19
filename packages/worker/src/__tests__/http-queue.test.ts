import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpQueueAdapter } from "../adapters/http-queue.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("HttpQueueAdapter", () => {
  const adapter = new HttpQueueAdapter("http://localhost:3000", "test-key");

  beforeEach(() => { mockFetch.mockReset(); });

  it("consume returns null on 204", async () => {
    mockFetch.mockResolvedValue({ status: 204 });
    const result = await adapter.consume("jobs");
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/queues/jobs/consume",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      })
    );
  });

  it("consume returns message on 200", async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      json: async () => ({ receiptHandle: "abc", message: { taskId: "1" } }),
    });
    const result = await adapter.consume("jobs");
    expect(result).toEqual({ receiptHandle: "abc", message: { taskId: "1" } });
  });

  it("ack sends POST with receipt handle", async () => {
    mockFetch.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });
    await adapter.ack("handle-123");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/queues/ack",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ receiptHandle: "handle-123" }),
      })
    );
  });

  it("publish sends POST with message and routing key", async () => {
    mockFetch.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });
    await adapter.publish("results", { taskId: "1" }, "result.telegram");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/queues/results/publish",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: { taskId: "1" }, routingKey: "result.telegram" }),
      })
    );
  });
});
