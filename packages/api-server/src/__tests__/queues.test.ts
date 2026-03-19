import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { queuesRoutes } from "../routes/queues.js";
import { InFlightManager } from "../in-flight.js";

describe("queue proxy routes", () => {
  const inFlight = new InFlightManager(60_000);
  const mockChannel = {
    get: vi.fn(),
    publish: vi.fn().mockReturnValue(true),
    ack: vi.fn(),
    nack: vi.fn(),
  } as any;

  function buildApp() {
    const app = Fastify();
    app.decorate("consumeChannels", { tasks: mockChannel, jobs: mockChannel, results: mockChannel });
    app.decorate("publishChannel", mockChannel);
    app.decorate("inFlight", inFlight);
    app.register(queuesRoutes);
    return app;
  }

  beforeEach(() => { vi.clearAllMocks(); });

  it("GET /queues/jobs/consume returns 204 when empty", async () => {
    mockChannel.get.mockResolvedValue(false);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/queues/jobs/consume" });
    expect(res.statusCode).toBe(204);
  });

  it("GET /queues/jobs/consume returns message with receiptHandle", async () => {
    mockChannel.get.mockResolvedValue({
      content: Buffer.from(JSON.stringify({ taskId: "abc" })),
      fields: { deliveryTag: 1 },
      properties: {},
    });
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/queues/jobs/consume" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.receiptHandle).toBeTruthy();
    expect(body.message).toEqual({ taskId: "abc" });
  });

  it("rejects consume from invalid queue name", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/queues/invalid/consume" });
    expect(res.statusCode).toBe(400);
  });

  it("POST /queues/ack acks a tracked message", async () => {
    mockChannel.get.mockResolvedValue({
      content: Buffer.from("{}"),
      fields: { deliveryTag: 42 },
      properties: {},
    });
    const app = buildApp();
    const consumeRes = await app.inject({ method: "GET", url: "/queues/jobs/consume" });
    const { receiptHandle } = consumeRes.json();
    const ackRes = await app.inject({ method: "POST", url: "/queues/ack", payload: { receiptHandle } });
    expect(ackRes.statusCode).toBe(200);
  });

  it("POST /queues/ack returns 404 for unknown handle", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/queues/ack", payload: { receiptHandle: "nonexistent" } });
    expect(res.statusCode).toBe(404);
  });

  it("POST /queues/results/publish publishes a message", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST", url: "/queues/results/publish",
      payload: { message: { taskId: "abc", status: "ok", output: "done" }, routingKey: "result.telegram" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockChannel.publish).toHaveBeenCalled();
  });

  it("rejects publish to disallowed queue", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/queues/tasks/publish", payload: { message: {} } });
    expect(res.statusCode).toBe(403);
  });
});
