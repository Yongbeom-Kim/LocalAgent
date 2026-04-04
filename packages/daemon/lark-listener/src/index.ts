import { createLogger } from '@local-agent/shared';
import { Client, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
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

  const client = new Client({ appId: config.appId, appSecret: config.appSecret });
  const submitter = new TaskSubmitter(config.apiUrl);
  const reactor = new LarkReactor(config.appId, config.appSecret);
  const replier = new LarkReplier(config.appId, config.appSecret);
  const dedup = new DedupMap({ ttlMs: config.dedupTtlMs });
  const handler = new MessageHandler(submitter, reactor, replier, dedup);

  const dispatcher = new EventDispatcher({ logger });
  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      if (!data) return;
      await handler.handle(data);
    },
  });

  const ws = new WSClient({ appId: config.appId, appSecret: config.appSecret, logger });
  await ws.start({ eventDispatcher: dispatcher });
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
