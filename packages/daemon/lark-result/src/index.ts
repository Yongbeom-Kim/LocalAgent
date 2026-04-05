import { loadLarkDaemonConfig } from './config';
import {
  createLogger,
  DEFAULT_LARK_QUEUE_NAME,
  createSqliteClient,
  assertExpectedSchemaVersion,
  LarkHistoryRepository,
} from '@local-agent/shared';
import { LarkPoller } from './lark-poller';
import { LarkNotifier } from './adapters/lark-notifier';
import { LarkPhaseNotifier, LarkTenantTokenProvider } from './adapters/lark-phase-notifier';

async function main() {
  const config = loadLarkDaemonConfig();
  const logger = createLogger('lark-daemon', config.logLevel);

  logger.info(
    {
      apiUrl: config.apiUrl,
      pollIntervalMs: config.pollIntervalMs,
      queueName: DEFAULT_LARK_QUEUE_NAME,
      dbPath: config.dbPath,
      expectedSchemaVersion: config.expectedSchemaVersion,
    },
    'Starting lark-daemon',
  );

  const sqliteClient = await createSqliteClient({
    dbPath: config.dbPath,
    expectedSchemaVersion: config.expectedSchemaVersion,
  });
  await assertExpectedSchemaVersion(sqliteClient.db, config.expectedSchemaVersion);

  const larkHistoryRepository = new LarkHistoryRepository(sqliteClient.db);

  logger.info('Lark SQLite outbound persistence enabled');

  const notifier = new LarkNotifier(
    config.larkAppId,
    config.larkAppSecret,
    config.larkRecipientId,
    larkHistoryRepository,
  );

  const tokenProvider = new LarkTenantTokenProvider(config.larkAppId, config.larkAppSecret);
  const phaseNotifier = new LarkPhaseNotifier(tokenProvider, larkHistoryRepository);
  const poller = new LarkPoller(config.apiUrl, DEFAULT_LARK_QUEUE_NAME, notifier, phaseNotifier);
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down lark-daemon...');
    poller.stop();
    sqliteClient.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('lark-daemon');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
