import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { connectAmqp } from "./amqp.js";
import { healthRoutes } from "./routes/health.js";
import type { ChannelModel } from "amqplib";
import type { Config } from "./config.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    amqpConn: ChannelModel;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({ logger: true });

  const amqpConn = await connectAmqp(config.amqpUrl);
  console.log("Connected to RabbitMQ");

  await app.register(healthRoutes);

  app.decorate("config", config);
  app.decorate("amqpConn", amqpConn);

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
