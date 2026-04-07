import {
  assertExpectedSchemaVersion,
  createLogger,
  createSqliteClient,
  LarkHistoryRepository,
  SessionBridgeRepository,
  SessionPlatformLinkRepository,
  SessionRepository,
} from '@local-agent/shared';
import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { loadLarkListenerConfig } from './config';
import { TaskSubmitter } from './adapters/task-submitter';
import { LarkReactor } from './adapters/lark-reactor';
import { LarkReplier } from './adapters/lark-replier';
import { LarkOpenApiMessageMetadataResolver } from './adapters/lark-message-metadata-resolver';
import { LarkSessionResolver } from './adapters/lark-session-resolver';
import { MessageHandler } from './message-handler';
import { DedupMap } from './services/dedup';

const logger = createLogger('lark-listener');

async function main() {
  const config = loadLarkListenerConfig();

  logger.info({ apiUrl: config.apiUrl, dedupTtlMs: config.dedupTtlMs }, 'Starting lark-listener');

  const submitter = new TaskSubmitter(config.apiUrl, config.apiAuthToken);
  const reactor = new LarkReactor(config.appId, config.appSecret);
  const replier = new LarkReplier(config.appId, config.appSecret);
  const metadataResolver = new LarkOpenApiMessageMetadataResolver(config.appId, config.appSecret);
  const dedup = new DedupMap({ ttlMs: config.dedupTtlMs });
  const sqliteClient = await createSqliteClient({
    dbPath: config.dbPath,
    expectedSchemaVersion: config.expectedSchemaVersion,
  });
  await assertExpectedSchemaVersion(sqliteClient.db, config.expectedSchemaVersion);
  const larkHistoryRepository = new LarkHistoryRepository(sqliteClient.db);
  const sessionRepository = new SessionRepository(sqliteClient.db);
  const sessionPlatformLinkRepository = new SessionPlatformLinkRepository(sqliteClient.db);
  const sessionBridgeRepository = new SessionBridgeRepository(sqliteClient.db);
  const sessionResolver = new LarkSessionResolver(
    larkHistoryRepository,
    sessionRepository,
    sessionPlatformLinkRepository,
    sessionBridgeRepository,
  );
  const handler = new MessageHandler(
    submitter,
    reactor,
    replier,
    dedup,
    metadataResolver,
    sessionResolver,
    larkHistoryRepository,
  );

  const wsClient = new WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
  });

  const eventDispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data: any) => {
      if (!data) return;
      await handler.handle(data);
    },
  });

  await wsClient.start({ eventDispatcher });
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
