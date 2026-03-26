import { loadDaemonConfig, createLogger } from '@local-agent/shared';
import { Poller } from './poller';
import { handleTask } from './handler';

function main() {
  const config = loadDaemonConfig();
  const logger = createLogger('daemon', config.logLevel);

  logger.info({ apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs }, 'Starting daemon');

  const poller = new Poller(config.apiUrl, handleTask);
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down daemon...');
    poller.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
