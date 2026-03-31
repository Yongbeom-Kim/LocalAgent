import { resolve } from 'node:path';
import { createLogger } from '@local-agent/shared';
import { loadEnrichmentDaemonConfig } from './config';
import { EnrichmentService } from './enrichment-service';
import { EnrichmentPoller } from './enrichment-poller';
import { ThreadContextFetcher } from './adapters/thread-context-fetcher';

const logger = createLogger('enrichment-daemon');

function main() {
  const config = loadEnrichmentDaemonConfig();
  logger.info({ config }, 'Starting enrichment daemon');

  // TODO: Task 3 will replace this with fromDirectory()
  const configPath = resolve(config.enrichmentConfigDir, 'enrichment.yaml');
  const enrichmentService = EnrichmentService.fromFile(configPath);
  logger.info({ configDir: config.enrichmentConfigDir }, 'Loaded enrichment config');

  let threadContextFetcher: ThreadContextFetcher | undefined;
  if (config.larkAppId && config.larkAppSecret) {
    threadContextFetcher = new ThreadContextFetcher(config.larkAppId, config.larkAppSecret);
    logger.info('Thread context enrichment enabled (Lark credentials found)');
  } else {
    logger.info('Thread context enrichment disabled (LARK_APP_ID or LARK_APP_SECRET not set)');
  }

  const poller = new EnrichmentPoller(config.apiUrl, enrichmentService, threadContextFetcher);
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
