import { DEFAULTS } from "@localagent/shared";

export interface Config {
  amqpUrl: string;
  apiKeys: Map<string, string>;
  port: number;
  inFlightTtlMs: number;
  scavengerIntervalMs: number;
}

export function loadConfig(): Config {
  const amqpUrl = process.env.AMQP_URL;
  if (!amqpUrl) throw new Error("AMQP_URL is required");

  const apiKeysRaw = process.env.API_KEYS ?? "";
  const apiKeys = new Map<string, string>();
  for (const pair of apiKeysRaw.split(",").filter(Boolean)) {
    const [key, label] = pair.split(":");
    if (key && label) apiKeys.set(key, label);
  }
  if (apiKeys.size === 0) throw new Error("API_KEYS must contain at least one key:label pair");

  return {
    amqpUrl,
    apiKeys,
    port: parseInt(process.env.PORT ?? "3000", 10),
    inFlightTtlMs: parseInt(process.env.IN_FLIGHT_TTL_MS ?? String(DEFAULTS.IN_FLIGHT_TTL_MS), 10),
    scavengerIntervalMs: parseInt(process.env.SCAVENGER_INTERVAL_MS ?? String(DEFAULTS.SCAVENGER_INTERVAL_MS), 10),
  };
}
