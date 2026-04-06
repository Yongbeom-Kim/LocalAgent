import { loadTelegramDaemonConfig } from './config';
import {
  SessionBridgeRepository,
  TelegramHistoryRepository,
  assertExpectedSchemaVersion,
  createLogger,
  createSqliteClient,
  DEFAULT_TELEGRAM_QUEUE_NAME,
} from '@local-agent/shared';
import { TelegramPoller } from './telegram-poller';
import { TelegramNotifier } from './adapters/telegram-notifier';
import { TelegramTopicManager } from './adapters/telegram-topic-manager';
import { TelegramTaskSubmitter } from './adapters/telegram-task-submitter';
import { TelegramPhasePublisher } from './adapters/telegram-phase-publisher';
import { TelegramUpdatePoller } from './telegram-update-poller';

async function main() {
  const config = loadTelegramDaemonConfig();
  const logger = createLogger('telegram-daemon', config.logLevel);

  const notifier = new TelegramNotifier(config.telegramBotToken, config.telegramForumGroupId);
  const topicManager = new TelegramTopicManager(config.telegramBotToken);

  logger.info('Validating Telegram bot token...');
  try {
    const botUsername = await notifier.validate();
    const chat = await topicManager.getChat(config.telegramForumGroupId);
    if (chat.is_forum !== true) {
      throw new Error('Configured Telegram group is not forum-enabled');
    }
    logger.info({ botUsername, forumGroupId: config.telegramForumGroupId }, 'Telegram bot validated');
  } catch (err) {
    logger.fatal({ err }, 'Telegram bot validation failed');
    process.exit(1);
  }

  logger.info(
    {
      apiUrl: config.apiUrl,
      pollIntervalMs: config.pollIntervalMs,
      queueName: DEFAULT_TELEGRAM_QUEUE_NAME,
      dbPath: config.dbPath,
      expectedSchemaVersion: config.expectedSchemaVersion,
    },
    'Starting telegram-daemon',
  );

  const sqliteClient = await createSqliteClient({
    dbPath: config.dbPath,
    expectedSchemaVersion: config.expectedSchemaVersion,
  });
  await assertExpectedSchemaVersion(sqliteClient.db, config.expectedSchemaVersion);

  const telegramHistoryRepository = new TelegramHistoryRepository(sqliteClient.db);
  const sessionBridgeRepository = new SessionBridgeRepository(sqliteClient.db);

  const statefulNotifier = new TelegramNotifier(
    config.telegramBotToken,
    config.telegramForumGroupId,
    telegramHistoryRepository,
    sessionBridgeRepository,
  );

  const poller = new TelegramPoller(config.apiUrl, DEFAULT_TELEGRAM_QUEUE_NAME, statefulNotifier);
  const taskSubmitter = new TelegramTaskSubmitter(config.apiUrl);
  const phasePublisher = new TelegramPhasePublisher(config.apiUrl);
  const updatePoller = new TelegramUpdatePoller(
    config.telegramForumGroupId,
    topicManager,
    taskSubmitter,
    phasePublisher,
  );
  poller.start(config.pollIntervalMs);
  updatePoller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down telegram-daemon...');
    poller.stop();
    updatePoller.stop();
    sqliteClient.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('telegram-daemon');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
