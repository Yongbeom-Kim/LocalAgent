import { loadLarkDaemonConfig, createLogger, DEFAULT_LARK_QUEUE_NAME } from '@local-agent/shared';
import { LarkPoller } from './lark-poller';
import { LarkNotifier } from './adapters/lark-notifier';

async function main() {
  const config = loadLarkDaemonConfig();
  const logger = createLogger('lark-daemon', config.logLevel);

  if (!config.larkAppId || !config.larkAppSecret || !config.larkRecipientId) {
    logger.fatal('LARK_APP_ID, LARK_APP_SECRET, and LARK_RECIPIENT_ID must be set');
    process.exit(1);
  }

  logger.info(
    { apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs, queueName: DEFAULT_LARK_QUEUE_NAME },
    'Starting lark-daemon',
  );

  const notifier = new LarkNotifier(config.larkAppId, config.larkAppSecret, config.larkRecipientId);
  const poller = new LarkPoller(config.apiUrl, DEFAULT_LARK_QUEUE_NAME, notifier);
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down lark-daemon...');
    poller.stop();
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
