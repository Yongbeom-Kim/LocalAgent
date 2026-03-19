import "@localagent/shared";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { tasksRoutes } from "../routes/tasks.js";

describe("POST /tasks", () => {
  const mockPublish = vi.fn().mockReturnValue(true);
  const mockChannel = { publish: mockPublish } as any;

  function buildApp() {
    const app = Fastify();
    app.decorate("publishChannel", mockChannel);
    app.register(tasksRoutes);
    return app;
  }

  beforeEach(() => { mockPublish.mockClear(); });

  it("creates a task and returns taskId", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: {
        type: "code_review",
        outputType: "telegram",
        outputMeta: { chatId: "123" },
        payload: { repo: "foo/bar", pr: 1 },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.taskId).toBeTruthy();
    expect(mockPublish).toHaveBeenCalledOnce();
  });

  it("rejects missing type", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { outputType: "telegram", outputMeta: { chatId: "123" }, payload: {} },
    });
    expect(res.statusCode).toBe(400);
  });
});
