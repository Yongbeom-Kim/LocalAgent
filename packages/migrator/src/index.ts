import { createLogger } from '@local-agent/shared';
import { loadMigratorConfig } from './config';
import { runMigrations } from './migrate';

const logger = createLogger('migrator');

async function main(): Promise<void> {
  const config = loadMigratorConfig();
  logger.info({ dbPath: config.dbPath }, 'Running sqlite migrations');

  await runMigrations(config);

  logger.info('SQLite migrations completed');
}

main().catch((err) => {
  logger.fatal({ err }, 'SQLite migrations failed');
  process.exit(1);
});

