import { loadDaemonConfig, createLogger } from '@local-agent/shared';
import { Poller } from './poller';
import { TaskOrchestrator } from './core/task-orchestrator';

async function main() {
  const config = loadDaemonConfig();
  const logger = createLogger('daemon', config.logLevel);

  logger.info({ apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs }, 'Starting daemon');

  const orchestrator = new TaskOrchestrator();
  const poller = new Poller(config.apiUrl, orchestrator);
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down daemon...');
    poller.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('daemon');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
