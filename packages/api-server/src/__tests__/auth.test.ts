import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { authMiddleware } from "../middleware/auth.js";

describe("auth middleware", () => {
  const apiKeys = new Map([["valid-key", "admin"]]);

  function buildApp() {
    const app = Fastify();
    app.addHook("onRequest", authMiddleware(apiKeys));
    app.get("/protected", async () => ({ ok: true }));
    return app;
  }

  it("allows valid API key", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer valid-key" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects missing auth header", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects invalid key", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer wrong-key" },
    });
    expect(res.statusCode).toBe(401);
  });
});
