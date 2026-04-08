import { loadTelegramDaemonConfig } from './config';
import {
  SessionPlatformLinkRepository,
  SessionRepository,
  SessionBridgeRepository,
  TelegramHistoryRepository,
  assertExpectedSchemaVersion,
  createLogger,
  createSqliteClient,
  DEFAULT_TELEGRAM_QUEUE_NAME,
} from '@local-agent/shared';
import { TelegramPoller } from './telegram-poller';
import { TelegramNotifier, TelegramTopicManager } from './adapters/telegram-notifier';

async function main() {
  const config = loadTelegramDaemonConfig();
  const logger = createLogger('telegram-outbound', config.logLevel);

  const notifier = new TelegramNotifier(config.telegramBotToken, config.telegramForumGroupId);

  logger.info('Validating Telegram bot token...');
  try {
    const botUsername = await notifier.validate();
    logger.info({ botUsername, forumGroupId: config.telegramForumGroupId }, 'Telegram outbound validated');
  } catch (err) {
    logger.fatal({ err }, 'Telegram outbound validation failed');
    process.exit(1);
  }

  const sqliteClient = await createSqliteClient({
    dbPath: config.dbPath,
    expectedSchemaVersion: config.expectedSchemaVersion,
  });
  await assertExpectedSchemaVersion(sqliteClient.db, config.expectedSchemaVersion);

  const telegramHistoryRepository = new TelegramHistoryRepository(sqliteClient.db);
  const sessionRepository = new SessionRepository(sqliteClient.db);
  const sessionPlatformLinkRepository = new SessionPlatformLinkRepository(sqliteClient.db);
  const sessionBridgeRepository = new SessionBridgeRepository(sqliteClient.db);

  const statefulNotifier = new TelegramNotifier(
    config.telegramBotToken,
    config.telegramForumGroupId,
    telegramHistoryRepository,
    sessionBridgeRepository,
    sessionRepository,
    sessionPlatformLinkRepository,
    new TelegramTopicManager(config.telegramBotToken),
  );

  const poller = new TelegramPoller(
    config.apiUrl,
    DEFAULT_TELEGRAM_QUEUE_NAME,
    statefulNotifier,
    config.apiAuthToken,
  );
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down telegram-outbound...');
    poller.stop();
    sqliteClient.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('telegram-outbound');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
