import {
  Task,
  JobSubmission,
  TaskPhase,
  buildApiAuthHeaders,
  createLogger,
  GC_THREAD_REJECTION_REASON,
  generateSessionId,
  isControlTaskType,
  formatThreadOnlyCommandMessage,
  formatThreadTaskCommandRejectedMessage,
  type LarkHistoryRepository,
  type TaskExecutorType,
  ROOT_TASK_USAGE_HINT,
  buildCleanupSubtreePayload,
  type SessionRepository,
} from '@local-agent/shared';
import { EnrichmentService } from './enrichment-service';
import type { ThreadContextFetcher, ThreadContextResult } from './adapters/thread-context-fetcher';
import { ApiAuthConfigurationError, TaskPhasePublisher } from './adapters/task-phase-publisher';
import { TelegramThreadContextFetcher } from './adapters/telegram-thread-context-fetcher';

const logger = createLogger('enrichment-daemon:poller');
const CLEANUP_TASK_TYPE = 'cleanup';
const GC_TASK_TYPE = 'gc';
const CLEANUP_REJECTION_REASON = 'Cleanup tasks in existing threads require an inherited session_id from the thread root.';
const CLEANUP_MISSING_SOURCE_REASON = 'Cleanup tasks require a Lark task source to resolve the existing session.';
const NEW_INSTANCE_TASK_TYPE = 'new_instance';
const STATUS_TASK_TYPE = 'status';
const THREAD_REPLY_TASK_TYPE = 'thread_reply';
const NEW_INSTANCE_PROMPT = 'Respond with: New session instance started.';
const NEW_INSTANCE_MISSING_SOURCE_REASON = 'The /new command requires a Lark source.';
const NEW_INSTANCE_MISSING_SESSION_REASON = 'The /new command requires an existing session in this thread.';
const STATUS_MISSING_SESSION_REASON = 'The /status command requires an existing session in this thread.';
const STATUS_LOOKUP_FAILURE_REASON = 'Failed to check live executor status. Please retry in the thread.';
const THREAD_LOOKUP_ERROR_REASON = 'Failed to recover thread state. Please retry in the thread.';
const THREAD_REPLY_INCOMPLETE_METADATA_REASON =
  'Cannot continue this thread because the inherited thread metadata is incomplete.';
const STATUS_INCOMPLETE_METADATA_REASON =
  'Cannot check /status because the inherited thread metadata is incomplete.';
const API_AUTH_FAILURE_LOG = 'API authentication failed; check API_AUTH_TOKEN or API_AUTH_DISABLED';

const GC_EXECUTOR = { executor: 'claude' as const, executor_model: 'sonnet' as const };

type StatusLookupResponse = {
  running?: boolean;
  active_session_count?: number;
  session_directory_count?: number;
};

interface BridgeRuntimeOptions {
  telegramThreadContextFetcher?: TelegramThreadContextFetcher;
  sessionRepository?: Pick<SessionRepository, 'listDescendantSessionIds' | 'upsertSession'>;
}

type LegacyThreadContextResult = {
  threadContext: string | null;
  inheritedTaskType: string | null;
  inheritedSessionId: string | null;
  inheritedExecutor: TaskExecutorType | null;
  inheritedExecutorModel: string | null;
};

function resolveNewInstancePair(task: Task, threadResult: ThreadContextResult): {
  executor: TaskExecutorType;
  executor_model: string;
} {
  if (task.executor && task.executor_model) {
    return {
      executor: task.executor as TaskExecutorType,
      executor_model: task.executor_model,
    };
  }
  if (threadResult.inheritedExecutor && threadResult.inheritedExecutorModel) {
    return {
      executor: threadResult.inheritedExecutor,
      executor_model: threadResult.inheritedExecutorModel,
    };
  }
  return { executor: 'claude', executor_model: 'sonnet' };
}

function normalizeThreadResult(
  result: ThreadContextResult | LegacyThreadContextResult | null | undefined,
): ThreadContextResult {
  if (result === undefined || result === null) {
    return notThreadResult();
  }

  if ('kind' in result) {
    if (result.kind === 'not_thread') {
      return notThreadResult();
    }

    if (result.kind === 'error') {
      return {
        kind: 'error',
        reason: result.reason,
        threadContext: null,
        inheritedTaskType: null,
        inheritedSessionId: null,
        inheritedExecutor: null,
        inheritedExecutorModel: null,
      };
    }

    return {
      kind: 'thread',
      threadContext: result.threadContext,
      inheritedTaskType: result.inheritedTaskType,
      inheritedSessionId: result.inheritedSessionId,
      inheritedExecutor: result.inheritedExecutor,
      inheritedExecutorModel: result.inheritedExecutorModel,
    };
  }

  return {
    kind: 'thread',
    threadContext: result.threadContext,
    inheritedTaskType: result.inheritedTaskType,
    inheritedSessionId: result.inheritedSessionId,
    inheritedExecutor: result.inheritedExecutor,
    inheritedExecutorModel: result.inheritedExecutorModel,
  };
}

function formatStatusSummary(status: StatusLookupResponse): string {
  const lines = [
    `Current thread session: ${status.running === true ? 'executor running' : 'idle'}`,
  ];

  if (typeof status.active_session_count === 'number') {
    lines.push(`Sessions with ongoing executor: ${status.active_session_count}`);
  }

  if (typeof status.session_directory_count === 'number') {
    lines.push(`Session directories on disk: ${status.session_directory_count}`);
  }

  return lines.join('\n');
}

export class EnrichmentPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly phasePublisher: TaskPhasePublisher;

  constructor(
    private readonly apiUrl: string,
    private readonly taskDaemonStatusUrl: string,
    private readonly enrichmentService: EnrichmentService,
    private readonly threadContextFetcher?: ThreadContextFetcher,
    private readonly _larkHistoryRepository?: LarkHistoryRepository,
    private readonly apiAuthToken?: string,
    phasePublisher?: TaskPhasePublisher,
    private readonly bridgeRuntime: BridgeRuntimeOptions = {},
  ) {
    this.phasePublisher = phasePublisher ?? new TaskPhasePublisher(apiUrl, apiAuthToken);
  }

  private buildApiHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...buildApiAuthHeaders(this.apiAuthToken),
    };
  }

  private buildOptionalAuthHeaders(): Record<string, string> {
    return {
      ...buildApiAuthHeaders(this.apiAuthToken),
    };
  }

  private isAuthFailureStatus(status: number): boolean {
    return status === 401 || status === 403;
  }

  private throwIfAuthFailureStatus(status: number, context: string, taskId?: string): void {
    if (!this.isAuthFailureStatus(status)) {
      return;
    }

    logger.warn({ task_id: taskId, status, context }, API_AUTH_FAILURE_LOG);
    throw new ApiAuthConfigurationError(`${context} failed with auth status ${status}`);
  }

  private async pollPass(): Promise<{ fetchedWork: boolean }> {
    try {
      const res = await fetch(`${this.apiUrl}/tasks/next`, {
        headers: this.buildOptionalAuthHeaders(),
      });

      this.throwIfAuthFailureStatus(res.status, 'GET /tasks/next');

      if (res.status === 204) {
        logger.debug('No tasks available');
        return { fetchedWork: false };
      }

      if (res.status !== 200) {
        logger.warn({ status: res.status }, 'Unexpected response from API');
        return { fetchedWork: false };
      }

      const task = (await res.json()) as Task;
      logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Received task for enrichment');

      await this.publishPhase(task, 'enriching');

      const fetchedWork = { fetchedWork: true };
      const isCleanupTask = task.task_type === CLEANUP_TASK_TYPE;
      const isGcTask = task.task_type === GC_TASK_TYPE;
      const isNewInstanceTask = task.task_type === NEW_INSTANCE_TASK_TYPE;
      const isStatusTask = task.task_type === STATUS_TASK_TYPE;
      const isThreadReplyTask = task.task_type === THREAD_REPLY_TASK_TYPE;
      let threadResult: ThreadContextResult | undefined;

      if (isCleanupTask && !this.hasThreadScopedSource(task)) {
        logger.warn({ task_id: task.task_id, task_source: task.task_source }, 'Rejected cleanup task without lark task_source');
        const published = await this.publishRejection(task, CLEANUP_MISSING_SOURCE_REASON);
        if (published) {
          await this.ackTask(task.task_id);
        }
        return fetchedWork;
      }

      if (this.threadContextFetcher && task.task_source?.source === 'lark') {
        const validTaskTypes = this.enrichmentService.getValidTaskTypes();
        threadResult = normalizeThreadResult(
          (await this.threadContextFetcher.fetchThreadContext(
            task.task_source.message_id,
            validTaskTypes,
          )) as ThreadContextResult | LegacyThreadContextResult | null | undefined,
        );

        if (threadResult.kind === 'error') {
          logger.warn({ task_id: task.task_id, reason: threadResult.reason }, 'Rejected lark task after thread lookup failure');
          const published = await this.publishRejection(task, threadResult.reason ?? THREAD_LOOKUP_ERROR_REASON);
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }

        if (isThreadReplyTask && threadResult.kind === 'not_thread') {
          logger.warn({ task_id: task.task_id }, 'Rejected root thread_reply continuation candidate');
          const published = await this.publishRejection(task, ROOT_TASK_USAGE_HINT);
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }

        if (isCleanupTask && threadResult.kind === 'not_thread') {
          logger.warn({ task_id: task.task_id }, 'Rejected cleanup task without thread context');
          const published = await this.publishRejection(task, formatThreadOnlyCommandMessage('/end'));
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }

        if (isNewInstanceTask && threadResult.kind === 'not_thread') {
          logger.warn({ task_id: task.task_id }, 'Rejected new_instance task outside thread');
          const published = await this.publishRejection(task, formatThreadOnlyCommandMessage('/new'));
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }

        if (isStatusTask && threadResult.kind === 'not_thread') {
          logger.warn({ task_id: task.task_id }, 'Rejected status task outside thread');
          const published = await this.publishRejection(task, formatThreadOnlyCommandMessage('/status'));
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }

        if (threadResult.kind === 'thread' && !isControlTaskType(task.task_type) && !isThreadReplyTask) {
          logger.warn(
            { task_id: task.task_id, task_type: task.task_type },
            'Rejected non-control Lark task in a thread',
          );
          const published = await this.publishRejection(task, formatThreadTaskCommandRejectedMessage());
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }
      }

      if (
        this.bridgeRuntime.telegramThreadContextFetcher &&
        task.task_source?.source === 'telegram' &&
        'topic_id' in task.task_source
      ) {
        threadResult = normalizeThreadResult(
          await this.bridgeRuntime.telegramThreadContextFetcher.fetchThreadContext(
            task.task_source.chat_id,
            task.task_source.topic_id,
          ),
        );
      }

      if (isGcTask && threadResult?.kind === 'thread') {
        logger.warn({ task_id: task.task_id }, 'Rejected gc task inside thread');
        const published = await this.publishRejection(task, GC_THREAD_REJECTION_REASON);
        if (published) {
          await this.ackTask(task.task_id);
        }
        return fetchedWork;
      }

      if (isGcTask) {
        const sessionId = task.session_id ?? generateSessionId();

        const jobSubmission: JobSubmission = {
          task_id: task.task_id,
          task_type: GC_TASK_TYPE,
          payload: task.payload,
          executors: [GC_EXECUTOR],
          submitted_at: task.submitted_at,
          session_id: sessionId,
          ...(task.task_source ? { task_source: task.task_source } : {}),
        };

        try {
          const jobRes = await fetch(`${this.apiUrl}/jobs`, {
            method: 'POST',
            headers: this.buildApiHeaders(),
            body: JSON.stringify(jobSubmission),
          });
          this.throwIfAuthFailureStatus(jobRes.status, 'POST /jobs', task.task_id);
          if (jobRes.status !== 201) {
            logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed for gc task - not acking task');
            return fetchedWork;
          }
          await this.publishPhase({ ...task, session_id: sessionId }, 'queued');
        } catch (jobErr) {
          logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed for gc task - not acking task');
          return fetchedWork;
        }

        await this.ackTask(task.task_id);
        return fetchedWork;
      }

      if (isNewInstanceTask && !this.hasThreadScopedSource(task)) {
        logger.warn({ task_id: task.task_id, task_source: task.task_source }, 'Rejected new_instance task without lark task_source');
        const published = await this.publishRejection(task, NEW_INSTANCE_MISSING_SOURCE_REASON);
        if (published) {
          await this.ackTask(task.task_id);
        }
        return fetchedWork;
      }

      if (isNewInstanceTask && threadResult?.kind === 'thread' && !threadResult.inheritedSessionId) {
        logger.warn({ task_id: task.task_id }, 'Rejected new_instance task without inherited session_id');
        const published = await this.publishRejection(task, NEW_INSTANCE_MISSING_SESSION_REASON);
        if (published) {
          await this.ackTask(task.task_id);
        }
        return fetchedWork;
      }

      if (isStatusTask) {
        if (threadResult?.kind !== 'thread' || !threadResult.inheritedSessionId) {
          logger.warn({ task_id: task.task_id, threadResult }, 'Rejected status task without inherited session_id');
          const published = await this.publishRejection(task, STATUS_MISSING_SESSION_REASON);
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }

        if (!threadResult.inheritedTaskType || !threadResult.inheritedExecutor || !threadResult.inheritedExecutorModel) {
          logger.warn({ task_id: task.task_id, threadResult }, 'Rejected status task with incomplete inherited metadata');
          const published = await this.publishRejection(task, STATUS_INCOMPLETE_METADATA_REASON);
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }

        try {
          const timeoutSignal = AbortSignal.timeout(1000);
          const statusRes = await fetch(
            `${this.taskDaemonStatusUrl}/status/${encodeURIComponent(threadResult.inheritedSessionId)}`,
            { signal: timeoutSignal },
          );

          if (statusRes.status !== 200) {
            logger.error({ task_id: task.task_id, status: statusRes.status }, 'GET /status failed for status task');
            const published = await this.publishRejection(task, STATUS_LOOKUP_FAILURE_REASON);
            if (published) {
              await this.ackTask(task.task_id);
            }
            return fetchedWork;
          }

          const statusBody = (await statusRes.json()) as StatusLookupResponse;
          const published = await this.publishStatusResult(task, threadResult, statusBody);
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        } catch (statusErr) {
          logger.error({ task_id: task.task_id, err: statusErr }, 'Status lookup request failed');
          const published = await this.publishRejection(task, STATUS_LOOKUP_FAILURE_REASON);
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }
      }

      if (isNewInstanceTask) {
        const inheritedType = threadResult?.kind === 'thread'
          ? (threadResult.inheritedTaskType ?? task.task_type)
          : task.task_type;

        const enrichmentResult = this.enrichmentService.enrich(
          { ...task, task_type: NEW_INSTANCE_TASK_TYPE, payload: NEW_INSTANCE_PROMPT },
          threadResult!.inheritedSessionId!,
          undefined,
        );

        if (enrichmentResult.type === 'rejected') {
          logger.warn({ task_id: task.task_id, reason: enrichmentResult.reason }, 'Enrichment rejected new_instance task');
          const published = await this.publishRejection(task, enrichmentResult.reason);
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }

        enrichmentResult.job.skipContinue = true;
        enrichmentResult.job.task_type = inheritedType;
        enrichmentResult.job.executors = [resolveNewInstancePair(task, threadResult!)];

        try {
          const jobRes = await fetch(`${this.apiUrl}/jobs`, {
            method: 'POST',
            headers: this.buildApiHeaders(),
            body: JSON.stringify(enrichmentResult.job),
          });
          this.throwIfAuthFailureStatus(jobRes.status, 'POST /jobs', task.task_id);
          if (jobRes.status !== 201) {
            logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed for new_instance - not acking');
            return fetchedWork;
          }
          await this.publishPhase(task, 'queued');
        } catch (jobErr) {
          logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed for new_instance - not acking');
          return fetchedWork;
        }

        await this.ackTask(task.task_id);
        return fetchedWork;
      }

      if (isThreadReplyTask && threadResult?.kind === 'thread') {
        if (
          !threadResult.inheritedTaskType ||
          !threadResult.inheritedSessionId ||
          !threadResult.inheritedExecutor ||
          !threadResult.inheritedExecutorModel
        ) {
          logger.warn({ task_id: task.task_id, threadResult }, 'Rejected thread_reply with incomplete inherited metadata');
          const published = await this.publishRejection(task, THREAD_REPLY_INCOMPLETE_METADATA_REASON);
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }

        const rewrittenTask: Task = {
          ...task,
          task_type: threadResult.inheritedTaskType,
          executor: threadResult.inheritedExecutor,
          executor_model: threadResult.inheritedExecutorModel,
        };
        const enrichmentResult = this.enrichmentService.enrich(
          rewrittenTask,
          threadResult.inheritedSessionId,
          threadResult.threadContext ?? undefined,
        );

        if (enrichmentResult.type === 'rejected') {
          logger.warn(
            { task_id: task.task_id, task_type: rewrittenTask.task_type, reason: enrichmentResult.reason },
            'Enrichment rejected rewritten thread_reply task',
          );
          const published = await this.publishRejection(task, enrichmentResult.reason);
          if (published) {
            await this.ackTask(task.task_id);
          }
          return fetchedWork;
        }

        try {
          const jobRes = await fetch(`${this.apiUrl}/jobs`, {
            method: 'POST',
            headers: this.buildApiHeaders(),
            body: JSON.stringify(enrichmentResult.job),
          });
          this.throwIfAuthFailureStatus(jobRes.status, 'POST /jobs', task.task_id);
          if (jobRes.status !== 201) {
            logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed for thread_reply rewrite - not acking task');
            return fetchedWork;
          }
          await this.publishPhase(task, 'queued');
        } catch (jobErr) {
          logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed for thread_reply rewrite - not acking task');
          return fetchedWork;
        }

        await this.ackTask(task.task_id);
        return fetchedWork;
      }

      if (isCleanupTask && threadResult?.kind === 'thread' && !threadResult.inheritedSessionId) {
        logger.warn({ task_id: task.task_id }, 'Rejected cleanup task without inherited session_id');
        const published = await this.publishRejection(task, CLEANUP_REJECTION_REASON);
        if (published) {
          await this.ackTask(task.task_id);
        }
        return fetchedWork;
      }

      const explicitSessionId = task.session_id ?? null;
      const inheritedSessionId = threadResult?.kind === 'thread'
        ? (threadResult.inheritedSessionId ?? null)
        : null;
      const sessionId = explicitSessionId ?? inheritedSessionId ?? generateSessionId();

      if (explicitSessionId) {
        logger.info({ task_id: task.task_id, explicit_session_id: sessionId }, 'Using explicit session_id for enrichment');
      } else if (inheritedSessionId) {
        logger.info({ task_id: task.task_id, inherited_session_id: sessionId }, 'Inherited session_id from thread root');
      } else {
        logger.info({ task_id: task.task_id, new_session_id: sessionId }, 'Generated or recovered session_id for enrichment');
      }

      await this.persistExplicitChildSessionLineage(task, threadResult, sessionId);

      const cleanupPayload = await this.buildCleanupPayload(task, threadResult, sessionId);
      const threadHistory = isCleanupTask || threadResult?.kind !== 'thread'
        ? undefined
        : (threadResult.threadContext ?? undefined);
      const enrichmentResult = this.enrichmentService.enrich(
        {
          ...task,
          session_id: sessionId,
          ...(cleanupPayload ? { payload: cleanupPayload } : {}),
        },
        sessionId,
        threadHistory,
      );

      if (enrichmentResult.type === 'rejected') {
        logger.warn({ task_id: task.task_id, task_type: task.task_type, reason: enrichmentResult.reason }, 'Enrichment rejected task');
        const published = await this.publishRejection(task, enrichmentResult.reason);
        if (published) {
          await this.ackTask(task.task_id);
        }
        return fetchedWork;
      }

      try {
        const jobRes = await fetch(`${this.apiUrl}/jobs`, {
          method: 'POST',
          headers: this.buildApiHeaders(),
          body: JSON.stringify(enrichmentResult.job),
        });
        this.throwIfAuthFailureStatus(jobRes.status, 'POST /jobs', task.task_id);
        if (jobRes.status !== 201) {
          logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed - not acking task');
          return fetchedWork;
        }
        await this.publishPhase({ ...task, session_id: sessionId }, 'queued');
      } catch (jobErr) {
        logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed - not acking task');
        return fetchedWork;
      }

      await this.ackTask(task.task_id);
      return fetchedWork;
    } catch (err) {
      if (err instanceof ApiAuthConfigurationError) {
        logger.error({ err }, 'Stopping enrichment poll due to API auth configuration error');
        this.stop();
        return { fetchedWork: false };
      }

      logger.error({ err }, 'Enrichment poll error');
      return { fetchedWork: false };
    }
  }

  async pollOnce(): Promise<void> {
    await this.pollPass();
  }

  async runBurstCycle(): Promise<void> {
    while (this.running) {
      const { fetchedWork } = await this.pollPass();
      if (!fetchedWork) {
        break;
      }
    }
  }

  private async persistExplicitChildSessionLineage(
    task: Task,
    threadResult: ThreadContextResult | undefined,
    sessionId: string,
  ): Promise<void> {
    if (!task.session_id || !this.bridgeRuntime.sessionRepository || threadResult?.kind !== 'thread') {
      return;
    }

    const parentSessionId = threadResult.inheritedSessionId;
    if (!parentSessionId || parentSessionId === sessionId) {
      return;
    }

    const submittedAtMs = Date.parse(task.submitted_at);
    const timestampMs = Number.isFinite(submittedAtMs) ? submittedAtMs : Date.now();

    await this.bridgeRuntime.sessionRepository.upsertSession({
      sessionId,
      parentSessionId,
      taskType: task.task_type,
      executor: task.executor ?? threadResult.inheritedExecutor ?? null,
      executorModel: task.executor_model ?? threadResult.inheritedExecutorModel ?? null,
      status: 'active',
      createdAtMs: timestampMs,
      updatedAtMs: timestampMs,
    });
  }

  private async buildCleanupPayload(
    task: Task,
    threadResult: ThreadContextResult | undefined,
    sessionId: string,
  ): Promise<string | null> {
    if (task.task_type !== CLEANUP_TASK_TYPE || threadResult?.kind !== 'thread') {
      return null;
    }

    const descendantSessionIds = this.bridgeRuntime.sessionRepository
      ? await this.bridgeRuntime.sessionRepository.listDescendantSessionIds(sessionId)
      : [];

    return buildCleanupSubtreePayload([sessionId, ...descendantSessionIds]);
  }

  private hasThreadScopedSource(task: Task): boolean {
    if (!task.task_source) {
      return false;
    }

    if (task.task_source.source === 'lark') {
      return true;
    }

    return 'topic_id' in task.task_source;
  }

  private async publishRejection(task: Task, reason: string): Promise<boolean> {
    await this.publishPhase(task, 'completed');

    try {
      const body = {
        job_id: task.task_id,
        task_id: task.task_id,
        task_type: task.task_type,
        status: 'failure' as const,
        exit_code: null,
        stdout: reason,
        stderr: '',
        ...(task.task_source ? { task_source: task.task_source } : {}),
      };

      const res = await fetch(`${this.apiUrl}/results`, {
        method: 'POST',
        headers: this.buildApiHeaders(),
        body: JSON.stringify(body),
      });

      this.throwIfAuthFailureStatus(res.status, 'POST /results', task.task_id);

      if (res.status !== 201) {
        logger.error({ task_id: task.task_id, status: res.status }, 'POST /results failed for rejection');
        return false;
      }

      logger.info({ task_id: task.task_id }, 'Published rejection result');
      return true;
    } catch (err) {
      logger.error({ task_id: task.task_id, err }, 'Failed to publish rejection result');
      return false;
    }
  }

  private async publishPhase(task: Task, phase: TaskPhase): Promise<void> {
    try {
      await this.phasePublisher.publish(task, phase);
    } catch (err) {
      logger.warn({ task_id: task.task_id, task_type: task.task_type, phase, err }, 'Failed to publish task phase');
    }
  }

  private async publishStatusResult(
    task: Task,
    threadResult: ThreadContextResult,
    status: StatusLookupResponse,
  ): Promise<boolean> {
    await this.publishPhase(task, 'completed');

    try {
      const body = {
        job_id: task.task_id,
        task_id: task.task_id,
        task_type: threadResult.inheritedTaskType!,
        session_id: threadResult.inheritedSessionId!,
        executor: threadResult.inheritedExecutor!,
        executor_model: threadResult.inheritedExecutorModel!,
        status: 'success' as const,
        exit_code: 0,
        stdout: formatStatusSummary(status),
        stderr: '',
        ...(task.task_source ? { task_source: task.task_source } : {}),
      };

      const res = await fetch(`${this.apiUrl}/results`, {
        method: 'POST',
        headers: this.buildApiHeaders(),
        body: JSON.stringify(body),
      });

      this.throwIfAuthFailureStatus(res.status, 'POST /results', task.task_id);

      if (res.status !== 201) {
        logger.error({ task_id: task.task_id, status: res.status }, 'POST /results failed for status result');
        return false;
      }

      return true;
    } catch (err) {
      logger.error({ task_id: task.task_id, err }, 'Failed to publish status result');
      return false;
    }
  }

  private async ackTask(taskId: string): Promise<void> {
    try {
      const ackRes = await fetch(`${this.apiUrl}/tasks/${taskId}/ack`, {
        method: 'POST',
        headers: this.buildOptionalAuthHeaders(),
      });
      this.throwIfAuthFailureStatus(ackRes.status, 'POST /tasks/:id/ack', taskId);
      if (ackRes.status !== 200) {
        logger.warn({ task_id: taskId, status: ackRes.status }, 'Task ACK failed');
      } else {
        logger.info({ task_id: taskId }, 'Task acknowledged');
      }
    } catch (ackErr) {
      logger.error({ task_id: taskId, err: ackErr }, 'Task ACK request failed');
    }
  }

  start(intervalMs: number): void {
    logger.info({ intervalMs }, 'Starting enrichment poller');
    this.running = true;
    const loop = async () => {
      await this.runBurstCycle();
      if (this.running) {
        this.timer = setTimeout(loop, intervalMs);
      }
    };
    loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function notThreadResult(): ThreadContextResult {
  return {
    kind: 'not_thread',
    threadContext: null,
    inheritedTaskType: null,
    inheritedSessionId: null,
    inheritedExecutor: null,
    inheritedExecutorModel: null,
  };
}
