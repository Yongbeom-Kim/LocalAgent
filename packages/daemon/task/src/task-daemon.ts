import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  loadDaemonConfig,
  createLogger,
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  TASK_DAEMON_MACHINE_LOCK_DISABLE_ENV,
} from '@local-agent/shared';
import { TaskPoller } from './task-poller';
import { TaskOrchestrator } from './core/task-orchestrator';
import { JobEnvironment } from './services/job-environment';
import { SessionLockManager } from './services/session-lock';
import {
  MachineLockManager,
  NoopMachineLock,
  type MachineLockAcquireResult,
  type MachineLockLike,
} from './services/machine-lock';

type PollerLike = Pick<TaskPoller, 'start' | 'drain' | 'isSessionActive'>;
type StatusServerLike = Pick<Server, 'listen' | 'close' | 'once' | 'removeListener'>;
type LoggerLike = ReturnType<typeof createLogger>;

type StartTaskDaemonDeps = {
  loadConfig: typeof loadDaemonConfig;
  createLogger: typeof createLogger;
  createJobEnvironment: (debug: boolean) => JobEnvironment;
  createOrchestrator: (jobEnv: JobEnvironment) => TaskOrchestrator;
  createSessionLock: () => SessionLockManager;
  createMachineLock: () => MachineLockLike;
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

function resolveMachineLock(deps: StartTaskDaemonDeps, logger: LoggerLike): MachineLockLike {
  if (deps.processObject.env[TASK_DAEMON_MACHINE_LOCK_DISABLE_ENV] === '1') {
    logger.warn(
      { envVar: TASK_DAEMON_MACHINE_LOCK_DISABLE_ENV },
      'Task daemon machine lock disabled for local development',
    );
    return new NoopMachineLock();
  }

  return deps.createMachineLock();
}

class TaskDaemonApp {
  private shutdownStarted = false;
  private statusServer: StatusServerLike | null = null;
  private statusServerListening = false;
  private poller: PollerLike | null = null;

  constructor(
    private readonly deps: StartTaskDaemonDeps,
    private readonly logger: LoggerLike,
    private readonly config: ReturnType<typeof loadDaemonConfig>,
    private readonly debug: boolean,
    private readonly machineLock: MachineLockLike,
  ) {}

  async start(): Promise<RunningTaskDaemon> {
    this.logger.info(
      {
        apiUrl: this.config.apiUrl,
        pollIntervalMs: this.config.pollIntervalMs,
        statusPort: this.config.statusPort,
        debug: this.debug,
      },
      'Starting task-daemon',
    );

    const machineLockResult = this.machineLock.acquire();
    assertMachineLockAcquired(machineLockResult);

    try {
      const jobEnv = this.deps.createJobEnvironment(this.debug);
      const orchestrator = this.deps.createOrchestrator(jobEnv);
      const sessionLock = this.deps.createSessionLock();
      const maxConcurrency = parseInt(this.deps.processObject.env.MAX_CONCURRENT_SESSIONS ?? '', 10) || DEFAULT_MAX_CONCURRENT_SESSIONS;

      this.logger.info({ maxConcurrency }, 'Concurrency limit');

      this.poller = this.deps.createPoller({
        apiUrl: this.config.apiUrl,
        orchestrator,
        sessionLock,
        maxConcurrency,
      });
      this.statusServer = this.deps.createStatusServer(this.poller);
      await listen(this.statusServer, this.config.statusPort);
      this.statusServerListening = true;
      this.logger.info({ statusPort: this.config.statusPort }, 'Task status server listening');
      this.poller.start(this.config.pollIntervalMs);

      return {
        shutdown: () => this.shutdown(),
        poller: this.poller,
      };
    } catch (err) {
      await this.shutdown();
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownStarted) {
      return;
    }

    this.shutdownStarted = true;
    this.logger.info('Shutting down task-daemon...');

    try {
      if (this.statusServer && this.statusServerListening) {
        await closeServer(this.statusServer);
      }
    } finally {
      try {
        if (this.poller) {
          await this.poller.drain();
        }
      } finally {
        this.machineLock.release();
      }
    }
  }
}

export async function startTaskDaemon(overrides: Partial<StartTaskDaemonDeps> = {}): Promise<RunningTaskDaemon> {
  const deps = { ...defaultDeps, ...overrides };
  const config = deps.loadConfig();
  const logger = deps.createLogger('task-daemon', config.logLevel);
  const debug = deps.processObject.env.DEBUG === '1';
  const machineLock = resolveMachineLock(deps, logger);

  return new TaskDaemonApp(deps, logger, config, debug, machineLock).start();
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
