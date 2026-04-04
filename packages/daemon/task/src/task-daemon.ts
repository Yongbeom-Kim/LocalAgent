import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadDaemonConfig, createLogger, DEFAULT_MAX_CONCURRENT_SESSIONS } from '@local-agent/shared';
import { TaskPoller } from './task-poller';
import { TaskOrchestrator } from './core/task-orchestrator';
import { JobEnvironment } from './services/job-environment';
import { SessionLockManager } from './services/session-lock';
import { MachineLockManager, type MachineLockAcquireResult } from './services/machine-lock';

type PollerLike = Pick<TaskPoller, 'start' | 'drain' | 'isSessionActive'>;

type StatusServerLike = Pick<Server, 'listen' | 'close' | 'once' | 'removeListener'>;

type StartTaskDaemonDeps = {
  loadConfig: typeof loadDaemonConfig;
  createLogger: typeof createLogger;
  createJobEnvironment: (debug: boolean) => JobEnvironment;
  createOrchestrator: (jobEnv: JobEnvironment) => TaskOrchestrator;
  createSessionLock: () => SessionLockManager;
  createMachineLock: () => Pick<MachineLockManager, 'acquire' | 'release'>;
  createPoller: (args: {
    apiUrl: string;
    orchestrator: TaskOrchestrator;
    sessionLock: SessionLockManager;
    maxConcurrency: number;
  }) => PollerLike;
  createStatusServer: (poller: Pick<TaskPoller, 'isSessionActive'>) => StatusServerLike;
  exit: (code: number) => never;
  processObject: Pick<NodeJS.Process, 'env' | 'on'>;
};

interface RunningTaskDaemon {
  shutdown: () => Promise<void>;
  poller: PollerLike;
}

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

async function listen(server: StatusServerLike, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('error', onError);
      reject(err);
    };

    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

async function closeServer(server: StatusServerLike): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

const defaultDeps: StartTaskDaemonDeps = {
  loadConfig: loadDaemonConfig,
  createLogger,
  createJobEnvironment: (debug) => new JobEnvironment(debug),
  createOrchestrator: (jobEnv) => new TaskOrchestrator(jobEnv),
  createSessionLock: () => new SessionLockManager(),
  createMachineLock: () => new MachineLockManager(),
  createPoller: ({ apiUrl, orchestrator, sessionLock, maxConcurrency }) =>
    new TaskPoller(apiUrl, orchestrator, sessionLock, maxConcurrency),
  createStatusServer,
  exit: (code: number) => process.exit(code),
  processObject: process,
};

function assertMachineLockAcquired(result: MachineLockAcquireResult): void {
  if (result.acquired) {
    return;
  }

  throw new Error(
    `Only one task-daemon may run per machine. Lock held by PID ${result.holderPid} at ${result.lockPath}.`,
  );
}

export async function startTaskDaemon(overrides: Partial<StartTaskDaemonDeps> = {}): Promise<RunningTaskDaemon> {
  const deps = { ...defaultDeps, ...overrides };
  const config = deps.loadConfig();
  const logger = deps.createLogger('task-daemon', config.logLevel);
  const debug = deps.processObject.env.DEBUG === '1';

  logger.info({ apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs, statusPort: config.statusPort, debug }, 'Starting task-daemon');

  const machineLock = deps.createMachineLock();
  const machineLockResult = machineLock.acquire();
  assertMachineLockAcquired(machineLockResult);

  let shutdownStarted = false;
  let statusServer: StatusServerLike | null = null;
  let statusServerListening = false;
  let poller: PollerLike | null = null;

  const shutdown = async () => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    logger.info('Shutting down task-daemon...');

    try {
      if (statusServer && statusServerListening) {
        await closeServer(statusServer);
      }
    } finally {
      try {
        if (poller) {
          await poller.drain();
        }
      } finally {
        machineLock.release();
      }
    }
  };

  try {
    const jobEnv = deps.createJobEnvironment(debug);
    const orchestrator = deps.createOrchestrator(jobEnv);
    const sessionLock = deps.createSessionLock();
    const maxConcurrency = parseInt(deps.processObject.env.MAX_CONCURRENT_SESSIONS ?? '', 10) || DEFAULT_MAX_CONCURRENT_SESSIONS;

    logger.info({ maxConcurrency }, 'Concurrency limit');

    poller = deps.createPoller({
      apiUrl: config.apiUrl,
      orchestrator,
      sessionLock,
      maxConcurrency,
    });
    statusServer = deps.createStatusServer(poller);
    await listen(statusServer, config.statusPort);
    statusServerListening = true;
    logger.info({ statusPort: config.statusPort }, 'Task status server listening');
    poller.start(config.pollIntervalMs);

    return { shutdown, poller };
  } catch (err) {
    await shutdown();
    throw err;
  }
}

export async function main() {
  const running = await startTaskDaemon();

  const shutdownAndExit = async () => {
    await running.shutdown();
    defaultDeps.exit(0);
  };

  process.on('SIGINT', shutdownAndExit);
  process.on('SIGTERM', shutdownAndExit);
}

if (require.main === module) {
  main().catch((err) => {
    const logger = createLogger('task-daemon');
    logger.fatal({ err }, 'Fatal error');
    process.exit(1);
  });
}
