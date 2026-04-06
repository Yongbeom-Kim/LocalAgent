import { loadTelegramDaemonConfig } from './config';
import { createLogger, DEFAULT_TELEGRAM_QUEUE_NAME } from '@local-agent/shared';
import { TelegramPoller } from './telegram-poller';
import { TelegramNotifier } from './adapters/telegram-notifier';

async function main() {
  const config = loadTelegramDaemonConfig();
  const logger = createLogger('telegram-daemon', config.logLevel);

  const notifier = new TelegramNotifier(config.telegramBotToken, config.telegramChatId);

  logger.info('Validating Telegram bot token...');
  try {
    const botUsername = await notifier.validate();
    logger.info({ botUsername }, 'Telegram bot validated');
  } catch (err) {
    logger.fatal({ err }, 'Telegram bot validation failed');
    process.exit(1);
  }

  logger.info(
    { apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs, queueName: DEFAULT_TELEGRAM_QUEUE_NAME },
    'Starting telegram-daemon',
  );

  const poller = new TelegramPoller(
    config.apiUrl,
    DEFAULT_TELEGRAM_QUEUE_NAME,
    notifier,
    config.apiAuthToken,
  );
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down telegram-daemon...');
    poller.stop();
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
