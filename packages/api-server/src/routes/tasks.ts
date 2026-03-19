import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { QUEUE_MAP, routingKey, TaskMessageSchema, getTaskType, validateOutputMeta } from "@localagent/shared";

export async function tasksRoutes(app: FastifyInstance): Promise<void> {
  app.post("/tasks", async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    const taskType = getTaskType(body.type as string);
    if (!taskType) {
      return reply.code(400).send({ error: `Unknown task type: ${body.type}` });
    }

    const payloadResult = taskType.payloadSchema.safeParse(body.payload);
    if (!payloadResult.success) {
      return reply.code(400).send({ error: "Invalid payload", details: payloadResult.error.issues });
    }

    if (!validateOutputMeta(body.outputType as string, body.outputMeta)) {
      return reply.code(400).send({ error: `Invalid outputMeta for output type: ${body.outputType}` });
    }

    const taskId = randomUUID();
    const message = TaskMessageSchema.safeParse({
      taskId, type: body.type, outputType: body.outputType, outputMeta: body.outputMeta, payload: body.payload,
    });

    if (!message.success) {
      return reply.code(400).send({ error: "Invalid task message", details: message.error.issues });
    }

    const { exchange, routingKeyPrefix } = QUEUE_MAP.tasks;
    const rk = routingKey(routingKeyPrefix, message.data.type);
    const channel = app.publishChannel;

    channel.publish(exchange, rk, Buffer.from(JSON.stringify(message.data)), { persistent: true, contentType: "application/json" });

    return reply.code(201).send({ taskId });
  });
}
