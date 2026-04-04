import { createLogger } from '@local-agent/shared';
import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';
import { loadLarkListenerConfig } from './config';
import { TaskSubmitter } from './adapters/task-submitter';
import { LarkReactor } from './adapters/lark-reactor';
import { LarkReplier } from './adapters/lark-replier';
import { MessageHandler } from './message-handler';
import { DedupMap } from './services/dedup';

const logger = createLogger('lark-listener');

async function main() {
  const config = loadLarkListenerConfig();

  logger.info({ apiUrl: config.apiUrl, dedupTtlMs: config.dedupTtlMs }, 'Starting lark-listener');

  const submitter = new TaskSubmitter(config.apiUrl);
  const reactor = new LarkReactor(config.appId, config.appSecret);
  const replier = new LarkReplier(config.appId, config.appSecret);
  const dedup = new DedupMap({ ttlMs: config.dedupTtlMs });
  const handler = new MessageHandler(submitter, reactor, replier, dedup);

  const eventDispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.info }).register({
    'im.message.receive_v1': async (data: unknown) => {
      await handler.handle(data as Parameters<typeof handler.handle>[0]);
    },
  });

  const wsClient = new WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: LoggerLevel.info,
  });

  await wsClient.start({ eventDispatcher });
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
