import { loadDaemonConfig, createLogger, DEFAULT_MAX_CONCURRENT_SESSIONS } from '@local-agent/shared';
import { TaskPoller } from './task-poller';
import { TaskOrchestrator } from './core/task-orchestrator';
import { JobEnvironment } from './services/job-environment';
import { SessionLockManager } from './services/session-lock';

async function main() {
  const config = loadDaemonConfig();
  const logger = createLogger('task-daemon', config.logLevel);

  const debug = process.env.DEBUG === '1';
  logger.info({ apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs, debug }, 'Starting task-daemon');

  const jobEnv = new JobEnvironment(debug);
  const orchestrator = new TaskOrchestrator(jobEnv);
  const sessionLock = new SessionLockManager();
  const maxConcurrency = parseInt(process.env.MAX_CONCURRENT_SESSIONS ?? '', 10) || DEFAULT_MAX_CONCURRENT_SESSIONS;

  logger.info({ maxConcurrency }, 'Concurrency limit');

  const poller = new TaskPoller(config.apiUrl, orchestrator, sessionLock, maxConcurrency);
  poller.start(config.pollIntervalMs);

  const shutdown = async () => {
    logger.info('Shutting down task-daemon...');
    await poller.drain();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('task-daemon');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
