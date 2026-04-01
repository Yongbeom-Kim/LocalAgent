# Cleanup Task (`/end` Command) Implementation Plan

**Goal:** Allow users to type `/end` in a Lark thread to remove the session workspace directory (`/var/tmp/local-agent/session/<session_id>`), flowing through the full pipeline as a built-in `cleanup` task type.

**Architecture:** Extend the existing pipeline with a new `builtin` executor type and `CleanupExecutor`. The lark-listener detects `/end` and submits a `cleanup` task. The enrichment poller inherits `session_id` from thread context (bypassing task type mismatch checks, skipping context prepending). The task orchestrator skips env setup and routes to `CleanupExecutor`, which performs the `rm -rf`.

**Tech Stack:** TypeScript, Vitest, Node.js `fs` (rmSync)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Add `'builtin'` executor type, `'none'` model |
| `packages/daemon/task-enrichment/config/builtin.yaml` | Create | Enrichment rule for `cleanup` task type |
| `packages/daemon/lark-listener/src/message-handler.ts` | Modify | Detect `/end` command, map to `task_type: 'cleanup'` |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Modify | Bypass task type mismatch for cleanup, skip thread context prepending, reject cleanup without inherited session_id |
| `packages/daemon/task/src/adapters/cleanup-executor.ts` | Create | `CleanupExecutor` — rm -rf session directory |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Modify | Skip env setup for cleanup, register `CleanupExecutor` for `'builtin'` |

---

### Task 1: Add `builtin` executor type and `none` model to shared types

**Files:**
- Modify: `packages/shared/src/types.ts:1-12`
- Test: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write failing tests for the new executor type and model**

Add to `packages/shared/src/__tests__/types.test.ts`:

```typescript
// Inside the existing 'EXECUTOR_MODELS' describe block:
it('defines builtin models', () => {
  expect(EXECUTOR_MODELS.builtin).toEqual(['none']);
});

// Inside the existing 'isValidExecutorModel' describe block:
it('returns true for valid builtin model', () => {
  expect(isValidExecutorModel('builtin', 'none')).toBe(true);
});

it('returns false for invalid builtin model', () => {
  expect(isValidExecutorModel('builtin', 'opus')).toBe(false);
});

// Inside the existing 'getExecutorModelOptions' describe block:
it('returns comma-separated list for builtin', () => {
  expect(getExecutorModelOptions('builtin')).toBe('none');
});

// Inside the existing 'isValidExecutorPreferences' describe block:
it('returns true for builtin executor with none model', () => {
  expect(isValidExecutorPreferences([
    { executor: 'builtin', executor_model: 'none' },
  ])).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/shared && npx vitest run src/__tests__/types.test.ts
```

Expected: FAIL — `EXECUTOR_MODELS.builtin` is undefined, `isValidExecutorModel('builtin', 'none')` returns false.

- [ ] **Step 3: Add `builtin` to `TASK_EXECUTORS` and `EXECUTOR_MODELS`**

In `packages/shared/src/types.ts`, change:

```typescript
export const TASK_EXECUTORS = ['claude_code', 'ttadk'] as const;
```

to:

```typescript
export const TASK_EXECUTORS = ['claude_code', 'ttadk', 'builtin'] as const;
```

And change:

```typescript
export const EXECUTOR_MODELS = {
  claude_code: ['opus', 'sonnet', 'haiku'],
  ttadk: ['glm-5-ttadk', 'kimi-k2.5', 'glm-4.7-ttadk', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.2-codex'],
} as const satisfies Record<TaskExecutorType, readonly string[]>;
```

to:

```typescript
export const EXECUTOR_MODELS = {
  claude_code: ['opus', 'sonnet', 'haiku'],
  ttadk: ['glm-5-ttadk', 'kimi-k2.5', 'glm-4.7-ttadk', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.2-codex'],
  builtin: ['none'],
} as const satisfies Record<TaskExecutorType, readonly string[]>;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/shared && npx vitest run src/__tests__/types.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): add builtin executor type with none model"
```

---

### Task 2: Create `builtin.yaml` enrichment config

**Files:**
- Create: `packages/daemon/task-enrichment/config/builtin.yaml`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Write failing test for cleanup enrichment rule**

Add to the end of `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`:

```typescript
describe('cleanup rule enrichment', () => {
  it('enriches cleanup task with builtin executor and none model', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        cleanup: {
          executors: [{ executor: 'builtin', executor_model: 'none' }],
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'cleanup' }), TEST_SESSION_ID);

    expect(result.type).toBe('enriched');
    const enriched = result as { type: 'enriched'; job: JobSubmission };
    expect(enriched.job.task_type).toBe('cleanup');
    expect(enriched.job.session_id).toBe(TEST_SESSION_ID);
    expect(enriched.job.executors).toEqual([{ executor: 'builtin', executor_model: 'none' }]);
    expect(enriched.job.setup_hook).toBeUndefined();
    expect(enriched.job.marketplaces).toBeUndefined();
  });
});
```

Note: `createTask` and `TEST_SESSION_ID` are already defined in this test file. Check them before running — they should be at the top of the file.

- [ ] **Step 2: Run test to verify it passes**

This test should already pass since the enrichment service just looks up the rule key. No code changes are needed for this step:

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts -t "cleanup rule enrichment"
```

Expected: PASS — the enrichment service is generic and handles any valid executor/model combination.

- [ ] **Step 3: Create the `builtin.yaml` config file**

Create `packages/daemon/task-enrichment/config/builtin.yaml`:

```yaml
rules:
  cleanup:
    executors:
      - executor: builtin
        executor_model: none
```

- [ ] **Step 4: Verify the config loads correctly with directory loading**

Add a test to verify directory loading picks up the new file. In `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`, inside the existing `describe('fromDirectory', ...)` block:

```typescript
it('loads cleanup rule from builtin.yaml alongside other rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enrichment-'));
  writeFileSync(join(dir, 'enrichment.yaml'), 'rules:\n  generic:\n    executors:\n      - executor: claude_code\n        executor_model: sonnet\n');
  writeFileSync(join(dir, 'builtin.yaml'), 'rules:\n  cleanup:\n    executors:\n      - executor: builtin\n        executor_model: none\n');

  const service = EnrichmentService.fromDirectory(dir);
  const types = service.getValidTaskTypes();

  expect(types).toEqual(new Set(['generic', 'cleanup']));
});
```

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts -t "loads cleanup rule"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/config/builtin.yaml packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "feat(enrichment): add builtin.yaml config with cleanup rule"
```

---

### Task 3: Detect `/end` command in lark-listener

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts:49-53,69-90`
- Test: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`

- [ ] **Step 1: Write failing tests for `/end` command detection**

Add a new describe block to `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`:

```typescript
describe('/end command parsing', () => {
  it('submits /end as task_type cleanup with empty payload', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/end' }),
    }));

    expect(submitter.submit).toHaveBeenCalledWith(
      'cleanup',
      '',
      { source: 'lark', message_id: 'om_msg1' },
    );
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
  });

  it('replies with usage hint for /end with arguments', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/end some reason' }),
    }));

    expect(submitter.submit).not.toHaveBeenCalled();
    expect(replier.reply).toHaveBeenCalledWith(
      'om_msg1',
      expect.stringContaining('/end'),
    );
  });

  it('does not treat /ending as /end command', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/ending today' }),
    }));

    expect(submitter.submit).toHaveBeenCalledWith(
      'generic',
      '/ending today',
      { source: 'lark', message_id: 'om_msg1' },
    );
    expect(replier.reply).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts -t "/end command"
```

Expected: FAIL — `/end` is currently treated as a plain message (`task_type: 'generic'`).

- [ ] **Step 3: Implement `/end` detection in `parseCommand()`**

In `packages/daemon/lark-listener/src/message-handler.ts`, modify `parseCommand()` to add `/end` detection **before** the existing `/task` detection (line 69):

```typescript
private parseCommand(payload: string): { taskType: string | null; taskPayload: string; isCommand: boolean } {
  // Detect /end command — must be exactly "/end" (no arguments)
  if (payload === '/end') {
    return { taskType: 'cleanup', taskPayload: '', isCommand: true };
  }

  // Reject /end with arguments
  if (payload.startsWith('/end ') || payload.startsWith('/end\n')) {
    return { taskType: null, taskPayload: '', isCommand: true };
  }

  // Existing /task logic (unchanged)...
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

- [ ] **Step 4: Update usage hint in `handle()` to cover both commands**

In `packages/daemon/lark-listener/src/message-handler.ts`, change the usage hint (line 53):

```typescript
if (isCommand && taskType === null) {
  await this.replier.reply(message_id, 'Usage: /task <type> <payload> or /end (in a thread)');
  return;
}
```

- [ ] **Step 5: Update the existing usage hint test**

In the existing test `'replies with usage hint for bare /task and does not submit'`, update the expected message:

```typescript
expect(replier.reply).toHaveBeenCalledWith(
  'om_msg1',
  'Usage: /task <type> <payload> or /end (in a thread)',
);
```

Do the same for the test `'replies with usage hint for /task with only whitespace after'`.

- [ ] **Step 6: Run all message-handler tests to verify they pass**

```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts
```

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts
git commit -m "feat(lark-listener): detect /end command and map to cleanup task type"
```

---

### Task 4: Enrichment poller — bypass mismatch, skip context, reject missing session

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts:36-71`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing tests for cleanup-specific enrichment behavior**

Add to the `'EnrichmentPoller with ThreadContextFetcher'` describe block in `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`:

```typescript
it('rejects cleanup task when no inherited session_id (no session to clean)', async () => {
  const task = createTask({
    task_type: 'cleanup',
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: '',
  });
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: hello\nassistant: Job abc — success',
    inheritedTaskType: 'generic',
    inheritedSessionId: null,
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockEnrich).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: 'task-123',
      task_id: 'task-123',
      task_type: 'cleanup',
      status: 'failure',
      exit_code: null,
      stdout: 'No session found in this thread. Nothing to clean up.',
      stderr: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    }),
  });
});

it('skips thread context prepending for cleanup tasks', async () => {
  const task = createTask({
    task_type: 'cleanup',
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: '',
  });
  const jobSubmission = createJobSubmission({ task_type: 'cleanup', payload: '', session_id: 'inherited-session-id' });
  mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: hello\nassistant: Job abc — success',
    inheritedTaskType: 'generic',
    inheritedSessionId: 'inherited-session-id',
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  // Payload should NOT have thread context prepended
  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({ payload: '' }),
    'inherited-session-id',
  );
});

it('bypasses task type mismatch check for cleanup tasks', async () => {
  const task = createTask({
    task_type: 'cleanup',
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: '',
  });
  const jobSubmission = createJobSubmission({ task_type: 'cleanup', payload: '', session_id: 'inherited-session-id' });
  mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: hello',
    inheritedTaskType: 'code_review',
    inheritedSessionId: 'inherited-session-id',
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  // Should NOT be rejected despite task_type mismatch (cleanup vs code_review)
  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({ task_type: 'cleanup' }),
    'inherited-session-id',
  );
});

it('rejects cleanup task when thread fetch returns null (no thread context at all)', async () => {
  const task = createTask({
    task_type: 'cleanup',
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: '',
  });
  mockThreadFetcher.fetchThreadContext.mockResolvedValue(null);

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockEnrich).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: 'task-123',
      task_id: 'task-123',
      task_type: 'cleanup',
      status: 'failure',
      exit_code: null,
      stdout: 'No session found in this thread. Nothing to clean up.',
      stderr: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    }),
  });
});

it('rejects cleanup task without lark source (standalone message)', async () => {
  const task = createTask({
    task_type: 'cleanup',
    payload: '',
    // no task_source
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ result_id: 'res-1' }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockEnrich).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: 'task-123',
      task_id: 'task-123',
      task_type: 'cleanup',
      status: 'failure',
      exit_code: null,
      stdout: 'No session found in this thread. Nothing to clean up.',
      stderr: '',
    }),
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts -t "cleanup"
```

Expected: FAIL — cleanup tasks are currently processed like normal tasks (context prepended, mismatch rejected, no session_id check).

- [ ] **Step 3: Implement cleanup-aware logic in `pollOnce()`**

Modify `packages/daemon/task-enrichment/src/enrichment-poller.ts`. Replace the thread context handling block (lines 36–64) and add the session_id rejection check (after line 71). The full `pollOnce()` method becomes:

```typescript
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

    let threadResult: ThreadContextResult | null | undefined;

    if (this.threadContextFetcher && task.task_source?.source === 'lark') {
      const validTaskTypes = this.enrichmentService.getValidTaskTypes();
      threadResult = await this.threadContextFetcher.fetchThreadContext(task.task_source.message_id, validTaskTypes);
      if (threadResult) {
        if (task.task_type === 'cleanup') {
          // Cleanup bypasses task type inheritance — it's always valid in any thread.
          // We only need the session_id from threadResult.
        } else if (threadResult.inheritedTaskType) {
          if (task.task_type === 'generic' || task.task_type === threadResult.inheritedTaskType) {
            task.task_type = threadResult.inheritedTaskType;
            logger.info({ task_id: task.task_id, inherited_task_type: threadResult.inheritedTaskType }, 'Inherited task_type from thread root');
          } else {
            const rejectionReason = `Cannot change task type in a thread. This thread uses task_type '${threadResult.inheritedTaskType}'. Remove the /task prefix or start a new conversation.`;
            logger.warn(
              {
                task_id: task.task_id,
                task_type: task.task_type,
                inherited_task_type: threadResult.inheritedTaskType,
              },
              'Rejected task with mismatched thread task_type',
            );
            await this.publishRejection(task, rejectionReason);
            await this.ackTask(task.task_id);
            return;
          }
        }
        if (task.task_type !== 'cleanup' && threadResult.threadContext) {
          task.payload = `--- Thread Context ---\n${threadResult.threadContext}\n--- Current Message ---\n${task.payload}`;
          logger.info({ task_id: task.task_id }, 'Prepended thread context to payload');
        }
      }
    }

    const sessionId = threadResult?.inheritedSessionId ?? generateSessionId();
    if (threadResult?.inheritedSessionId) {
      logger.info({ task_id: task.task_id, inherited_session_id: sessionId }, 'Inherited session_id from thread root');
    } else {
      logger.info({ task_id: task.task_id, new_session_id: sessionId }, 'Generated new session_id for enrichment');
    }

    // For cleanup tasks: reject if no inherited session_id
    if (task.task_type === 'cleanup' && !threadResult?.inheritedSessionId) {
      const reason = 'No session found in this thread. Nothing to clean up.';
      logger.warn({ task_id: task.task_id }, reason);
      await this.publishRejection(task, reason);
      await this.ackTask(task.task_id);
      return;
    }

    const enrichmentResult = this.enrichmentService.enrich(task, sessionId);

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
    } catch (jobErr) {
      logger.error({ task_id: task.task_id, err: jobErr }, 'POST /jobs request failed — not acking task');
      return;
    }

    await this.ackTask(task.task_id);
  } catch (err) {
    logger.error({ err }, 'Enrichment poll error');
  }
}
```

- [ ] **Step 4: Run all enrichment-poller tests**

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts
```

Expected: All tests PASS (both new cleanup tests and existing tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): handle cleanup tasks — bypass mismatch, skip context, require session_id"
```

---

### Task 5: Create `CleanupExecutor`

**Files:**
- Create: `packages/daemon/task/src/adapters/cleanup-executor.ts`
- Test: `packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts`

- [ ] **Step 1: Write tests for `CleanupExecutor`**

Create `packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { JobAttempt } from '@local-agent/shared';
import { CleanupExecutor } from '../cleanup-executor';
import { ExecutionEnvironment } from '../../services/job-environment';

function createAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-456',
    task_id: 'task-123',
    task_type: 'cleanup',
    payload: '',
    executor: 'builtin',
    executor_model: 'none',
    submitted_at: '2026-04-01T00:00:00.000Z',
    enriched_at: '2026-04-01T00:00:01.000Z',
    session_id: 'test-session-id',
    ...overrides,
  };
}

const dummyEnv: ExecutionEnvironment = { workDir: '', pluginDirs: [] };

describe('CleanupExecutor', () => {
  let executor: CleanupExecutor;
  let testBaseDir: string;

  beforeEach(() => {
    testBaseDir = mkdtempSync(join(tmpdir(), 'cleanup-test-'));
    executor = new CleanupExecutor(testBaseDir);
  });

  afterEach(() => {
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
  });

  it('removes existing session directory and returns success', async () => {
    const sessionDir = join(testBaseDir, 'test-session-id');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'file.txt'), 'data');

    const result = await executor.execute(createAttempt(), dummyEnv);

    expect(result.status).toBe('success');
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('Session cleaned up.');
    expect(result.stdout).toContain(sessionDir);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it('returns success with not-found note when directory does not exist', async () => {
    const result = await executor.execute(createAttempt(), dummyEnv);

    expect(result.status).toBe('success');
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('Session directory not found');
    expect(result.stdout).toContain('already cleaned or never created');
  });

  it('returns correct task metadata in result', async () => {
    const result = await executor.execute(createAttempt(), dummyEnv);

    expect(result.job_id).toBe('job-456');
    expect(result.task_id).toBe('task-123');
    expect(result.task_type).toBe('cleanup');
    expect(result.session_id).toBe('test-session-id');
  });

  it('removes nested directory structure', async () => {
    const sessionDir = join(testBaseDir, 'test-session-id');
    const nestedDir = join(sessionDir, 'marketplaces', 'repo', 'plugin');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, 'deep-file.txt'), 'nested data');

    const result = await executor.execute(createAttempt(), dummyEnv);

    expect(result.status).toBe('success');
    expect(existsSync(sessionDir)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/daemon/task && npx vitest run src/adapters/__tests__/cleanup-executor.test.ts
```

Expected: FAIL — `cleanup-executor.ts` does not exist yet.

- [ ] **Step 3: Implement `CleanupExecutor`**

Create `packages/daemon/task/src/adapters/cleanup-executor.ts`:

```typescript
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TaskResultSubmission, JobAttempt, createLogger } from '@local-agent/shared';
import type { TaskExecutor } from '../ports/task-executor';
import type { ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:cleanup-executor');

const DEFAULT_SESSION_BASE_DIR = '/var/tmp/local-agent/session';

export class CleanupExecutor implements TaskExecutor {
  constructor(private readonly sessionBaseDir: string = DEFAULT_SESSION_BASE_DIR) {}

  async execute(attempt: JobAttempt, _env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    const sessionDir = join(this.sessionBaseDir, attempt.session_id);

    if (!existsSync(sessionDir)) {
      logger.info({ session_id: attempt.session_id, sessionDir }, 'Session directory not found');
      return {
        job_id: attempt.job_id,
        task_id: attempt.task_id,
        task_type: attempt.task_type,
        session_id: attempt.session_id,
        status: 'success',
        exit_code: 0,
        stdout: `Session directory not found (already cleaned or never created).\nPath: ${sessionDir}`,
        stderr: '',
      };
    }

    try {
      rmSync(sessionDir, { recursive: true, force: true });
      logger.info({ session_id: attempt.session_id, sessionDir }, 'Session directory removed');
      return {
        job_id: attempt.job_id,
        task_id: attempt.task_id,
        task_type: attempt.task_type,
        session_id: attempt.session_id,
        status: 'success',
        exit_code: 0,
        stdout: `Session cleaned up.\nRemoved: ${sessionDir}`,
        stderr: '',
      };
    } catch (error) {
      logger.error({ session_id: attempt.session_id, sessionDir, err: error }, 'Failed to remove session directory');
      return {
        job_id: attempt.job_id,
        task_id: attempt.task_id,
        task_type: attempt.task_type,
        session_id: attempt.session_id,
        status: 'failure',
        exit_code: 1,
        stdout: '',
        stderr: `Failed to remove session directory: ${error instanceof Error ? error.message : String(error)}\nPath: ${sessionDir}`,
      };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/daemon/task && npx vitest run src/adapters/__tests__/cleanup-executor.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/adapters/cleanup-executor.ts packages/daemon/task/src/adapters/__tests__/cleanup-executor.test.ts
git commit -m "feat(task-daemon): add CleanupExecutor for session directory removal"
```

---

### Task 6: Register `CleanupExecutor` in orchestrator and skip env setup

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts:31-45,106-110`
- Test: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Write failing tests for cleanup orchestration**

Add to `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`. First, add a mock for the CleanupExecutor at the top with the other mocks:

```typescript
const mockCleanupExecute = vi.fn().mockResolvedValue({
  job_id: 'job-456',
  task_id: 'test-123',
  task_type: 'cleanup',
  session_id: 'session-789',
  status: 'success',
  exit_code: 0,
  stdout: 'Session cleaned up.',
  stderr: '',
});

vi.mock('../../adapters/cleanup-executor', () => ({
  CleanupExecutor: vi.fn(function (this: { execute: typeof mockCleanupExecute }) {
    this.execute = mockCleanupExecute;
  }),
}));
```

Add the import:

```typescript
import { CleanupExecutor } from '../../adapters/cleanup-executor';
```

Add `mockCleanupExecute` to the `beforeEach` clear block:

```typescript
mockCleanupExecute.mockClear().mockResolvedValue({
  job_id: 'job-456',
  task_id: 'test-123',
  task_type: 'cleanup',
  session_id: 'session-789',
  status: 'success',
  exit_code: 0,
  stdout: 'Session cleaned up.',
  stderr: '',
});
vi.mocked(CleanupExecutor).mockClear();
```

Then add the test cases:

```typescript
it('skips env setup and uses CleanupExecutor for cleanup tasks', async () => {
  const job = createJob({
    task_type: 'cleanup',
    executors: [{ executor: 'builtin', executor_model: 'none' }],
  });
  const result = await orchestrator.handle(job);

  expect(mockSetup).not.toHaveBeenCalled();
  expect(CleanupExecutor).toHaveBeenCalledTimes(1);
  expect(mockCleanupExecute).toHaveBeenCalledWith(
    expect.objectContaining({
      task_type: 'cleanup',
      executor: 'builtin',
      executor_model: 'none',
    }),
    { workDir: '', pluginDirs: [] },
  );
  expect(result.status).toBe('success');
  expect(mockTeardown).not.toHaveBeenCalled();
});

it('resolves builtin executor to CleanupExecutor', async () => {
  const job = createJob({
    task_type: 'cleanup',
    executors: [{ executor: 'builtin', executor_model: 'none' }],
  });
  await orchestrator.handle(job);

  expect(CleanupExecutor).toHaveBeenCalledTimes(1);
  expect(ClaudeCliExecutor).not.toHaveBeenCalled();
  expect(TTADKExecutor).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts -t "cleanup"
```

Expected: FAIL — `CleanupExecutor` not imported, `'builtin'` executor throws `Unknown executor`, env setup is called for all tasks.

- [ ] **Step 3: Implement cleanup handling in `TaskOrchestrator`**

In `packages/daemon/task/src/core/task-orchestrator.ts`:

Add import at the top:

```typescript
import { CleanupExecutor } from '../adapters/cleanup-executor';
```

Modify `handle()` to skip env setup for cleanup tasks. Replace the env setup block (lines 31-45):

```typescript
let env: ExecutionEnvironment;

if (job.task_type === 'cleanup') {
  // Cleanup doesn't need environment setup — it removes the session directory
  env = { workDir: '', pluginDirs: [] };
} else {
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
}
```

Add `'builtin'` to `resolveExecutor()`:

```typescript
private resolveExecutor(executor: TaskExecutorType): TaskExecutor {
  if (executor === 'claude_code') return new ClaudeCliExecutor();
  if (executor === 'ttadk') return new TTADKExecutor();
  if (executor === 'builtin') return new CleanupExecutor();
  throw new Error(`Unknown executor: ${executor}`);
}
```

- [ ] **Step 4: Run all orchestrator tests**

```bash
cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Run all tests across all affected packages**

```bash
cd packages/shared && npx vitest run && cd ../daemon/task-enrichment && npx vitest run && cd ../lark-listener && npx vitest run && cd ../task && npx vitest run
```

Expected: All tests PASS across all packages.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts
git commit -m "feat(task-daemon): skip env setup for cleanup, register CleanupExecutor for builtin executor"
```
