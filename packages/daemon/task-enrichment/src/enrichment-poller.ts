import {
  Task,
  JobSubmission,
  TaskPhase,
  createLogger,
  generateSessionId,
  isControlTaskType,
  TASK_COMMAND_USAGE,
  formatThreadOnlyCommandMessage,
  formatThreadTaskCommandRejectedMessage,
  type TaskExecutorType,
} from '@local-agent/shared';
import { EnrichmentService } from './enrichment-service';
import type { ThreadContextFetcher, ThreadContextResult } from './adapters/thread-context-fetcher';
import { TaskPhasePublisher } from './adapters/task-phase-publisher';

const logger = createLogger('enrichment-daemon:poller');
const CLEANUP_TASK_TYPE = 'cleanup';
const GC_TASK_TYPE = 'gc';
const CLEANUP_REJECTION_REASON = 'Cleanup tasks in existing threads require an inherited session_id from the thread root.';
const CLEANUP_MISSING_SOURCE_REASON = 'Cleanup tasks require a Lark task source to resolve the existing session.';
const GC_THREAD_REJECTION_REASON = 'The /gc command can only be used as a base message, not inside a thread.';
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
const ROOT_TASK_USAGE_HINT = `Usage: ${TASK_COMMAND_USAGE} or /status, /end (in a thread)`;

const GC_EXECUTOR = { executor: 'claude' as const, executor_model: 'sonnet' as const };

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
    return {
      kind: 'not_thread',
      threadContext: null,
      inheritedTaskType: null,
      inheritedSessionId: null,
      inheritedExecutor: null,
      inheritedExecutorModel: null,
    };
  }

  if ('kind' in result) {
    return result;
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

export class EnrichmentPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly apiUrl: string,
    private readonly taskDaemonStatusUrl: string,
    private readonly enrichmentService: EnrichmentService,
    private readonly threadContextFetcher?: ThreadContextFetcher,
    private readonly phasePublisher: TaskPhasePublisher = new TaskPhasePublisher(apiUrl),
  ) {}

  async pollOnce(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/tasks/next`);

      if (res.status === 204) {
        logger.debug('No tasks available');
        return;
      }

      if (res.status !== 200) {
        logger.warn({ status: res.status }, 'Unexpected response from API');
        return;
      }

      const task = (await res.json()) as Task;
      logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Received task for enrichment');
      await this.publishPhase(task, 'enriching');

      const isCleanupTask = task.task_type === CLEANUP_TASK_TYPE;
      const isGcTask = task.task_type === GC_TASK_TYPE;
      const isNewInstanceTask = task.task_type === NEW_INSTANCE_TASK_TYPE;
      const isStatusTask = task.task_type === STATUS_TASK_TYPE;
      const isThreadReplyTask = task.task_type === THREAD_REPLY_TASK_TYPE;
      let threadResult: ThreadContextResult | undefined;

      if (isCleanupTask && task.task_source?.source !== 'lark') {
        logger.warn({ task_id: task.task_id, task_source: task.task_source }, 'Rejected cleanup task without lark task_source');
        await this.publishRejection(task, CLEANUP_MISSING_SOURCE_REASON);
        await this.ackTask(task.task_id);
        return;
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
          await this.publishRejection(task, threadResult.reason ?? THREAD_LOOKUP_ERROR_REASON);
          await this.ackTask(task.task_id);
          return;
        }

        if (isThreadReplyTask && threadResult.kind === 'not_thread') {
          logger.warn({ task_id: task.task_id }, 'Rejected root thread_reply continuation candidate');
          await this.publishRejection(task, ROOT_TASK_USAGE_HINT);
          await this.ackTask(task.task_id);
          return;
        }

        if (isCleanupTask && threadResult.kind === 'not_thread') {
          logger.warn({ task_id: task.task_id }, 'Rejected cleanup task without thread context');
          await this.publishRejection(task, formatThreadOnlyCommandMessage('/end'));
          await this.ackTask(task.task_id);
          return;
        }

        if (isNewInstanceTask && threadResult.kind === 'not_thread') {
          logger.warn({ task_id: task.task_id }, 'Rejected new_instance task outside thread');
          await this.publishRejection(task, formatThreadOnlyCommandMessage('/new'));
          await this.ackTask(task.task_id);
          return;
        }

        if (isStatusTask && threadResult.kind === 'not_thread') {
          logger.warn({ task_id: task.task_id }, 'Rejected status task outside thread');
          await this.publishRejection(task, formatThreadOnlyCommandMessage('/status'));
          await this.ackTask(task.task_id);
          return;
        }

        if (threadResult.kind === 'thread' && !isControlTaskType(task.task_type) && !isThreadReplyTask) {
          logger.warn(
            { task_id: task.task_id, task_type: task.task_type },
            'Rejected non-control Lark task in a thread',
          );
          await this.publishRejection(task, formatThreadTaskCommandRejectedMessage());
          await this.ackTask(task.task_id);
          return;
        }
      }

      if (isGcTask && threadResult?.kind === 'thread') {
        logger.warn({ task_id: task.task_id }, 'Rejected gc task inside thread');
        await this.publishRejection(task, GC_THREAD_REJECTION_REASON);
        await this.ackTask(task.task_id);
        return;
      }

      if (isGcTask) {
        const jobSubmission: JobSubmission = {
          task_id: task.task_id,
          task_type: GC_TASK_TYPE,
          payload: '',
          executors: [GC_EXECUTOR],
          submitted_at: task.submitted_at,
          session_id: generateSessionId(),
          ...(task.task_source ? { task_source: task.task_source } : {}),
        };

        try {
          const jobRes = await fetch(`${this.apiUrl}/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(jobSubmission),
          });
          if (jobRes.status !== 201) {
            logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed for gc task — not acking task');
            return;
          }
          await this.publishPhase(task, 'queued');
        } catch (jobErr) {
          logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed for gc task — not acking task');
          return;
        }

        await this.ackTask(task.task_id);
        return;
      }

      if (isNewInstanceTask && task.task_source?.source !== 'lark') {
        logger.warn({ task_id: task.task_id, task_source: task.task_source }, 'Rejected new_instance task without lark task_source');
        await this.publishRejection(task, NEW_INSTANCE_MISSING_SOURCE_REASON);
        await this.ackTask(task.task_id);
        return;
      }

      if (isNewInstanceTask && threadResult?.kind === 'thread' && !threadResult.inheritedSessionId) {
        logger.warn({ task_id: task.task_id }, 'Rejected new_instance task without inherited session_id');
        await this.publishRejection(task, NEW_INSTANCE_MISSING_SESSION_REASON);
        await this.ackTask(task.task_id);
        return;
      }

      if (isStatusTask) {
        if (threadResult?.kind !== 'thread' || !threadResult.inheritedSessionId) {
          logger.warn({ task_id: task.task_id, threadResult }, 'Rejected status task without inherited session_id');
          await this.publishRejection(task, STATUS_MISSING_SESSION_REASON);
          await this.ackTask(task.task_id);
          return;
        }

        if (!threadResult.inheritedTaskType || !threadResult.inheritedExecutor || !threadResult.inheritedExecutorModel) {
          logger.warn({ task_id: task.task_id, threadResult }, 'Rejected status task with incomplete inherited metadata');
          await this.publishRejection(task, STATUS_INCOMPLETE_METADATA_REASON);
          await this.ackTask(task.task_id);
          return;
        }

        try {
          const timeoutSignal = AbortSignal.timeout(1000);
          const statusRes = await fetch(
            `${this.taskDaemonStatusUrl}/status/${encodeURIComponent(threadResult.inheritedSessionId)}`,
            { signal: timeoutSignal },
          );

          if (statusRes.status !== 200) {
            logger.error({ task_id: task.task_id, status: statusRes.status }, 'GET /status failed for status task');
            await this.publishRejection(task, STATUS_LOOKUP_FAILURE_REASON);
            await this.ackTask(task.task_id);
            return;
          }

          const statusBody = (await statusRes.json()) as { running?: boolean };
          await this.publishStatusResult(task, threadResult, statusBody.running === true);
          await this.ackTask(task.task_id);
          return;
        } catch (statusErr) {
          logger.error({ task_id: task.task_id, err: statusErr }, 'Status lookup request failed');
          await this.publishRejection(task, STATUS_LOOKUP_FAILURE_REASON);
          await this.ackTask(task.task_id);
          return;
        }
      }

      if (isNewInstanceTask) {
        const inheritedType = threadResult?.kind === 'thread' ? (threadResult.inheritedTaskType ?? task.task_type) : task.task_type;

        const enrichmentResult = this.enrichmentService.enrich(
          { ...task, task_type: NEW_INSTANCE_TASK_TYPE, payload: NEW_INSTANCE_PROMPT },
          threadResult!.inheritedSessionId!,
          undefined,
        );

        if (enrichmentResult.type === 'rejected') {
          logger.warn({ task_id: task.task_id, reason: enrichmentResult.reason }, 'Enrichment rejected new_instance task');
          await this.publishRejection(task, enrichmentResult.reason);
          await this.ackTask(task.task_id);
          return;
        }

        enrichmentResult.job.skipContinue = true;
        enrichmentResult.job.task_type = inheritedType;
        enrichmentResult.job.executors = [resolveNewInstancePair(task, threadResult!)];

        try {
          const jobRes = await fetch(`${this.apiUrl}/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(enrichmentResult.job),
          });
          if (jobRes.status !== 201) {
            logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed for new_instance — not acking');
            return;
          }
          await this.publishPhase(task, 'queued');
        } catch (jobErr) {
          logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed for new_instance — not acking');
          return;
        }

        await this.ackTask(task.task_id);
        return;
      }

      if (isThreadReplyTask && threadResult?.kind === 'thread') {
        if (
          !threadResult.inheritedTaskType ||
          !threadResult.inheritedSessionId ||
          !threadResult.inheritedExecutor ||
          !threadResult.inheritedExecutorModel
        ) {
          logger.warn({ task_id: task.task_id, threadResult }, 'Rejected thread_reply with incomplete inherited metadata');
          await this.publishRejection(task, THREAD_REPLY_INCOMPLETE_METADATA_REASON);
          await this.ackTask(task.task_id);
          return;
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
          logger.warn({ task_id: task.task_id, task_type: rewrittenTask.task_type, reason: enrichmentResult.reason }, 'Enrichment rejected rewritten thread_reply task');
          await this.publishRejection(task, enrichmentResult.reason);
          await this.ackTask(task.task_id);
          return;
        }

        try {
          const jobRes = await fetch(`${this.apiUrl}/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(enrichmentResult.job),
          });
          if (jobRes.status !== 201) {
            logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed for thread_reply rewrite — not acking task');
            return;
          }
          await this.publishPhase(task, 'queued');
        } catch (jobErr) {
          logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed for thread_reply rewrite — not acking task');
          return;
        }

        await this.ackTask(task.task_id);
        return;
      }

      if (isCleanupTask && threadResult?.kind === 'thread' && !threadResult.inheritedSessionId) {
        logger.warn({ task_id: task.task_id }, 'Rejected cleanup task without inherited session_id');
        await this.publishRejection(task, CLEANUP_REJECTION_REASON);
        await this.ackTask(task.task_id);
        return;
      }

      const sessionId = threadResult?.kind === 'thread' && threadResult.inheritedSessionId
        ? threadResult.inheritedSessionId
        : generateSessionId();
      if (threadResult?.kind === 'thread' && threadResult.inheritedSessionId) {
        logger.info({ task_id: task.task_id, inherited_session_id: sessionId }, 'Inherited session_id from thread root');
      } else {
        logger.info({ task_id: task.task_id, new_session_id: sessionId }, 'Generated new session_id for enrichment');
      }

      const threadHistory = isCleanupTask || threadResult?.kind !== 'thread'
        ? undefined
        : (threadResult.threadContext ?? undefined);
      const enrichmentResult = this.enrichmentService.enrich(task, sessionId, threadHistory);

      if (enrichmentResult.type === 'rejected') {
        logger.warn({ task_id: task.task_id, task_type: task.task_type, reason: enrichmentResult.reason }, 'Enrichment rejected task');
        await this.publishRejection(task, enrichmentResult.reason);
        await this.ackTask(task.task_id);
        return;
      }

      try {
        const jobRes = await fetch(`${this.apiUrl}/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enrichmentResult.job),
        });
        if (jobRes.status !== 201) {
          logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed — not acking task');
          return;
        }
        await this.publishPhase(task, 'queued');
      } catch (jobErr) {
        logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed — not acking task');
        return;
      }

      await this.ackTask(task.task_id);
    } catch (err) {
      logger.error({ err }, 'Enrichment poll error');
    }
  }

  private async publishRejection(task: Task, reason: string): Promise<void> {
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status !== 201) {
        logger.error({ task_id: task.task_id, status: res.status }, 'POST /results failed for rejection');
      } else {
        logger.info({ task_id: task.task_id }, 'Published rejection result');
      }
    } catch (err) {
      logger.error({ task_id: task.task_id, err }, 'Failed to publish rejection result');
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
    running: boolean,
  ): Promise<void> {
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
        stdout: running ? 'Executor is running' : 'Executor is not running',
        stderr: '',
        ...(task.task_source ? { task_source: task.task_source } : {}),
      };

      const res = await fetch(`${this.apiUrl}/results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.status !== 201) {
        logger.error({ task_id: task.task_id, status: res.status }, 'POST /results failed for status result');
      }
    } catch (err) {
      logger.error({ task_id: task.task_id, err }, 'Failed to publish status result');
    }
  }

  private async ackTask(taskId: string): Promise<void> {
    try {
      const ackRes = await fetch(`${this.apiUrl}/tasks/${taskId}/ack`, { method: 'POST' });
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
      await this.pollOnce();
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
      logger.info('Enrichment poller stopped');
    }
  }
}
