# Session Workspace & Thread Task Type Enforcement Implementation Plan

**Goal:** Make tasks with the same session_id execute in a deterministic persistent directory, and enforce that thread messages always inherit the root task_type (rejecting conflicting `/task` commands).

**Architecture:** Two changes: (1) `JobEnvironment` switches from per-job temp dirs to `/var/tmp/local-agent/session/<session_id>`, skipping setup when the dir already exists and never tearing down. `TaskOrchestrator` calls setup once before the executor retry loop. (2) `EnrichmentPoller` always overrides task_type with the inherited value in threads, rejecting mismatches via the existing `publishRejection()` path.

**Tech Stack:** TypeScript, Node.js (fs, child_process), Vitest

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/daemon/task/src/services/job-environment.ts` | Session-based workspace path, skip-if-exists, no-op teardown |
| Modify | `packages/daemon/task/src/services/setup-hook-runner.ts` | Add `session_id` to `JobContext` and hook env vars |
| Modify | `packages/daemon/task/src/core/task-orchestrator.ts` | Setup once before retry loop, remove teardown |
| Modify | `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Thread task_type enforcement with mismatch rejection |
| Modify | `packages/daemon/task/src/__tests__/task-poller.test.ts` | Update tests for new orchestrator flow |
| Create | `packages/daemon/task/src/__tests__/job-environment.test.ts` | Unit tests for session workspace |
| Modify | `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Add thread task_type enforcement tests, update existing |

---

### Task 1: Add `session_id` to `SetupHookRunner.JobContext` and hook env vars

**Files:**
- Modify: `packages/daemon/task/src/services/setup-hook-runner.ts:8-13` (JobContext interface)
- Modify: `packages/daemon/task/src/services/setup-hook-runner.ts:24-30` (env object)

- [ ] **Step 1: Add `session_id` to the `JobContext` interface**

In `packages/daemon/task/src/services/setup-hook-runner.ts`, add `session_id` to the interface:

```typescript
interface JobContext {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  session_id: string;
}
```

- [ ] **Step 2: Add `LOCALAGENT_SESSION_ID` to the env object**

In the same file, add to the env record (line 24-30):

```typescript
const env: Record<string, string> = {
  ...process.env as Record<string, string>,
  LOCALAGENT_JOB_ID: jobContext.job_id,
  LOCALAGENT_TASK_ID: jobContext.task_id,
  LOCALAGENT_TASK_TYPE: jobContext.task_type,
  LOCALAGENT_PAYLOAD: jobContext.payload,
  LOCALAGENT_SESSION_ID: jobContext.session_id,
};
```

- [ ] **Step 3: Update the `setup()` call in `job-environment.ts` to pass `session_id`**

In `packages/daemon/task/src/services/job-environment.ts:56-62`, add `session_id` to the `jobContext` object passed to `hookRunner.run()`:

```typescript
await this.hookRunner.run(
  job.setup_hook,
  workDir,
  {
    job_id: job.job_id,
    task_id: job.task_id,
    task_type: job.task_type,
    payload: job.payload,
    session_id: job.session_id,
  },
  timeoutMs,
);
```

- [ ] **Step 4: Verify build**

Run:
```bash
cd packages/daemon/task && npx tsc --noEmit
```
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/services/setup-hook-runner.ts packages/daemon/task/src/services/job-environment.ts
git commit -m "feat(task-daemon): add LOCALAGENT_SESSION_ID to setup hook env"
```

---

### Task 2: Convert `JobEnvironment` to session-based workspace

**Files:**
- Modify: `packages/daemon/task/src/services/job-environment.ts`
- Create: `packages/daemon/task/src/__tests__/job-environment.test.ts`

- [ ] **Step 1: Write failing tests for session workspace**

Create `packages/daemon/task/src/__tests__/job-environment.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Job } from '@local-agent/shared';

// Mock setup-hook-runner
const mockHookRun = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/setup-hook-runner', () => ({
  SetupHookRunner: vi.fn().mockImplementation(() => ({
    run: mockHookRun,
  })),
}));

// Mock child_process for git clone
const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  execFile: vi.fn(),
}));

import { JobEnvironment } from '../services/job-environment';

const SESSION_BASE = '/var/tmp/local-agent/session';

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'task-123',
    session_id: 'test-session-aaa',
    task_type: 'deploy',
    payload: 'hello',
    executors: [{ executor: 'claude_code', executor_model: 'opus' }],
    submitted_at: '2026-04-01T00:00:00.000Z',
    enriched_at: '2026-04-01T00:00:01.000Z',
    ...overrides,
  };
}

describe('JobEnvironment', () => {
  let jobEnv: JobEnvironment;
  const sessionDir = join(SESSION_BASE, 'test-session-aaa');

  beforeEach(() => {
    vi.clearAllMocks();
    jobEnv = new JobEnvironment(false);
    // Clean up test session dir if it exists from a previous test
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  describe('setup', () => {
    it('creates session directory at /var/tmp/local-agent/session/<session_id>', async () => {
      const job = createJob();
      const env = await jobEnv.setup(job);

      expect(env.workDir).toBe(sessionDir);
      expect(existsSync(sessionDir)).toBe(true);
    });

    it('runs setup hook for new session directory', async () => {
      const job = createJob({ setup_hook: 'echo hello' });
      await jobEnv.setup(job);

      expect(mockHookRun).toHaveBeenCalledOnce();
      expect(mockHookRun).toHaveBeenCalledWith(
        'echo hello',
        sessionDir,
        expect.objectContaining({
          job_id: 'job-456',
          task_id: 'task-123',
          task_type: 'deploy',
          session_id: 'test-session-aaa',
        }),
        expect.any(Number),
      );
    });

    it('skips setup hook when session directory already exists', async () => {
      // Pre-create the directory
      mkdirSync(sessionDir, { recursive: true });

      const job = createJob({ setup_hook: 'echo hello' });
      const env = await jobEnv.setup(job);

      expect(env.workDir).toBe(sessionDir);
      expect(mockHookRun).not.toHaveBeenCalled();
    });

    it('skips marketplace cloning when session directory already exists', async () => {
      mkdirSync(sessionDir, { recursive: true });

      const job = createJob({
        marketplaces: [{ url: 'https://github.com/org/repo.git', plugins: ['plugin-a'] }],
      });
      const env = await jobEnv.setup(job);

      expect(env.workDir).toBe(sessionDir);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('removes directory on setup failure when not in debug mode', async () => {
      mockHookRun.mockRejectedValueOnce(new Error('hook failed'));

      const job = createJob({ setup_hook: 'bad-command' });
      await expect(jobEnv.setup(job)).rejects.toThrow('hook failed');

      expect(existsSync(sessionDir)).toBe(false);
    });

    it('preserves directory on setup failure when in debug mode', async () => {
      const debugEnv = new JobEnvironment(true);
      mockHookRun.mockRejectedValueOnce(new Error('hook failed'));

      const job = createJob({ setup_hook: 'bad-command' });
      await expect(debugEnv.setup(job)).rejects.toThrow('hook failed');

      expect(existsSync(sessionDir)).toBe(true);
    });

    it('returns empty pluginDirs when no marketplaces configured', async () => {
      const job = createJob();
      const env = await jobEnv.setup(job);
      expect(env.pluginDirs).toEqual([]);
    });
  });

  describe('teardown', () => {
    it('is a no-op — directory persists after teardown', async () => {
      const job = createJob();
      const env = await jobEnv.setup(job);
      await jobEnv.teardown(env);
      expect(existsSync(sessionDir)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd packages/daemon/task && npx vitest run src/__tests__/job-environment.test.ts
```
Expected: Multiple failures — `setup()` still uses `/tmp/localagent-job-<job_id>` path.

- [ ] **Step 3: Implement session-based workspace in `JobEnvironment`**

Replace the contents of `packages/daemon/task/src/services/job-environment.ts`:

```typescript
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Job, DEFAULT_SETUP_HOOK_TIMEOUT_MS, createLogger } from '@local-agent/shared';
import { SetupHookRunner } from './setup-hook-runner';

const logger = createLogger('task-daemon:job-environment');

export interface ExecutionEnvironment {
  workDir: string;
  pluginDirs: string[];
}

export class JobEnvironment {
  private static readonly SESSION_BASE = '/var/tmp/local-agent/session';

  constructor(
    private readonly debug: boolean,
    private readonly hookRunner: SetupHookRunner = new SetupHookRunner(),
  ) {}

  async setup(job: Job): Promise<ExecutionEnvironment> {
    const workDir = join(JobEnvironment.SESSION_BASE, job.session_id);

    if (existsSync(workDir)) {
      logger.info({ job_id: job.job_id, session_id: job.session_id, workDir }, 'Reusing existing session workspace');
      const pluginDirs = this.collectPluginDirs(job, workDir);
      return { workDir, pluginDirs };
    }

    mkdirSync(workDir, { recursive: true });

    const pluginDirs: string[] = [];

    try {
      if (job.marketplaces && job.marketplaces.length > 0) {
        const marketplacesDir = join(workDir, 'marketplaces');
        mkdirSync(marketplacesDir, { recursive: true });

        for (const marketplace of job.marketplaces) {
          const repoName = this.deriveRepoName(marketplace.url);
          const cloneDest = join(marketplacesDir, repoName);

          logger.info({ job_id: job.job_id, url: marketplace.url, dest: cloneDest }, 'Cloning marketplace repo');

          execFileSync('git', ['clone', '--depth', '1', marketplace.url, cloneDest], {
            timeout: 60_000,
          });

          for (const plugin of marketplace.plugins) {
            const pluginPath = join(cloneDest, plugin);
            if (!existsSync(pluginPath)) {
              throw new Error(`Plugin directory "${plugin}" not found in cloned repo "${repoName}" at ${pluginPath}`);
            }
            pluginDirs.push(pluginPath);
          }
        }
      }

      if (job.setup_hook) {
        const timeoutMs = job.setup_hook_timeout_ms ?? DEFAULT_SETUP_HOOK_TIMEOUT_MS;
        await this.hookRunner.run(
          job.setup_hook,
          workDir,
          {
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            payload: job.payload,
            session_id: job.session_id,
          },
          timeoutMs,
        );
      }
    } catch (error) {
      if (!this.debug) {
        rmSync(workDir, { recursive: true, force: true });
      }
      throw error;
    }

    logger.info({ job_id: job.job_id, workDir, pluginDirs }, 'Job environment ready');
    return { workDir, pluginDirs };
  }

  async teardown(_env: ExecutionEnvironment): Promise<void> {
    // No-op: session directories persist for reuse
    logger.debug({ workDir: _env.workDir }, 'Teardown skipped — session workspace persists');
  }

  private collectPluginDirs(job: Job, workDir: string): string[] {
    if (!job.marketplaces || job.marketplaces.length === 0) return [];

    const pluginDirs: string[] = [];
    for (const marketplace of job.marketplaces) {
      const repoName = this.deriveRepoName(marketplace.url);
      for (const plugin of marketplace.plugins) {
        const pluginPath = join(workDir, 'marketplaces', repoName, plugin);
        if (existsSync(pluginPath)) {
          pluginDirs.push(pluginPath);
        }
      }
    }
    return pluginDirs;
  }

  private deriveRepoName(url: string): string {
    const lastSegment = url.split('/').pop() ?? url;
    return lastSegment.replace(/\.git$/, '');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd packages/daemon/task && npx vitest run src/__tests__/job-environment.test.ts
```
Expected: All tests PASS.

- [ ] **Step 5: Verify existing tests still pass**

Run:
```bash
cd packages/daemon/task && npx vitest run
```
Expected: All tests pass (task-poller tests use mocked JobEnvironment).

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task/src/services/job-environment.ts packages/daemon/task/src/__tests__/job-environment.test.ts
git commit -m "feat(task-daemon): use session-based workspace at /var/tmp/local-agent/session/<session_id>"
```

---

### Task 3: Refactor `TaskOrchestrator` to setup once and remove teardown

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
- Modify: `packages/daemon/task/src/__tests__/task-poller.test.ts`

- [ ] **Step 1: Write failing test — setup called once for multi-executor job**

Add to `packages/daemon/task/src/__tests__/task-poller.test.ts`, inside the `describe('pollOnce', ...)` block:

```typescript
it('calls setup once and teardown never for multi-executor job', async () => {
  const failResult: TaskResultSubmission = {
    job_id: 'job-456',
    task_id: 'abc-123',
    session_id: 'session-789',
    task_type: 'generic',
    status: 'failure',
    exit_code: 1,
    stdout: '',
    stderr: 'failed',
  };
  const successResult: TaskResultSubmission = { ...mockResultSubmission };
  mockClaudeExecute
    .mockResolvedValueOnce(failResult)
    .mockResolvedValueOnce(successResult);

  const job = createJob({
    executors: [
      { executor: 'claude_code', executor_model: 'opus' },
      { executor: 'claude_code', executor_model: 'sonnet' },
    ],
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(job) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockSetup).toHaveBeenCalledTimes(1);
  expect(mockTeardown).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd packages/daemon/task && npx vitest run src/__tests__/task-poller.test.ts -t "calls setup once"
```
Expected: FAIL — currently setup/teardown are called per executor attempt.

- [ ] **Step 3: Refactor `TaskOrchestrator.handle()`**

Replace the `handle()` method in `packages/daemon/task/src/core/task-orchestrator.ts`:

```typescript
async handle(job: Job): Promise<TaskResultSubmission> {
  logger.info(
    { job_id: job.job_id, task_id: job.task_id, task_type: job.task_type, executors: job.executors },
    'Processing job',
  );

  if (job.executors.length === 0) {
    logger.error({ job_id: job.job_id }, 'Job has empty executors array');
    return {
      job_id: job.job_id,
      task_id: job.task_id,
      task_type: job.task_type,
      status: 'failure',
      exit_code: null,
      stdout: '',
      stderr: 'Job has no executor preferences',
    };
  }

  let env: ExecutionEnvironment;
  try {
    env = await this.jobEnv.setup(job);
  } catch (error) {
    logger.error({ job_id: job.job_id, err: error }, 'Environment setup failed');
    return {
      job_id: job.job_id,
      task_id: job.task_id,
      task_type: job.task_type,
      status: 'failure',
      exit_code: null,
      stdout: '',
      stderr: `Environment setup failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let lastResult: TaskResultSubmission | null = null;

  for (let i = 0; i < job.executors.length; i++) {
    const pref = job.executors[i];
    const isLast = i === job.executors.length - 1;

    try {
      const executor = this.resolveExecutor(pref.executor);
      const attempt: JobAttempt = {
        job_id: job.job_id,
        task_id: job.task_id,
        session_id: job.session_id,
        task_type: job.task_type,
        payload: job.payload,
        executor: pref.executor,
        executor_model: pref.executor_model,
        submitted_at: job.submitted_at,
        enriched_at: job.enriched_at,
        system_prompt: job.system_prompt,
        marketplaces: job.marketplaces,
      };

      lastResult = await executor.execute(attempt, env);

      if (lastResult.status === 'success') {
        return lastResult;
      }

      if (!isLast) {
        logger.warn(
          { job_id: job.job_id, executor: pref.executor, model: pref.executor_model, attempt: i + 1 },
          'Executor failed, trying next preference',
        );
      }
    } catch (error) {
      logger.error({ job_id: job.job_id, err: error }, 'Job execution failed');
      lastResult = {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: `Job execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };

      if (!isLast) {
        logger.warn(
          { job_id: job.job_id, executor: pref.executor, model: pref.executor_model, attempt: i + 1 },
          'Executor threw, trying next preference',
        );
      }
    }
  }

  logger.error({ job_id: job.job_id }, 'All executor preferences exhausted');
  return lastResult!;
}
```

Key changes vs. current:
- `setup()` called once before the for-loop
- `finally { await this.jobEnv.teardown(env!) }` removed from inside the loop
- No teardown call anywhere

- [ ] **Step 4: Run the new test to verify it passes**

Run:
```bash
cd packages/daemon/task && npx vitest run src/__tests__/task-poller.test.ts -t "calls setup once"
```
Expected: PASS.

- [ ] **Step 5: Run all task-daemon tests**

Run:
```bash
cd packages/daemon/task && npx vitest run
```
Expected: All tests pass. Some existing tests may need `mockTeardown` expectations updated (remove any `toHaveBeenCalled` assertions on teardown).

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/__tests__/task-poller.test.ts
git commit -m "refactor(task-daemon): setup once before executor loop, remove teardown"
```

---

### Task 4: Thread task_type enforcement in `EnrichmentPoller`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts:39-48`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing tests for thread task_type enforcement**

Add these tests to the `describe('EnrichmentPoller with ThreadContextFetcher', ...)` block in `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`:

```typescript
it('rejects task when /task type differs from inherited thread type', async () => {
  const task = createTask({
    task_type: 'code_review',  // User sent /task code_review
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'review this',
  });
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: deploy\nassistant: done',
    inheritedTaskType: 'deploy',  // Thread root is deploy
    inheritedSessionId: null,
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    // POST /results (rejection)
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
    // POST /tasks/:id/ack
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  // Should NOT call enrich
  expect(mockEnrich).not.toHaveBeenCalled();
  // Should publish rejection result
  expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: expect.stringContaining('Cannot change task type in a thread'),
  });
  // Should ack the task
  expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
    method: 'POST',
  });
});

it('accepts task when /task type matches inherited thread type', async () => {
  const task = createTask({
    task_type: 'deploy',  // User sent /task deploy — matches thread
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'deploy again',
  });
  const jobSubmission = createJobSubmission({ task_type: 'deploy' });
  mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: deploy\nassistant: done',
    inheritedTaskType: 'deploy',
    inheritedSessionId: null,
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({ task_type: 'deploy' }),
    'generated-session-id',
  );
});

it('always inherits task_type in thread even when current is not generic', async () => {
  const task = createTask({
    task_type: 'deploy',  // Same as inherited — should be accepted and overridden
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'another deploy',
  });
  const jobSubmission = createJobSubmission({ task_type: 'deploy' });
  mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: null,
    inheritedTaskType: 'deploy',
    inheritedSessionId: null,
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  // task_type should be set to inherited value
  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({ task_type: 'deploy' }),
    'generated-session-id',
  );
});
```

- [ ] **Step 2: Update the existing test "does not override task_type when current is not generic"**

This test (line 382-407) asserts the OLD behavior where non-generic types are preserved even when inherited type differs. It now needs to expect REJECTION instead. Replace the test:

```typescript
it('rejects when task_type differs from inherited type in thread (was: does not override)', async () => {
  const task = createTask({
    task_type: 'code_review',
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'review this',
  });
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: review code\nassistant: Job abc — success',
    inheritedTaskType: 'deploy',
    inheritedSessionId: null,
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  // Should reject, not enrich
  expect(mockEnrich).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: expect.stringContaining('Cannot change task type in a thread'),
  });
});
```

- [ ] **Step 3: Run tests to verify failures**

Run:
```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts
```
Expected: New tests fail, old updated test fails — enrichment poller still uses old logic.

- [ ] **Step 4: Implement thread task_type enforcement**

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`, replace lines 40-46 (the existing `if (task.task_type === 'generic' && threadResult.inheritedTaskType)` block and the `threadContext` prepend section) with:

```typescript
if (threadResult.inheritedTaskType) {
  if (task.task_type !== 'generic' && task.task_type !== threadResult.inheritedTaskType) {
    const reason = `Cannot change task type in a thread. This thread uses task_type '${threadResult.inheritedTaskType}'. Remove the /task prefix or start a new conversation.`;
    logger.warn({ task_id: task.task_id, submitted_type: task.task_type, inherited_type: threadResult.inheritedTaskType }, reason);
    await this.publishRejection(task, reason);
    await this.ackTask(task.task_id);
    return;
  }
  task.task_type = threadResult.inheritedTaskType;
  logger.info({ task_id: task.task_id, inherited_task_type: threadResult.inheritedTaskType }, 'Inherited task_type from thread');
}
if (threadResult.threadContext) {
  task.payload = `--- Thread Context ---\n${threadResult.threadContext}\n--- Current Message ---\n${task.payload}`;
  logger.info({ task_id: task.task_id }, 'Prepended thread context to payload');
}
```

This replaces the previous block:
```typescript
if (task.task_type === 'generic' && threadResult.inheritedTaskType) {
  task.task_type = threadResult.inheritedTaskType;
  logger.info({ task_id: task.task_id, inherited_task_type: threadResult.inheritedTaskType }, 'Inherited task_type from thread root');
}
if (threadResult.threadContext) {
  task.payload = `--- Thread Context ---\n${threadResult.threadContext}\n--- Current Message ---\n${task.payload}`;
  logger.info({ task_id: task.task_id }, 'Prepended thread context to payload');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts
```
Expected: All tests PASS.

- [ ] **Step 6: Run all enrichment daemon tests**

Run:
```bash
cd packages/daemon/task-enrichment && npx vitest run
```
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): enforce thread task_type inheritance, reject mismatches"
```

---

### Task 5: Final verification

**Files:** (none — verification only)

- [ ] **Step 1: Run all tests across both packages**

Run:
```bash
cd packages/daemon/task && npx vitest run && cd ../../daemon/task-enrichment && npx vitest run
```
Expected: All tests pass in both packages.

- [ ] **Step 2: Type-check both packages**

Run:
```bash
cd packages/daemon/task && npx tsc --noEmit && cd ../../daemon/task-enrichment && npx tsc --noEmit
```
Expected: No type errors.

- [ ] **Step 3: Verify /var/tmp/local-agent/session path works on the target system**

Run:
```bash
mkdir -p /var/tmp/local-agent/session/test-verify && ls -la /var/tmp/local-agent/session/ && rm -rf /var/tmp/local-agent/session/test-verify
```
Expected: Directory created and listed successfully. `/var/tmp` exists on macOS and Linux and survives reboots (unlike `/tmp` on some systems).
