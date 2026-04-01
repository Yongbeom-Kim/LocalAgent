# `/new` Command Implementation Plan

**Goal:** Add a `/new` command that creates a fresh Claude Code instance within the same Lark thread and session, clearing conversational context while preserving the workspace.

**Architecture:** `/new` is parsed as a reserved command in lark-listener, submitted as `task_type: 'new_instance'`, enriched with inherited session/executor from the thread, executed without `--continue` (rotating the Claude Code session), and produces a bot reply with standard markers. Thread context is truncated at the last `/new` bot-reply boundary (context fence).

**Tech Stack:** TypeScript, Vitest, Rush monorepo, RabbitMQ, Lark API

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/shared/src/types.ts` | Add `skipContinue?: boolean` to `JobSubmission`, `Job`, `JobAttempt` |
| Modify | `packages/shared/src/__tests__/types.test.ts` | Tests for `skipContinue` field presence |
| Modify | `packages/daemon/lark-listener/src/message-handler.ts` | Parse `/new` command |
| Modify | `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Tests for `/new` parsing |
| Modify | `packages/daemon/task-enrichment/config/builtin.yaml` | Add `new_instance` rule |
| Modify | `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Test `new_instance` YAML rule |
| Modify | `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Handle `new_instance` validation and enrichment |
| Modify | `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Tests for `new_instance` enrichment |
| Modify | `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Add context fence logic |
| Modify | `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts` | Tests for fence detection |
| Modify | `packages/daemon/task/src/adapters/claude-cli-executor.ts` | Skip `--continue` when `skipContinue` |
| Modify | `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts` | Tests for `skipContinue` behavior |
| Modify | `packages/daemon/task/src/adapters/ttadk-executor.ts` | Skip `--continue` when `skipContinue` |
| Modify | `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts` | Tests for `skipContinue` behavior |
| Modify | `packages/daemon/task/src/core/task-orchestrator.ts` | Propagate `skipContinue` to `JobAttempt` |
| Modify | `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Test `skipContinue` propagation |
| Modify | `packages/api/src/routes/jobs.ts` | Pass through `skipContinue` field |
| Modify | `packages/api/src/__tests__/routes/jobs.test.ts` | Test `skipContinue` passthrough |

---

### Task 1: Add `skipContinue` to shared types

**Files:**
- Modify: `packages/shared/src/types.ts:75-102`
- Test: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that verifies `skipContinue` is an accepted field on `JobSubmission`, `Job`, and `JobAttempt`. In `packages/shared/src/__tests__/types.test.ts`:

```typescript
it('accepts skipContinue field on JobSubmission', () => {
  const submission: JobSubmission = {
    task_id: 'task-1',
    task_type: 'new_instance',
    payload: '',
    executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
    submitted_at: '2026-04-01T00:00:00.000Z',
    session_id: 'session-1',
    skipContinue: true,
  };
  expect(submission.skipContinue).toBe(true);
});

it('accepts skipContinue field on Job', () => {
  const job: Job = {
    job_id: 'job-1',
    task_id: 'task-1',
    task_type: 'new_instance',
    payload: '',
    executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
    submitted_at: '2026-04-01T00:00:00.000Z',
    enriched_at: '2026-04-01T00:00:01.000Z',
    session_id: 'session-1',
    skipContinue: true,
  };
  expect(job.skipContinue).toBe(true);
});

it('accepts skipContinue field on JobAttempt', () => {
  const attempt: JobAttempt = {
    job_id: 'job-1',
    task_id: 'task-1',
    task_type: 'new_instance',
    payload: '',
    executor: 'claude_code',
    executor_model: 'sonnet',
    submitted_at: '2026-04-01T00:00:00.000Z',
    enriched_at: '2026-04-01T00:00:01.000Z',
    session_id: 'session-1',
    skipContinue: true,
  };
  expect(attempt.skipContinue).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`
Expected: FAIL — `skipContinue` does not exist on type `JobSubmission` / `Job` / `JobAttempt`

- [ ] **Step 3: Add `skipContinue` to the types**

In `packages/shared/src/types.ts`, add `skipContinue?: boolean;` to:
- `JobSubmission` interface (after `setup_hook_timeout_ms`)
- `Job` interface (after `setup_hook_timeout_ms`)
- `JobAttempt` interface (after `marketplaces`)

```typescript
// In JobSubmission (line ~85):
  setup_hook_timeout_ms?: number;
  skipContinue?: boolean;
}

// In Job (line ~102):
  setup_hook_timeout_ms?: number;
  skipContinue?: boolean;
}

// In JobAttempt (line ~117):
  marketplaces?: MarketplaceConfig[];
  skipContinue?: boolean;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat: add skipContinue field to Job pipeline types"
```

---

### Task 2: Parse `/new` command in MessageHandler

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts:69-101`
- Test: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests to the `/task command parsing` describe block in `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`:

```typescript
it('submits bare /new as new_instance with empty payload', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: '/new' }),
  }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'new_instance',
    '',
    { source: 'lark', message_id: 'om_msg1' },
  );
  expect(replier.reply).not.toHaveBeenCalled();
  expect(reactor.react).toHaveBeenCalledWith('om_msg1');
});

it('replies with usage hint for /new with args and does not submit', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: '/new something' }),
  }));

  expect(submitter.submit).not.toHaveBeenCalled();
  expect(reactor.react).not.toHaveBeenCalled();
  expect(replier.reply).toHaveBeenCalledWith(
    'om_msg1',
    'Usage: /task <type> <payload> or /end (in a thread)',
  );
});

it('does not treat /newline as a /new command', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: '/newline break here' }),
  }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'generic',
    '/newline break here',
    { source: 'lark', message_id: 'om_msg1' },
  );
  expect(replier.reply).not.toHaveBeenCalled();
});

it('replies with usage hint for /new with newline content', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: '/new\nsome content' }),
  }));

  expect(submitter.submit).not.toHaveBeenCalled();
  expect(reactor.react).not.toHaveBeenCalled();
  expect(replier.reply).toHaveBeenCalledWith(
    'om_msg1',
    'Usage: /task <type> <payload> or /end (in a thread)',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: FAIL — `/new` is submitted as `generic` type, not `new_instance`

- [ ] **Step 3: Add `/new` parsing to `parseCommand()`**

In `packages/daemon/lark-listener/src/message-handler.ts`, add after the `/end` block (after line 79, before the `/task` check):

```typescript
if (payload === '/new') {
  return { taskType: 'new_instance', taskPayload: '', isCommand: true };
}

if (payload.startsWith('/new ') || payload.startsWith('/new\n')) {
  return { taskType: null, taskPayload: '', isCommand: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts
git commit -m "feat: parse /new as new_instance command in lark-listener"
```

---

### Task 3: Add `new_instance` YAML enrichment rule

**Files:**
- Modify: `packages/daemon/task-enrichment/config/builtin.yaml`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test in `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` (check existing test patterns first by reading the file):

```typescript
it('enriches new_instance task with claude_code executor', () => {
  const service = EnrichmentService.fromDirectory(CONFIG_DIR);
  const task: Task = {
    task_id: 'task-new',
    task_type: 'new_instance',
    payload: 'Respond with: New session instance started.',
    submitted_at: '2026-04-01T00:00:00.000Z',
  };

  const result = service.enrich(task, 'session-1');
  expect(result.type).toBe('enriched');
  if (result.type === 'enriched') {
    expect(result.job.executors).toEqual([
      { executor: 'claude_code', executor_model: 'sonnet' },
    ]);
    expect(result.job.task_type).toBe('new_instance');
  }
});
```

Note: Check what `CONFIG_DIR` or equivalent variable the existing tests use, and adapt accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: FAIL — `Unknown task type "new_instance"`

- [ ] **Step 3: Add `new_instance` rule to builtin.yaml**

Modify `packages/daemon/task-enrichment/config/builtin.yaml`:

```yaml
rules:
  cleanup:
    executors:
      - executor: builtin
        executor_model: none
  new_instance:
    executors:
      - executor: claude_code
        executor_model: sonnet
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/config/builtin.yaml packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "feat: add new_instance enrichment rule to builtin.yaml"
```

---

### Task 4: Handle `new_instance` in EnrichmentPoller

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts:1-12,40-99,120-142`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing tests**

Add to the `EnrichmentPoller with ThreadContextFetcher` describe block in `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`:

```typescript
it('enriches new_instance task with inherited session, skipContinue, overridden payload, and no history', async () => {
  const task = createTask({
    task_type: 'new_instance',
    payload: '',
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });
  const jobSubmission = createJobSubmission({
    task_type: 'new_instance',
    payload: 'Respond with: New session instance started.',
    session_id: 'inherited-session-id',
  });
  mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: fix CI\nassistant: done',
    inheritedTaskType: 'deploy',
    inheritedSessionId: 'inherited-session-id',
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  // Verify payload was overridden before enrichment
  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({
      task_type: 'new_instance',
      payload: 'Respond with: New session instance started.',
    }),
    'inherited-session-id',
    undefined, // no history
  );

  // Verify skipContinue was set on the submitted job
  const postedJobBody = JSON.parse(mockFetch.mock.calls[1][1].body);
  expect(postedJobBody.skipContinue).toBe(true);
});

it('rejects new_instance task without lark source', async () => {
  const task = createTask({
    task_type: 'new_instance',
    payload: '',
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
      task_type: 'new_instance',
      status: 'failure',
      exit_code: null,
      stdout: 'The /new command requires a Lark task source.',
      stderr: '',
    }),
  });
});

it('rejects new_instance task when not in a thread', async () => {
  const task = createTask({
    task_type: 'new_instance',
    payload: '',
    task_source: { source: 'lark', message_id: 'om_msg1' },
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
      task_type: 'new_instance',
      status: 'failure',
      exit_code: null,
      stdout: 'The /new command can only be used inside a thread.',
      stderr: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    }),
  });
});

it('rejects new_instance task without inherited session_id', async () => {
  const task = createTask({
    task_type: 'new_instance',
    payload: '',
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: hello',
    inheritedTaskType: null,
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
      task_type: 'new_instance',
      status: 'failure',
      exit_code: null,
      stdout: 'No active session in this thread to reset.',
      stderr: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    }),
  });
});

it('excludes new_instance from task_type mismatch check', async () => {
  const task = createTask({
    task_type: 'new_instance',
    payload: '',
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });
  const jobSubmission = createJobSubmission({
    task_type: 'new_instance',
    payload: 'Respond with: New session instance started.',
    session_id: 'inherited-session-id',
  });
  mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: deploy',
    inheritedTaskType: 'deploy',
    inheritedSessionId: 'inherited-session-id',
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  // Should NOT be rejected for task_type mismatch (new_instance != deploy)
  expect(mockEnrich).toHaveBeenCalled();
  expect(task.task_type).toBe('new_instance'); // NOT changed to 'deploy'
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: FAIL — `new_instance` is not handled specially

- [ ] **Step 3: Implement `new_instance` handling in EnrichmentPoller**

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`:

Add constants at the top (after existing constants, ~line 11):

```typescript
const NEW_INSTANCE_TASK_TYPE = 'new_instance';
const NEW_INSTANCE_PROMPT = 'Respond with: New session instance started.';
const NEW_INSTANCE_MISSING_SOURCE_REASON = 'The /new command requires a Lark task source.';
const NEW_INSTANCE_MISSING_THREAD_REASON = 'The /new command can only be used inside a thread.';
const NEW_INSTANCE_MISSING_SESSION_REASON = 'No active session in this thread to reset.';
```

Add `new_instance` handling in `pollOnce()`. Insert AFTER the `isCleanupTask` source check (line 49) and BEFORE the thread context fetch (line 51):

```typescript
const isNewInstanceTask = task.task_type === NEW_INSTANCE_TASK_TYPE;

if (isNewInstanceTask && task.task_source?.source !== 'lark') {
  logger.warn({ task_id: task.task_id, task_source: task.task_source }, 'Rejected new_instance task without lark task_source');
  await this.publishRejection(task, NEW_INSTANCE_MISSING_SOURCE_REASON);
  await this.ackTask(task.task_id);
  return;
}
```

After thread context fetch (after line 53), add:

```typescript
if (isNewInstanceTask && !threadResult) {
  logger.warn({ task_id: task.task_id }, 'Rejected new_instance task without thread context');
  await this.publishRejection(task, NEW_INSTANCE_MISSING_THREAD_REASON);
  await this.ackTask(task.task_id);
  return;
}

if (isNewInstanceTask && !threadResult?.inheritedSessionId) {
  logger.warn({ task_id: task.task_id }, 'Rejected new_instance task without inherited session_id');
  await this.publishRejection(task, NEW_INSTANCE_MISSING_SESSION_REASON);
  await this.ackTask(task.task_id);
  return;
}
```

Modify the task_type mismatch check (line 62) to also exclude `new_instance`:

```typescript
if (threadResult?.inheritedTaskType && !isCleanupTask && !isGcTask && !isNewInstanceTask) {
```

Before the enrichment call (~line 134-135), add the payload override for `new_instance`:

```typescript
if (isNewInstanceTask) {
  task.payload = NEW_INSTANCE_PROMPT;
}

const threadHistory = isCleanupTask || isNewInstanceTask ? undefined : (threadResult?.threadContext ?? undefined);
```

After the enrichment result check, set `skipContinue`:

```typescript
if (isNewInstanceTask && enrichmentResult.type === 'enriched') {
  enrichmentResult.job.skipContinue = true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: PASS

- [ ] **Step 5: Run all enrichment tests to check for regressions**

Run: `cd packages/daemon/task-enrichment && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat: handle new_instance validation and enrichment in poller"
```

---

### Task 5: Add context fence logic to ThreadContextFetcher

**Files:**
- Modify: `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts:91-108`
- Test: `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`

- [ ] **Step 1: Write failing tests**

Add a new `describe('context fence for /new command')` block in `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`:

```typescript
describe('context fence for /new command', () => {
  let fetcher: ThreadContextFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new ThreadContextFetcher(APP_ID, APP_SECRET);
  });

  it('truncates thread context at last /new bot-reply (fence point)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockMessageResponse())
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(
        mockThreadMessagesResponse([
          {
            message_id: 'om_root_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'fix the CI pipeline' }) },
          },
          {
            message_id: 'om_bot_reply1',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'session_id: 018f6b7e-1234-7abc-8def-1234567890ab\nDone!' }) },
          },
          {
            message_id: 'om_new_cmd',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '/new' }) },
          },
          {
            message_id: 'om_new_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'session_id: 018f6b7e-1234-7abc-8def-1234567890ab\nNew session instance started.' }) },
          },
          {
            message_id: 'om_post_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'now do something else' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');

    expect(result).not.toBeNull();
    // Should only include messages from the /new bot-reply onwards (excluding current message)
    expect(result!.threadContext).toContain('New session instance started.');
    expect(result!.threadContext).toContain('now do something else');
    expect(result!.threadContext).not.toContain('fix the CI pipeline');
    expect(result!.threadContext).not.toContain('/new');
  });

  it('uses last /new fence when multiple /new commands exist', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockMessageResponse())
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(
        mockThreadMessagesResponse([
          {
            message_id: 'om_root_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'first task' }) },
          },
          {
            message_id: 'om_bot1',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'done first' }) },
          },
          {
            message_id: 'om_new1',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '/new' }) },
          },
          {
            message_id: 'om_new1_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'New session instance started.' }) },
          },
          {
            message_id: 'om_mid_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'middle task' }) },
          },
          {
            message_id: 'om_new2',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '/new' }) },
          },
          {
            message_id: 'om_new2_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'New session instance started.' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'final task' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');

    expect(result).not.toBeNull();
    // Only includes messages from the SECOND /new bot-reply onwards
    expect(result!.threadContext).toContain('New session instance started.');
    expect(result!.threadContext).not.toContain('first task');
    expect(result!.threadContext).not.toContain('middle task');
    expect(result!.threadContext).not.toContain('done first');
  });

  it('does not truncate when no /new command exists in thread', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockMessageResponse())
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(
        mockThreadMessagesResponse([
          {
            message_id: 'om_root_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'fix CI' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'Done' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');

    expect(result).not.toBeNull();
    expect(result!.threadContext).toBe('user: fix CI\nassistant: Done');
  });

  it('includes /new bot-reply in context (fence point is included)', async () => {
    mockFetch
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(mockMessageResponse())
      .mockResolvedValueOnce(mockTokenResponse())
      .mockResolvedValueOnce(
        mockThreadMessagesResponse([
          {
            message_id: 'om_root_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'old context' }) },
          },
          {
            message_id: 'om_new_cmd',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '/new' }) },
          },
          {
            message_id: 'om_new_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'New session instance started.' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'current message' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');

    expect(result).not.toBeNull();
    expect(result!.threadContext).toBe('assistant: New session instance started.');
    expect(result!.threadContext).not.toContain('old context');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts`
Expected: FAIL — thread context includes all messages (no fence logic)

- [ ] **Step 3: Implement fence logic in `doFetch()`**

In `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`, add the fence detection after the `inheritedSessionId` extraction loop and before the filtering step (between current lines 89 and 91):

```typescript
// Step 3b: Detect /new fence boundary
let fenceIndex = -1;
for (let i = messages.length - 1; i >= 0; i--) {
  const m = messages[i];
  if (m.sender.sender_type === 'user') {
    const content = extractLarkMessageContent(m.msg_type, m.body.content);
    if (content === '/new') {
      // Find the bot reply immediately after this /new command
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].sender.sender_type !== 'user') {
          fenceIndex = j;
          break;
        }
      }
      break;
    }
  }
}

// Step 4: Format, excluding the current message, stripping task_type and session_id lines
// If a fence exists, only include messages at/after the fence point
const startMessages = fenceIndex >= 0 ? messages.slice(fenceIndex) : messages;
const filtered = startMessages.filter((m) => m.message_id !== messageId);
```

Replace the existing lines 92-93:
```typescript
// OLD:
const filtered = messages.filter((m) => m.message_id !== messageId);
```

With:
```typescript
// NEW:
const startMessages = fenceIndex >= 0 ? messages.slice(fenceIndex) : messages;
const filtered = startMessages.filter((m) => m.message_id !== messageId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts`
Expected: PASS

- [ ] **Step 5: Run all enrichment tests for regressions**

Run: `cd packages/daemon/task-enrichment && npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts
git commit -m "feat: add context fence logic for /new command in thread context fetcher"
```

---

### Task 6: Skip `--continue` in executors when `skipContinue` is set

**Files:**
- Modify: `packages/daemon/task/src/adapters/claude-cli-executor.ts:25`
- Modify: `packages/daemon/task/src/adapters/ttadk-executor.ts:25`
- Test: `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts`
- Test: `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts`

- [ ] **Step 1: Write failing test for ClaudeCliExecutor**

Add to `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts`:

```typescript
it('skips --continue for existing workspace when skipContinue is true', async () => {
  const child = createMockChild();
  mockSpawn.mockReturnValue(child as any);

  const job = createJobAttempt({ skipContinue: true, payload: 'new instance prompt' });

  const resultPromise = executor.execute(job, createEnv({ isExistingWorkspace: true }));
  emitOutput(child, 'New session instance started.', '', 0);

  const result = await resultPromise;

  expect(result.status).toBe('success');
  expect(mockSpawn).toHaveBeenCalledTimes(1);
  // Should NOT include --continue flag
  const args = mockSpawn.mock.calls[0][1] as string[];
  expect(args).not.toContain('--continue');
  expect(child.stdinData).toBe('new instance prompt');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon/task && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: FAIL — `--continue` is still passed (two spawn calls due to fallback)

- [ ] **Step 3: Modify `ClaudeCliExecutor.execute()`**

In `packages/daemon/task/src/adapters/claude-cli-executor.ts` line 25, change:

```typescript
// OLD:
if (env.isExistingWorkspace) {
```

To:

```typescript
// NEW:
if (env.isExistingWorkspace && !job.skipContinue) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/daemon/task && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for TTADKExecutor**

Add the equivalent test to `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts` (adapt test helpers to match TTADK patterns — uses `execFile` instead of `spawn`):

```typescript
it('skips --continue for existing workspace when skipContinue is true', async () => {
  // Use existing TTADK test patterns with mockExecFile
  // Verify --continue is NOT in the args when skipContinue is true
  // and isExistingWorkspace is true
});
```

Note: Read the existing `ttadk-executor.test.ts` to adapt the test to its mock patterns (it uses `execFile` instead of `spawn`).

- [ ] **Step 6: Modify `TTADKExecutor.execute()`**

In `packages/daemon/task/src/adapters/ttadk-executor.ts` line 25, change:

```typescript
// OLD:
if (env.isExistingWorkspace) {
```

To:

```typescript
// NEW:
if (env.isExistingWorkspace && !job.skipContinue) {
```

- [ ] **Step 7: Run all executor tests**

Run: `cd packages/daemon/task && npx vitest run src/adapters/__tests__/`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add packages/daemon/task/src/adapters/claude-cli-executor.ts packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts packages/daemon/task/src/adapters/ttadk-executor.ts packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts
git commit -m "feat: skip --continue when skipContinue flag is set on job"
```

---

### Task 7: Propagate `skipContinue` in TaskOrchestrator and API

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts:74-87`
- Test: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`
- Modify: `packages/api/src/routes/jobs.ts:11,44-59`
- Test: `packages/api/src/__tests__/routes/jobs.test.ts`

- [ ] **Step 1: Write failing test for TaskOrchestrator `skipContinue` propagation**

Add to `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`:

```typescript
it('propagates skipContinue from job to executor attempt', async () => {
  // Create a job with skipContinue: true
  // Verify the executor receives a JobAttempt with skipContinue: true
  // Use the existing mock patterns in the test file
});
```

Note: Read the existing orchestrator test file fully to understand the mocking patterns, then write the test accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: FAIL — `skipContinue` not on `JobAttempt`

- [ ] **Step 3: Propagate `skipContinue` in TaskOrchestrator**

In `packages/daemon/task/src/core/task-orchestrator.ts`, add `skipContinue` to the `JobAttempt` construction (~line 87):

```typescript
const attempt: JobAttempt = {
  job_id: job.job_id,
  task_id: job.task_id,
  session_id: job.session_id,
  task_type: job.task_type,
  payload: job.payload,
  history: job.history,
  executor: pref.executor,
  executor_model: pref.executor_model,
  submitted_at: job.submitted_at,
  enriched_at: job.enriched_at,
  system_prompt: job.system_prompt,
  marketplaces: job.marketplaces,
  skipContinue: job.skipContinue,
};
```

- [ ] **Step 4: Pass `skipContinue` through in API jobs route**

In `packages/api/src/routes/jobs.ts`, add `skipContinue` to the destructured body (line 11):

```typescript
const { task_id, task_type, payload, history, executors, submitted_at, session_id, system_prompt, marketplaces, task_source, setup_hook, setup_hook_timeout_ms, skipContinue } = req.body;
```

And add it to the Job construction (~line 58):

```typescript
...(skipContinue !== undefined ? { skipContinue } : {}),
```

- [ ] **Step 5: Run all tests**

Run: `cd packages/daemon/task && npx vitest run` and `cd packages/api && npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts packages/api/src/routes/jobs.ts packages/api/src/__tests__/routes/jobs.test.ts
git commit -m "feat: propagate skipContinue through API and orchestrator"
```

---

### Task 8: Full integration verification

- [ ] **Step 1: Run all tests across the monorepo**

Run: `cd LocalAgent && npx rush test` (or equivalent monorepo-wide test command)
Expected: All tests PASS across all packages

- [ ] **Step 2: Verify TypeScript compiles cleanly**

Run: `cd LocalAgent && npx rush build` (or `npx tsc --noEmit` per package)
Expected: No type errors

- [ ] **Step 3: Final commit if any fixups were needed**

```bash
git add -A
git commit -m "chore: fix any remaining issues from integration verification"
```
