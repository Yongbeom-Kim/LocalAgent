# Session Directory Garbage Collection (`/gc`) Implementation Plan

**Goal:** Add a `/gc` slash command that cleans up session directories older than 7 days, flowing through the existing task pipeline with thread rejection in the enrichment daemon and cleanup execution in the task-daemon.

**Architecture:** Lark-listener detects `/gc` and submits a task with `task_type='gc'`. The enrichment daemon bypasses normal enrichment for gc tasks — rejecting if in a thread, otherwise creating a minimal job. The task-daemon short-circuits gc jobs before environment setup, delegating to a new `GcExecutor` that scans `/var/tmp/local-agent/session/*`, checks mtime+atime against a 7-day TTL, and removes stale directories.

**Tech Stack:** TypeScript, vitest, Node.js `fs` module (`readdirSync`, `statSync`, `rmSync`), existing task pipeline

---

### Task 1: Add Shared Constants (`SESSION_BASE_DIR`, `SESSION_DIR_TTL_DAYS`)

**Files:**
- Modify: `packages/shared/src/constants.ts:1-14`
- Modify: `packages/shared/src/index.ts:29-43`

- [ ] **Step 1: Add constants to `constants.ts`**

Append to the end of `packages/shared/src/constants.ts`:

```typescript
export const SESSION_BASE_DIR = '/var/tmp/local-agent/session';
export const SESSION_DIR_TTL_DAYS = 7;
```

- [ ] **Step 2: Re-export from `index.ts`**

In `packages/shared/src/index.ts`, add `SESSION_BASE_DIR` and `SESSION_DIR_TTL_DAYS` to the existing constants re-export block (line 30-43):

```typescript
export {
  DEFAULT_QUEUE_NAME,
  DEFAULT_PORT,
  DEFAULT_RABBITMQ_URL,
  DEFAULT_API_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_RESULTS_EXCHANGE_NAME,
  DEFAULT_LARK_QUEUE_NAME,
  DEFAULT_JOBS_QUEUE_NAME,
  DEFAULT_TELEGRAM_QUEUE_NAME,
  DEFAULT_SETUP_HOOK_TIMEOUT_MS,
  MAX_SNIPPET_CHARS,
  GLOBAL_SYSTEM_PROMPT,
  SESSION_BASE_DIR,
  SESSION_DIR_TTL_DAYS,
} from './constants';
```

- [ ] **Step 3: Build shared package**

Run: `cd packages/shared && npx tsc --build`
Expected: Clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/index.ts
git commit -m "feat(shared): add SESSION_BASE_DIR and SESSION_DIR_TTL_DAYS constants"
```

---

### Task 2: Use `SESSION_BASE_DIR` in `job-environment.ts`

**Files:**
- Modify: `packages/daemon/task/src/services/job-environment.ts:1-4,21`
- Test: `packages/daemon/task/src/services/__tests__/job-environment.test.ts`

- [ ] **Step 1: Update import and usage**

In `packages/daemon/task/src/services/job-environment.ts`:

Update the import on line 4 to include `SESSION_BASE_DIR`:

```typescript
import { Job, DEFAULT_SETUP_HOOK_TIMEOUT_MS, SESSION_BASE_DIR, createLogger } from '@local-agent/shared';
```

Update line 21 to use the constant:

```typescript
const workDir = join(SESSION_BASE_DIR, job.session_id);
```

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `cd packages/daemon/task && npx vitest run src/services/__tests__/job-environment.test.ts`
Expected: All existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/task/src/services/job-environment.ts
git commit -m "refactor(task-daemon): use SESSION_BASE_DIR constant in job-environment"
```

---

### Task 3: Detect `/gc` in Lark-Listener `MessageHandler`

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts:69-90`
- Test: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`

- [ ] **Step 1: Write failing tests for `/gc` command parsing**

Add a new `describe('/gc command parsing')` block at the end of the test file (inside the outer `describe('MessageHandler')`), after the existing `/task command parsing` block:

```typescript
describe('/gc command parsing', () => {
  it('submits /gc as task_type gc with empty payload', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/gc' }),
    }));

    expect(submitter.submit).toHaveBeenCalledWith(
      'gc',
      '',
      { source: 'lark', message_id: 'om_msg1' },
    );
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
  });

  it('does not treat /gc with arguments as a gc command', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/gc force' }),
    }));

    expect(submitter.submit).toHaveBeenCalledWith(
      'generic',
      '/gc force',
      { source: 'lark', message_id: 'om_msg1' },
    );
  });

  it('does not treat /gcollect as a gc command', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/gcollect' }),
    }));

    expect(submitter.submit).toHaveBeenCalledWith(
      'generic',
      '/gcollect',
      { source: 'lark', message_id: 'om_msg1' },
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: `/gc command parsing` tests fail (currently `/gc` is not recognized, so it submits as `generic` with payload `/gc`).

- [ ] **Step 3: Implement `/gc` detection in `parseCommand`**

In `packages/daemon/lark-listener/src/message-handler.ts`, update `parseCommand()` (line 69). Add the `/gc` check at the very beginning of the method, before the `/task` check:

```typescript
private parseCommand(payload: string): { taskType: string | null; taskPayload: string; isCommand: boolean } {
  // /gc — exact match only, no arguments
  if (payload === '/gc') {
    return { taskType: 'gc', taskPayload: '', isCommand: true };
  }

  // Must match exactly "/task" followed by space, newline, or end-of-string.
  // This avoids false positives like "/taskforce" or "/tasklist".
  if (!payload.startsWith('/task ') && !payload.startsWith('/task\n') && payload !== '/task') {
    return { taskType: null, taskPayload: payload, isCommand: false };
  }

  const rest = payload.slice('/task'.length).trimStart();

  if (rest === '') {
    return { taskType: null, taskPayload: '', isCommand: true };
  }

  const spaceIndex = rest.indexOf(' ');
  if (spaceIndex === -1) {
    return { taskType: rest, taskPayload: '', isCommand: true };
  }

  const taskType = rest.substring(0, spaceIndex);
  const taskPayload = rest.substring(spaceIndex + 1);
  return { taskType, taskPayload, isCommand: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: All tests pass, including the 3 new `/gc` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts
git commit -m "feat(lark-listener): detect /gc command in message handler"
```

---

### Task 4: Handle GC Tasks in Enrichment Daemon

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts:1-165`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing test — gc task as base message creates minimal job**

Add a new `describe('GC task handling')` block inside the existing `describe('EnrichmentPoller with ThreadContextFetcher')` block, at the end:

```typescript
describe('GC task handling', () => {
  it('creates minimal gc job for base message (no thread context)', async () => {
    const task = createTask({
      task_type: 'gc',
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: '',
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue(null);

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-gc' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    // Should NOT call enrich
    expect(mockEnrich).not.toHaveBeenCalled();
    // Should POST /jobs with minimal gc job
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('"task_type":"gc"'),
    });
    // Should ack the task
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('rejects gc task sent inside a thread (has inherited data)', async () => {
    const task = createTask({
      task_type: 'gc',
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: '',
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: some message',
      inheritedTaskType: 'deploy',
      inheritedSessionId: 'session-abc',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    // Should NOT call enrich
    expect(mockEnrich).not.toHaveBeenCalled();
    // Should POST /results with rejection
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: 'task-123',
        task_id: 'task-123',
        task_type: 'gc',
        status: 'failure',
        exit_code: null,
        stdout: 'The /gc command can only be used as a base message, not inside a thread.',
        stderr: '',
        task_source: { source: 'lark', message_id: 'om_msg1' },
      }),
    });
    // Should ack
    expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
      method: 'POST',
    });
  });

  it('gc job includes session_id and task_source', async () => {
    const task = createTask({
      task_type: 'gc',
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: '',
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue(null);

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-gc' }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    const jobPostBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(jobPostBody.session_id).toBe('generated-session-id');
    expect(jobPostBody.task_source).toEqual({ source: 'lark', message_id: 'om_msg1' });
    expect(jobPostBody.executors).toEqual([{ executor: 'claude_code', executor_model: 'sonnet' }]);
  });

  it('does not ack gc task when POST /jobs fails', async () => {
    const task = createTask({
      task_type: 'gc',
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: '',
    });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue(null);

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 500 });

    await poller.pollOnce();

    // Only 2 fetch calls — no ack
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: GC tests fail because the enrichment poller has no gc-specific code path yet.

- [ ] **Step 3: Implement GC code path in `enrichment-poller.ts`**

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`, add the GC handling block after the thread context section (after line 64 — `}`), before `const sessionId = ...` (line 66):

```typescript
// --- GC task: bypass enrichment ---
if (task.task_type === 'gc') {
  // Reject if sent inside a thread
  if (threadResult?.inheritedTaskType || threadResult?.inheritedSessionId) {
    const reason = 'The /gc command can only be used as a base message, not inside a thread.';
    await this.publishRejection(task, reason);
    await this.ackTask(task.task_id);
    return;
  }

  // Create minimal job — no enrichment needed
  const gcJob: JobSubmission = {
    task_id: task.task_id,
    task_type: 'gc',
    payload: '',
    executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
    submitted_at: task.submitted_at,
    session_id: generateSessionId(),
    ...(task.task_source ? { task_source: task.task_source } : {}),
  };

  try {
    const jobRes = await fetch(`${this.apiUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(gcJob),
    });
    if (jobRes.status !== 201) {
      logger.error({ task_id: task.task_id, status: jobRes.status }, 'POST /jobs failed for GC job — not acking task');
      return;
    }
  } catch (jobErr) {
    logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed for GC job — not acking task');
    return;
  }

  await this.ackTask(task.task_id);
  logger.info({ task_id: task.task_id }, 'GC job submitted');
  return;
}
```

Also add `JobSubmission` to the import on line 1:

```typescript
import { Task, JobSubmission, createLogger, generateSessionId } from '@local-agent/shared';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: All tests pass, including the 4 new GC tests.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): handle gc tasks with thread rejection and minimal job creation"
```

---

### Task 5: Create `GcExecutor`

**Files:**
- Create: `packages/daemon/task/src/services/gc-executor.ts`
- Create: `packages/daemon/task/src/services/__tests__/gc-executor.test.ts`

- [ ] **Step 1: Write failing tests for `GcExecutor`**

Create `packages/daemon/task/src/services/__tests__/gc-executor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Job } from '@local-agent/shared';

// Use a temp directory to avoid interfering with real sessions
const TEST_SESSION_DIR = '/tmp/local-agent-gc-test/session';

vi.mock('@local-agent/shared', async () => {
  const actual = await vi.importActual<typeof import('@local-agent/shared')>('@local-agent/shared');
  return {
    ...actual,
    SESSION_BASE_DIR: TEST_SESSION_DIR,
  };
});

import { GcExecutor } from '../gc-executor';

function createGcJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-gc-001',
    task_id: 'task-gc-001',
    task_type: 'gc',
    session_id: 'session-gc-001',
    payload: '',
    executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
    submitted_at: '2026-04-01T00:00:00.000Z',
    enriched_at: '2026-04-01T00:00:01.000Z',
    ...overrides,
  };
}

function createSessionDir(name: string, daysOld: number): void {
  const dirPath = join(TEST_SESSION_DIR, name);
  mkdirSync(dirPath, { recursive: true });
  // Write a file so the directory has content
  writeFileSync(join(dirPath, 'marker'), 'test');

  const now = Date.now();
  const pastMs = now - daysOld * 24 * 60 * 60 * 1000;
  const pastDate = new Date(pastMs);
  // Set both atime and mtime to the past
  utimesSync(dirPath, pastDate, pastDate);
}

describe('GcExecutor', () => {
  let executor: GcExecutor;

  beforeEach(() => {
    rmSync(TEST_SESSION_DIR, { recursive: true, force: true });
    executor = new GcExecutor();
  });

  afterEach(() => {
    rmSync(TEST_SESSION_DIR, { recursive: true, force: true });
  });

  it('returns success with zero count when session base dir does not exist', () => {
    const result = executor.execute(createGcJob());

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('GC complete: no session directories found.');
    expect(result.job_id).toBe('job-gc-001');
    expect(result.task_id).toBe('task-gc-001');
    expect(result.task_type).toBe('gc');
  });

  it('returns success with zero count when session dir is empty', () => {
    mkdirSync(TEST_SESSION_DIR, { recursive: true });

    const result = executor.execute(createGcJob());

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('GC complete: removed 0 session(s), retained 0.');
  });

  it('removes directories older than 7 days (both mtime and atime)', () => {
    createSessionDir('stale-session-1', 10);
    createSessionDir('stale-session-2', 8);

    const result = executor.execute(createGcJob());

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('GC complete: removed 2 session(s), retained 0.');
    expect(existsSync(join(TEST_SESSION_DIR, 'stale-session-1'))).toBe(false);
    expect(existsSync(join(TEST_SESSION_DIR, 'stale-session-2'))).toBe(false);
  });

  it('retains directories newer than 7 days', () => {
    createSessionDir('fresh-session', 1);

    const result = executor.execute(createGcJob());

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('GC complete: removed 0 session(s), retained 1.');
    expect(existsSync(join(TEST_SESSION_DIR, 'fresh-session'))).toBe(true);
  });

  it('handles mix of stale and fresh directories', () => {
    createSessionDir('stale', 10);
    createSessionDir('fresh', 2);

    const result = executor.execute(createGcJob());

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('GC complete: removed 1 session(s), retained 1.');
    expect(existsSync(join(TEST_SESSION_DIR, 'stale'))).toBe(false);
    expect(existsSync(join(TEST_SESSION_DIR, 'fresh'))).toBe(true);
  });

  it('propagates task_source to result', () => {
    mkdirSync(TEST_SESSION_DIR, { recursive: true });

    const result = executor.execute(createGcJob({
      task_source: { source: 'lark', message_id: 'om_msg1' },
    }));

    expect(result.task_source).toEqual({ source: 'lark', message_id: 'om_msg1' });
  });

  it('ignores non-directory entries', () => {
    mkdirSync(TEST_SESSION_DIR, { recursive: true });
    writeFileSync(join(TEST_SESSION_DIR, 'stray-file.txt'), 'oops');

    const result = executor.execute(createGcJob());

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('GC complete: removed 0 session(s), retained 0.');
    // The stray file should still be there (not counted or removed)
    expect(existsSync(join(TEST_SESSION_DIR, 'stray-file.txt'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task && npx vitest run src/services/__tests__/gc-executor.test.ts`
Expected: FAIL — module `../gc-executor` not found.

- [ ] **Step 3: Implement `GcExecutor`**

Create `packages/daemon/task/src/services/gc-executor.ts`:

```typescript
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Job, TaskResultSubmission, SESSION_BASE_DIR, SESSION_DIR_TTL_DAYS, createLogger } from '@local-agent/shared';

const logger = createLogger('task-daemon:gc-executor');

export class GcExecutor {
  execute(job: Job): TaskResultSubmission {
    const baseResult = {
      job_id: job.job_id,
      task_id: job.task_id,
      task_type: job.task_type,
      exit_code: 0 as number | null,
      stderr: '',
      ...(job.task_source ? { task_source: job.task_source } : {}),
    };

    if (!existsSync(SESSION_BASE_DIR)) {
      return {
        ...baseResult,
        status: 'success',
        stdout: 'GC complete: no session directories found.',
      };
    }

    const cutoffMs = Date.now() - SESSION_DIR_TTL_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;
    let retained = 0;
    let errors = 0;

    const entries = readdirSync(SESSION_BASE_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const dirPath = join(SESSION_BASE_DIR, entry.name);
      try {
        const stats = statSync(dirPath);

        if (stats.mtimeMs < cutoffMs && stats.atimeMs < cutoffMs) {
          rmSync(dirPath, { recursive: true, force: true });
          logger.info({ session_dir: entry.name }, 'Removed stale session directory');
          removed++;
        } else {
          retained++;
        }
      } catch (err) {
        logger.error({ session_dir: entry.name, err }, 'Failed to process session directory');
        errors++;
      }
    }

    const summary = `GC complete: removed ${removed} session(s), retained ${retained}.${errors > 0 ? ` Errors: ${errors}.` : ''}`;
    logger.info({ removed, retained, errors }, summary);

    return {
      ...baseResult,
      status: 'success',
      stdout: summary,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task && npx vitest run src/services/__tests__/gc-executor.test.ts`
Expected: All 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/services/gc-executor.ts packages/daemon/task/src/services/__tests__/gc-executor.test.ts
git commit -m "feat(task-daemon): add GcExecutor for session directory cleanup"
```

---

### Task 6: Short-Circuit GC Jobs in `TaskOrchestrator`

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts:1-111`
- Test: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Write failing tests for gc job routing**

Add a mock for `GcExecutor` alongside the existing executor mocks (after the `TTADKExecutor` mock block). This follows the same pattern used for `ClaudeCliExecutor` and `TTADKExecutor` — the orchestrator test should not hit the real filesystem:

```typescript
const mockGcResult: TaskResultSubmission = {
  job_id: 'job-456',
  task_id: 'test-123',
  task_type: 'gc',
  status: 'success',
  exit_code: 0,
  stdout: 'GC complete: removed 0 session(s), retained 0.',
  stderr: '',
};
const mockGcExecute = vi.fn().mockReturnValue(mockGcResult);

vi.mock('../../services/gc-executor', () => ({
  GcExecutor: vi.fn(function (this: { execute: typeof mockGcExecute }) {
    this.execute = mockGcExecute;
  }),
}));
```

Also add `GcExecutor` to the imports section (after the existing `import { JobEnvironment }` line):

```typescript
import { GcExecutor } from '../../services/gc-executor';
```

Then add a new `describe('GC job handling')` block at the end of the `describe('TaskOrchestrator')` block, and clear the mock in `beforeEach`:

Add `mockGcExecute.mockClear().mockReturnValue(mockGcResult);` to the existing `beforeEach` block, and `vi.mocked(GcExecutor).mockClear();` alongside the other `.mockClear()` calls.

```typescript
describe('GC job handling', () => {
  it('short-circuits gc jobs without environment setup', async () => {
    const job = createJob({
      task_type: 'gc',
      executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
    });

    const result = await orchestrator.handle(job);

    expect(result.status).toBe('success');
    expect(result.job_id).toBe('job-456');
    expect(result.task_id).toBe('test-123');
    expect(result.task_type).toBe('gc');
    // No environment setup, no executor called
    expect(mockSetup).not.toHaveBeenCalled();
    expect(mockClaudeExecute).not.toHaveBeenCalled();
    expect(mockTTADKExecute).not.toHaveBeenCalled();
    // GcExecutor was called
    expect(GcExecutor).toHaveBeenCalledTimes(1);
    expect(mockGcExecute).toHaveBeenCalledWith(job);
  });
});
```

- [ ] **Step 2: Run tests to verify the new test fails**

Run: `cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: GC test fails — the orchestrator currently tries to set up environment and run Claude for gc jobs.

- [ ] **Step 3: Implement gc short-circuit in `TaskOrchestrator`**

In `packages/daemon/task/src/core/task-orchestrator.ts`, add the import and short-circuit at the top of `handle()`:

Add import at top of file:

```typescript
import { GcExecutor } from '../services/gc-executor';
```

Add short-circuit as the first thing inside `handle()`, before the empty executors check (before line 18):

```typescript
if (job.task_type === 'gc') {
  logger.info({ job_id: job.job_id, task_id: job.task_id }, 'Processing GC job');
  const gcExecutor = new GcExecutor();
  return gcExecutor.execute(job);
}
```

- [ ] **Step 4: Run all task-daemon tests to verify everything passes**

Run: `cd packages/daemon/task && npx vitest run`
Expected: All tests pass (existing + new gc test).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts
git commit -m "feat(task-daemon): short-circuit gc jobs in orchestrator"
```

---

### Task 7: Full Pipeline Verification

- [ ] **Step 1: Run all tests across all affected packages**

```bash
cd packages/shared && npx vitest run
cd packages/daemon/lark-listener && npx vitest run
cd packages/daemon/task-enrichment && npx vitest run
cd packages/daemon/task && npx vitest run
```

Expected: All tests pass in all 4 packages.

- [ ] **Step 2: Build all packages**

```bash
cd packages/shared && npx tsc --build
cd packages/daemon/lark-listener && npx tsc --build
cd packages/daemon/task-enrichment && npx tsc --build
cd packages/daemon/task && npx tsc --build
```

Expected: Clean builds, no type errors.

- [ ] **Step 3: Final commit if any fixups needed**

Only if previous steps required changes. Otherwise skip.
