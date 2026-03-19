import type { WorkerMode } from "./core/pipeline.js";

export interface WorkerConfig {
  apiServerUrl: string;
  apiKey: string;
  modes: WorkerMode[];
  pollIntervalMs: number;
  telegramBotToken?: string;
}

export function loadWorkerConfig(): WorkerConfig {
  const apiServerUrl = process.env.API_SERVER_URL;
  if (!apiServerUrl) throw new Error("API_SERVER_URL is required");

  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error("API_KEY is required");

  const modeStr = process.argv.includes("--mode")
    ? process.argv[process.argv.indexOf("--mode") + 1]
    : process.env.WORKER_MODE;

  if (!modeStr) throw new Error("--mode flag or WORKER_MODE env var is required");

  const modes = modeStr.split(",").map((m) => m.trim()) as WorkerMode[];
  const validModes = new Set(["enrich", "execute", "emit"]);
  for (const mode of modes) {
    if (!validModes.has(mode)) throw new Error(`Invalid mode: ${mode}`);
  }

  return {
    apiServerUrl,
    apiKey,
    modes,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL ?? "5000", 10),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  };
}
