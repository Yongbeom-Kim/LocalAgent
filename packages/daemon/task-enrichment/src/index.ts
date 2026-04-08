import {
  assertExpectedSchemaVersion,
  createLogger,
  createSqliteClient,
  LarkHistoryRepository,
  SessionRepository,
  TelegramHistoryRepository,
} from '@local-agent/shared';
import { loadEnrichmentDaemonConfig } from './config';
import { EnrichmentService } from './enrichment-service';
import { EnrichmentPoller } from './enrichment-poller';
import { ThreadContextFetcher } from './adapters/thread-context-fetcher';
import { TelegramThreadContextFetcher } from './adapters/telegram-thread-context-fetcher';

const logger = createLogger('enrichment-daemon');

async function main() {
  const config = loadEnrichmentDaemonConfig();
  logger.info(
    {
      apiUrl: config.apiUrl,
      apiAuthEnabled: config.apiAuthEnabled,
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
  const telegramHistoryRepository = new TelegramHistoryRepository(sqliteClient.db);
  const sessionRepository = new SessionRepository(sqliteClient.db);
  const threadContextFetcher = new ThreadContextFetcher(larkHistoryRepository);
  const telegramThreadContextFetcher = new TelegramThreadContextFetcher(telegramHistoryRepository);
  logger.info('Thread context enrichment enabled via SQLite');

  const poller = new EnrichmentPoller(
    config.apiUrl,
    config.taskDaemonStatusUrl,
    enrichmentService,
    threadContextFetcher,
    undefined,
    config.apiAuthToken,
    undefined,
    {
      telegramThreadContextFetcher,
      sessionRepository,
    },
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
