import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@local-agent/shared';
import { loadLarkListenerConfig } from './config';
import { MessageHandler } from './message-handler';
import { TaskSubmitter } from './adapters/task-submitter';
import { LarkReactor } from './adapters/lark-reactor';
import { DedupMap } from './services/dedup';

async function main() {
  const config = loadLarkListenerConfig();
  const logger = createLogger('lark-listener', config.logLevel);

  if (!config.appId?.trim() || !config.appSecret?.trim()) {
    logger.fatal('LARK_APP_ID and LARK_APP_SECRET must be set and non-empty');
    process.exit(1);
  }

  logger.info({ apiUrl: config.apiUrl }, 'Starting lark-listener daemon');

  const submitter = new TaskSubmitter(config.apiUrl);
  const reactor = new LarkReactor(config.appId, config.appSecret);
  const dedup = new DedupMap({ ttlMs: config.dedupTtlMs });
  const handler = new MessageHandler(submitter, reactor, dedup);

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      try {
        await handler.handle(data as Parameters<typeof handler.handle>[0]);
      } catch (err) {
        logger.error({ err }, 'Unhandled error in message handler');
      }
    },
  });

  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  wsClient.start({ eventDispatcher });
  logger.info('WebSocket client started, listening for messages');

  const shutdown = () => {
    logger.info('Shutting down lark-listener daemon...');
    wsClient.close();
    dedup.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('lark-listener');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
