import type { FastifyRequest, FastifyReply } from "fastify";

export function authMiddleware(apiKeys: Map<string, string>) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    if (request.url === "/health") return;

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Missing or invalid Authorization header" });
    }

    const key = authHeader.slice(7);
    if (!apiKeys.has(key)) {
      return reply.code(401).send({ error: "Invalid API key" });
    }
  };
}
