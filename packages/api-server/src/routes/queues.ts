import type { FastifyInstance } from "fastify";
import { QUEUE_MAP, type QueueName } from "@localagent/shared";
import type { InFlightManager } from "../in-flight.js";
import type { Channel } from "amqplib";

const CONSUMABLE_QUEUES = new Set<string>(["tasks", "jobs", "results"]);
const PUBLISHABLE_QUEUES = new Set<string>(["jobs", "results"]);

export async function queuesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string } }>("/queues/:name/consume", async (request, reply) => {
    const { name } = request.params;
    if (!CONSUMABLE_QUEUES.has(name)) {
      reply.code(400).send({ error: `Invalid queue name: ${name}` });
      return;
    }

    const queueName = name as QueueName;
    const channels = (app as any).consumeChannels as Record<string, Channel>;
    const channel = channels[queueName];
    const queueConfig = QUEUE_MAP[queueName];

    const msg = await channel.get(queueConfig.queue, { noAck: false });
    if (!msg) {
      reply.code(204).send();
      return;
    }

    const inFlight = (app as any).inFlight as InFlightManager;
    const receiptHandle = inFlight.track(channel, msg.fields.deliveryTag);
    const message = JSON.parse(msg.content.toString());

    return { receiptHandle, message };
  });

  app.post("/queues/ack", async (request, reply) => {
    const { receiptHandle } = request.body as { receiptHandle: string };
    const inFlight = (app as any).inFlight as InFlightManager;
    const result = inFlight.ack(receiptHandle);
    if (!result) {
      reply.code(404).send({ error: "Unknown receipt handle" });
      return;
    }
    return { ok: true };
  });

  app.post("/queues/nack", async (request, reply) => {
    const { receiptHandle } = request.body as { receiptHandle: string };
    const inFlight = (app as any).inFlight as InFlightManager;
    const result = inFlight.nack(receiptHandle);
    if (!result) {
      reply.code(404).send({ error: "Unknown receipt handle" });
      return;
    }
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/queues/:name/publish", async (request, reply) => {
    const { name } = request.params;
    if (!PUBLISHABLE_QUEUES.has(name)) {
      reply.code(403).send({ error: `Publishing to '${name}' is not allowed` });
      return;
    }

    const queueName = name as QueueName;
    const { message, routingKey } = request.body as { message: unknown; routingKey?: string };
    const queueConfig = QUEUE_MAP[queueName];
    const rk = routingKey ?? `${queueConfig.routingKeyPrefix}.default`;
    const channel = (app as any).publishChannel as Channel;

    channel.publish(queueConfig.exchange, rk, Buffer.from(JSON.stringify(message)), { persistent: true, contentType: "application/json" });

    return { ok: true };
  });
}
