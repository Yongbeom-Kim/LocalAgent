import { createLogger } from '@local-agent/shared';
import { loadEnrichmentDaemonConfig } from './config';
import { EnrichmentService } from './enrichment-service';
import { EnrichmentPoller } from './enrichment-poller';
import { ThreadContextFetcher } from './adapters/thread-context-fetcher';

const logger = createLogger('enrichment-daemon');

function main() {
  const config = loadEnrichmentDaemonConfig();
  logger.info(
    {
      apiUrl: config.apiUrl,
      pollIntervalMs: config.pollIntervalMs,
      taskDaemonStatusUrl: config.taskDaemonStatusUrl,
      enrichmentConfigDir: config.enrichmentConfigDir,
    },
    'Starting enrichment daemon',
  );

  const enrichmentService = EnrichmentService.fromDirectory(config.enrichmentConfigDir);
  logger.info({ configDir: config.enrichmentConfigDir }, 'Loaded enrichment config');

  const threadContextFetcher = new ThreadContextFetcher(config.larkAppId, config.larkAppSecret);
  logger.info('Thread context enrichment enabled');

  const poller = new EnrichmentPoller(
    config.apiUrl,
    config.taskDaemonStatusUrl,
    enrichmentService,
    threadContextFetcher,
  );
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down enrichment daemon');
    poller.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
