import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { connectAmqp, createChannel } from "./amqp.js";
import { InFlightManager } from "./in-flight.js";
import { healthRoutes } from "./routes/health.js";
import { tasksRoutes } from "./routes/tasks.js";
import { queuesRoutes } from "./routes/queues.js";
import { authMiddleware } from "./middleware/auth.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({ logger: true });

  const amqpConn = await connectAmqp(config.amqpUrl);
  console.log("Connected to RabbitMQ");

  const publishChannel = await createChannel(amqpConn);
  const consumeChannels = {
    tasks: await createChannel(amqpConn),
    jobs: await createChannel(amqpConn),
    results: await createChannel(amqpConn),
  };

  const inFlight = new InFlightManager(config.inFlightTtlMs);
  inFlight.startScavenger(config.scavengerIntervalMs);

  app.decorate("publishChannel", publishChannel);
  app.decorate("consumeChannels", consumeChannels);
  app.decorate("inFlight", inFlight);
  app.decorate("config", config);

  app.addHook("onRequest", authMiddleware(config.apiKeys));
  await app.register(healthRoutes);
  await app.register(tasksRoutes);
  await app.register(queuesRoutes);

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
