import {
  SessionPlatformLinkRepository,
  SessionRepository,
  TelegramHistoryRepository,
  assertExpectedSchemaVersion,
  createLogger,
  createSqliteClient,
} from '@local-agent/shared';
import { loadTelegramDaemonConfig } from './config';
import { TelegramPhasePublisher } from './adapters/telegram-phase-publisher';
import { TelegramSessionResolver } from './adapters/telegram-session-resolver';
import { TelegramTaskSubmitter } from './adapters/telegram-task-submitter';
import { TelegramTopicManager } from './adapters/telegram-topic-manager';
import { TelegramUpdatePoller } from './telegram-update-poller';

async function main() {
  const config = loadTelegramDaemonConfig();
  const logger = createLogger('telegram-inbound', config.logLevel);

  const topicManager = new TelegramTopicManager(config.telegramBotToken);

  logger.info('Validating Telegram bot token...');
  try {
    const botUsername = await topicManager.getMe().then((me) => me.username);
    const chat = await topicManager.getChat(config.telegramForumGroupId);
    if (chat.is_forum !== true) {
      throw new Error('Configured Telegram group is not forum-enabled');
    }
    logger.info({ botUsername, forumGroupId: config.telegramForumGroupId }, 'Telegram inbound validated');
  } catch (err) {
    logger.fatal({ err }, 'Telegram inbound validation failed');
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
  const sessionResolver = new TelegramSessionResolver(
    telegramHistoryRepository,
    sessionRepository,
    sessionPlatformLinkRepository,
  );

  const taskSubmitter = new TelegramTaskSubmitter(config.apiUrl, config.apiAuthToken);
  const phasePublisher = new TelegramPhasePublisher(config.apiUrl, config.apiAuthToken);
  const updatePoller = new TelegramUpdatePoller(
    config.telegramForumGroupId,
    topicManager,
    taskSubmitter,
    phasePublisher,
    sessionResolver,
  );
  updatePoller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down telegram-inbound...');
    updatePoller.stop();
    sqliteClient.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('telegram-inbound');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
