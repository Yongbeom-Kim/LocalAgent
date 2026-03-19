import type { FastifyInstance } from "fastify";
import { QUEUE_MAP, type QueueName } from "@localagent/shared";

const CONSUMABLE_QUEUES: ReadonlySet<string> = new Set<QueueName>(["tasks", "jobs", "results"]);
const PUBLISHABLE_QUEUES: ReadonlySet<string> = new Set<QueueName>(["jobs", "results"]);

function isQueueName(name: string): name is QueueName {
  return name in QUEUE_MAP;
}

export async function queuesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string } }>("/queues/:name/consume", async (request, reply) => {
    const { name } = request.params;
    if (!isQueueName(name) || !CONSUMABLE_QUEUES.has(name)) {
      reply.code(400).send({ error: `Invalid queue name: ${name}` });
      return;
    }

    const queueName = name;
    const channel = app.consumeChannels[queueName];
    const queueConfig = QUEUE_MAP[queueName];

    const msg = await channel.get(queueConfig.queue, { noAck: false });
    if (!msg) {
      reply.code(204).send();
      return;
    }

    const inFlight = app.inFlight;
    const receiptHandle = inFlight.track(channel, msg.fields.deliveryTag);
    const message = JSON.parse(msg.content.toString());

    return { receiptHandle, message };
  });

  app.post("/queues/ack", async (request, reply) => {
    const { receiptHandle } = request.body as { receiptHandle: string };
    const inFlight = app.inFlight;
    const result = inFlight.ack(receiptHandle);
    if (!result) {
      reply.code(404).send({ error: "Unknown receipt handle" });
      return;
    }
    return { ok: true };
  });

  app.post("/queues/nack", async (request, reply) => {
    const { receiptHandle } = request.body as { receiptHandle: string };
    const inFlight = app.inFlight;
    const result = inFlight.nack(receiptHandle);
    if (!result) {
      reply.code(404).send({ error: "Unknown receipt handle" });
      return;
    }
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/queues/:name/publish", async (request, reply) => {
    const { name } = request.params;
    if (!isQueueName(name) || !PUBLISHABLE_QUEUES.has(name)) {
      reply.code(403).send({ error: `Publishing to '${name}' is not allowed` });
      return;
    }

    const queueName = name;
    const { message, routingKey } = request.body as { message: unknown; routingKey?: string };
    const queueConfig = QUEUE_MAP[queueName];
    const rk = routingKey ?? `${queueConfig.routingKeyPrefix}.default`;
    const channel = app.publishChannel;

    channel.publish(queueConfig.exchange, rk, Buffer.from(JSON.stringify(message)), { persistent: true, contentType: "application/json" });

    return { ok: true };
  });
}
