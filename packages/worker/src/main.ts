import { loadWorkerConfig } from "./config.js";
import { HttpQueueAdapter } from "./adapters/http-queue.js";
import { ClaudeCliExecutor } from "./adapters/executor/claude-cli.js";
import { PassthroughResolver } from "./adapters/resolvers/passthrough.js";
import { TelegramEmitter } from "./adapters/emitters/telegram.js";
import { LarkEmitter } from "./adapters/emitters/lark.js";
import { Enricher } from "./core/enricher.js";
import { ExecutorCore } from "./core/executor.js";
import { Pipeline } from "./core/pipeline.js";
import type { EmitterPort } from "./ports/emitter.js";

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  console.log(`Starting worker in modes: ${config.modes.join(", ")}`);

  const queue = new HttpQueueAdapter(config.apiServerUrl, config.apiKey);

  const enricher = config.modes.includes("enrich")
    ? new Enricher(new PassthroughResolver())
    : undefined;

  const executorCore = config.modes.includes("execute")
    ? new ExecutorCore(new ClaudeCliExecutor())
    : undefined;

  const emitters: EmitterPort[] = [];
  if (config.modes.includes("emit")) {
    if (config.telegramBotToken) {
      emitters.push(new TelegramEmitter(config.telegramBotToken));
    }
    emitters.push(new LarkEmitter());
  }

  const pipeline = new Pipeline({ queue, enricher, executorCore, emitters });

  const shutdown = () => {
    console.log("Shutting down...");
    pipeline.stop();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await pipeline.startPolling(config.modes, config.pollIntervalMs);
  console.log("Worker stopped.");
}

main().catch((err) => {
  console.error("Worker failed:", err);
  process.exit(1);
});
