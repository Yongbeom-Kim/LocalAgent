import type { Channel } from "amqplib";
import type { InFlightManager } from "./in-flight.js";
import type { Config } from "./config.js";
import type { QueueName } from "@localagent/shared";

declare module "fastify" {
  interface FastifyInstance {
    publishChannel: Channel;
    consumeChannels: Record<QueueName, Channel>;
    inFlight: InFlightManager;
    config: Config;
  }
}
