import {
  assertExpectedSchemaVersion,
  createLogger,
  createSqliteClient,
  LarkHistoryRepository,
} from '@local-agent/shared';
import { loadEnrichmentDaemonConfig } from './config';
import { EnrichmentService } from './enrichment-service';
import { EnrichmentPoller } from './enrichment-poller';
import { ThreadContextFetcher } from './adapters/thread-context-fetcher';

const logger = createLogger('enrichment-daemon');

async function main() {
  const config = loadEnrichmentDaemonConfig();
  logger.info(
    {
      apiUrl: config.apiUrl,
      pollIntervalMs: config.pollIntervalMs,
      taskDaemonStatusUrl: config.taskDaemonStatusUrl,
      enrichmentConfigDir: config.enrichmentConfigDir,
      dbPath: config.dbPath,
      expectedSchemaVersion: config.expectedSchemaVersion,
    },
    'Starting enrichment daemon',
  );

  const enrichmentService = EnrichmentService.fromDirectory(config.enrichmentConfigDir);
  logger.info({ configDir: config.enrichmentConfigDir }, 'Loaded enrichment config');

  const sqliteClient = await createSqliteClient({
    dbPath: config.dbPath,
    expectedSchemaVersion: config.expectedSchemaVersion,
  });
  await assertExpectedSchemaVersion(sqliteClient.db, config.expectedSchemaVersion);

  const larkHistoryRepository = new LarkHistoryRepository(sqliteClient.db);
  const threadContextFetcher = new ThreadContextFetcher(larkHistoryRepository);
  logger.info('Thread context enrichment enabled via SQLite');

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
    sqliteClient.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
