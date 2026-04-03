import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadDaemonConfig, createLogger, DEFAULT_MAX_CONCURRENT_SESSIONS } from '@local-agent/shared';
import { TaskPoller } from './task-poller';
import { TaskOrchestrator } from './core/task-orchestrator';
import { JobEnvironment } from './services/job-environment';
import { SessionLockManager } from './services/session-lock';

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function extractSessionId(req: IncomingMessage): string | null {
  if (!req.url) return null;
  const url = new URL(req.url, 'http://127.0.0.1');
  const match = /^\/status\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}

export function createStatusServer(poller: Pick<TaskPoller, 'isSessionActive'>): Server {
  return createServer((req, res) => {
    if (req.method !== 'GET') {
      writeJson(res, 404, { error: 'Not found' });
      return;
    }

    const sessionId = extractSessionId(req);
    if (!sessionId) {
      writeJson(res, 404, { error: 'Not found' });
      return;
    }

    writeJson(res, 200, {
      session_id: sessionId,
      running: poller.isSessionActive(sessionId),
    });
  });
}

export async function main() {
  const config = loadDaemonConfig();
  const logger = createLogger('task-daemon', config.logLevel);

  const debug = process.env.DEBUG === '1';
  logger.info({ apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs, statusPort: config.statusPort, debug }, 'Starting task-daemon');

  const jobEnv = new JobEnvironment(debug);
  const orchestrator = new TaskOrchestrator(jobEnv);
  const sessionLock = new SessionLockManager();
  const maxConcurrency = parseInt(process.env.MAX_CONCURRENT_SESSIONS ?? '', 10) || DEFAULT_MAX_CONCURRENT_SESSIONS;

  logger.info({ maxConcurrency }, 'Concurrency limit');

  const poller = new TaskPoller(config.apiUrl, orchestrator, sessionLock, maxConcurrency);
  const statusServer = createStatusServer(poller);
  await new Promise<void>((resolve, reject) => {
    statusServer.once('error', reject);
    statusServer.listen(config.statusPort, resolve);
  });
  logger.info({ statusPort: config.statusPort }, 'Task status server listening');
  poller.start(config.pollIntervalMs);

  const shutdown = async () => {
    logger.info('Shutting down task-daemon...');
    await new Promise<void>((resolve, reject) => {
      statusServer.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    await poller.drain();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    const logger = createLogger('task-daemon');
    logger.fatal({ err }, 'Fatal error');
    process.exit(1);
  });
}
