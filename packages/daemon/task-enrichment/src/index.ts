import { createLogger } from '@local-agent/shared';
import { loadEnrichmentDaemonConfig } from './config';
import { EnrichmentService } from './enrichment-service';
import { EnrichmentPoller } from './enrichment-poller';

const logger = createLogger('enrichment-daemon');

function main() {
  const config = loadEnrichmentDaemonConfig();
  logger.info({ config }, 'Starting enrichment daemon');

  const enrichmentService = EnrichmentService.fromFile(config.enrichmentConfigPath);
  logger.info({ configPath: config.enrichmentConfigPath }, 'Loaded enrichment config');

  const poller = new EnrichmentPoller(config.apiUrl, enrichmentService);
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
