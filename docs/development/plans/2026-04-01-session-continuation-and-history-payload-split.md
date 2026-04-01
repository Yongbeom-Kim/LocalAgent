# Session Continuation & History/Payload Split — Implementation Plan

**Goal:** Split `JobSubmission.payload` into separate `history` and `payload` fields, and add `--continue` session resumption to both Claude Code and TTADK executors with automatic fallback to fresh sessions.

**Architecture:** The enrichment poller separates thread context into a `history` field instead of concatenating it into `payload`. This flows through the API → Job → JobAttempt unchanged. `JobEnvironment.setup()` sets an `isExistingWorkspace` flag on `ExecutionEnvironment`. Both executors try `--continue` when the workspace exists, piping only `payload`; on failure they fall back to a fresh session piping `history + payload` combined.

**Tech Stack:** TypeScript, Vitest, Node.js child_process (spawn/execFile)

---

### Task 1: Add `history` to shared types

**Files:**
- Modify: `packages/shared/src/types.ts:71-113`

- [ ] **Step 1: Add `history?: string` to `JobSubmission`**

In `packages/shared/src/types.ts`, add `history?: string` after the `payload` field on `JobSubmission`:

```typescript
export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  history?: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  session_id: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}
```

- [ ] **Step 2: Add `history?: string` to `Job`**

Same file, add `history?: string` after `payload` on the `Job` interface:

```typescript
export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  history?: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  enriched_at: string;
  session_id: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}
```

- [ ] **Step 3: Add `history?: string` to `JobAttempt`**

Same file, add `history?: string` after `payload` on the `JobAttempt` interface:

```typescript
export interface JobAttempt {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  history?: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
  enriched_at: string;
  session_id: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
}
```

- [ ] **Step 4: Verify types compile**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(types): add optional history field to JobSubmission, Job, and JobAttempt"
```

---

### Task 2: Add `isExistingWorkspace` to `ExecutionEnvironment` and `JobEnvironment.setup()`

**Files:**
- Modify: `packages/daemon/task/src/services/job-environment.ts:9-12,23-26,66-67`
- Test: `packages/daemon/task/src/services/__tests__/job-environment.test.ts`

- [ ] **Step 1: Write failing tests for `isExistingWorkspace`**

In `packages/daemon/task/src/services/__tests__/job-environment.test.ts`, add two tests inside the `describe('setup', ...)` block:

```typescript
it('returns isExistingWorkspace false for a new session', async () => {
  const env = await jobEnv.setup(createJob());
  createdDirs.push(env.workDir);

  expect(env.isExistingWorkspace).toBe(false);
});

it('returns isExistingWorkspace true when session workspace already exists', async () => {
  const job = createJob({
    marketplaces: [
      {
        url: 'https://github.com/anthropics/claude-plugins-official.git',
        plugins: ['superpowers'],
      },
    ],
  });
  const workDir = join(sessionRootDir, job.session_id);
  const pluginDir = join(workDir, 'marketplaces', 'claude-plugins-official', 'superpowers');
  mkdirSync(pluginDir, { recursive: true });
  createdDirs.push(workDir);

  const env = await jobEnv.setup(job);

  expect(env.isExistingWorkspace).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task && npx vitest run src/services/__tests__/job-environment.test.ts`
Expected: FAIL — `isExistingWorkspace` is `undefined`

- [ ] **Step 3: Add `isExistingWorkspace` to `ExecutionEnvironment` and set it in `setup()`**

In `packages/daemon/task/src/services/job-environment.ts`:

Update the interface:

```typescript
export interface ExecutionEnvironment {
  workDir: string;
  pluginDirs: string[];
  isExistingWorkspace: boolean;
}
```

Update the reuse path (line ~26) return:

```typescript
return { workDir, pluginDirs, isExistingWorkspace: true };
```

Update the fresh setup return (line ~67):

```typescript
return { workDir, pluginDirs, isExistingWorkspace: false };
```

- [ ] **Step 4: Fix the existing reuse test expectation**

The test `'reuses an existing session workspace and skips clone and hook execution'` currently asserts:

```typescript
expect(env).toEqual({
  workDir,
  pluginDirs: [pluginDir],
});
```

Update to:

```typescript
expect(env).toEqual({
  workDir,
  pluginDirs: [pluginDir],
  isExistingWorkspace: true,
});
```

- [ ] **Step 5: Fix `mockEnv` in orchestrator tests**

In `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`, update the `mockEnv` constant (line 5-8):

```typescript
const mockEnv: ExecutionEnvironment = {
  workDir: '/tmp/localagent-job-test',
  pluginDirs: [],
  isExistingWorkspace: false,
};
```

- [ ] **Step 6: Run all tests to verify they pass**

Run: `cd packages/daemon/task && npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/task/src/services/job-environment.ts packages/daemon/task/src/services/__tests__/job-environment.test.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts
git commit -m "feat(job-env): add isExistingWorkspace flag to ExecutionEnvironment"
```

---

### Task 3: Update `EnrichmentService.enrich()` to accept `history`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts:69-128`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Write failing tests**

In `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`, add a new `describe` block after the existing `setup_hook passthrough` block:

```typescript
describe('history passthrough', () => {
  let service: EnrichmentService;

  beforeEach(() => {
    service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
        },
      },
    });
  });

  it('includes history in enriched job when provided', () => {
    const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID, 'user: hello\nassistant: hi');

    expect(result.type).toBe('enriched');
    const enriched = result as { type: 'enriched'; job: JobSubmission };
    expect(enriched.job.history).toBe('user: hello\nassistant: hi');
    expect(enriched.job.payload).toBe('Review this code');
  });

  it('omits history from enriched job when not provided', () => {
    const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID);

    expect(result.type).toBe('enriched');
    const enriched = result as { type: 'enriched'; job: JobSubmission };
    expect(enriched.job.history).toBeUndefined();
  });

  it('omits history from enriched job when undefined is passed explicitly', () => {
    const result = service.enrich(createTask({ task_type: 'default' }), TEST_SESSION_ID, undefined);

    expect(result.type).toBe('enriched');
    const enriched = result as { type: 'enriched'; job: JobSubmission };
    expect(enriched.job.history).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: FAIL — `enrich()` doesn't accept a third argument / history not set

- [ ] **Step 3: Update `enrich()` to accept and pass through `history`**

In `packages/daemon/task-enrichment/src/enrichment-service.ts`, update the `enrich` method signature (line 69) and its return (line ~112-127):

```typescript
enrich(task: Task, sessionId: string, history?: string): EnrichmentResult {
```

And in the return object, add after the `payload` line:

```typescript
...(history ? { history } : {}),
```

The full return block becomes:

```typescript
return {
  type: 'enriched',
  job: {
    task_id: task.task_id,
    task_type: task.task_type,
    session_id: sessionId,
    payload: task.payload,
    ...(history ? { history } : {}),
    executors,
    submitted_at: task.submitted_at,
    system_prompt: systemPrompt,
    marketplaces: rule.marketplaces,
    ...(task.task_source ? { task_source: task.task_source } : {}),
    ...(rule.setup_hook !== undefined ? { setup_hook: rule.setup_hook } : {}),
    ...(rule.setup_hook_timeout_ms !== undefined ? { setup_hook_timeout_ms: rule.setup_hook_timeout_ms } : {}),
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "feat(enrichment): accept and pass through history in enrich()"
```

---

### Task 4: Update `EnrichmentPoller` to separate thread context into `history`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts:59-73`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Update existing tests that assert the concatenated payload**

In `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`, update the test `'prepends thread context to payload when task has lark source and thread exists'` (currently at line ~242). Change the assertion to verify `history` is passed separately:

```typescript
it('passes thread context as history and keeps payload unchanged', async () => {
  const task = createTask({
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'now fix the tests',
  });
  const jobSubmission = createJobSubmission({ payload: 'now fix the tests', history: 'user: fix CI' });
  mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({ threadContext: 'user: fix CI', inheritedTaskType: null, inheritedSessionId: null });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockThreadFetcher.fetchThreadContext).toHaveBeenCalledWith('om_msg1', expect.any(Set));
  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({ payload: 'now fix the tests' }),
    'generated-session-id',
    'user: fix CI',
  );
});
```

- [ ] **Step 2: Update the `'inherits generic task_type'` test**

Update the test `'inherits generic task_type from thread and keeps thread context prepending'` to verify `history` is passed separately instead of concatenated into `payload`:

```typescript
it('inherits generic task_type from thread and passes thread context as history', async () => {
  const task = createTask({
    task_type: 'generic',
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'follow up',
  });
  const jobSubmission = createJobSubmission({
    task_type: 'deploy',
    payload: 'follow up',
    history: 'user: deploy the app\nassistant: Job abc — success',
  });
  mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: deploy the app\nassistant: Job abc — success',
    inheritedTaskType: 'deploy',
    inheritedSessionId: null,
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({
      task_type: 'deploy',
      payload: 'follow up',
    }),
    'generated-session-id',
    'user: deploy the app\nassistant: Job abc — success',
  );
});
```

- [ ] **Step 3: Update the `'accepts matching explicit task_type in thread'` test**

Same pattern — verify `payload` is not concatenated, and `history` is passed as third arg to `enrich`:

```typescript
it('accepts matching explicit task_type in thread', async () => {
  const task = createTask({
    task_type: 'deploy',
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'follow up',
  });
  const jobSubmission = createJobSubmission({
    task_type: 'deploy',
    payload: 'follow up',
    history: 'user: deploy the app\nassistant: Job abc — success',
  });
  mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: deploy the app\nassistant: Job abc — success',
    inheritedTaskType: 'deploy',
    inheritedSessionId: null,
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({
      task_type: 'deploy',
      payload: 'follow up',
    }),
    'generated-session-id',
    'user: deploy the app\nassistant: Job abc — success',
  );
});
```

- [ ] **Step 4: Update the `'keeps current behavior when no inherited type found'` test**

This test has thread context but no inherited type. Thread context should still be passed as history:

```typescript
it('keeps current behavior when no inherited type found', async () => {
  const task = createTask({
    task_type: 'generic',
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'hello',
  });
  const jobSubmission = createJobSubmission({ task_type: 'generic' });
  mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: hello\nassistant: Job abc — success',
    inheritedTaskType: null,
    inheritedSessionId: null,
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({ task_type: 'generic', payload: 'hello' }),
    'generated-session-id',
    'user: hello\nassistant: Job abc — success',
  );
});
```

- [ ] **Step 5: Add test for no thread context (undefined history)**

Add a test in the `'EnrichmentPoller with ThreadContextFetcher'` describe block:

```typescript
it('passes undefined history when thread has no context', async () => {
  const task = createTask({
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'hello',
  });
  const jobSubmission = createJobSubmission({ payload: 'hello' });
  mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission } as EnrichmentResult);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: null,
    inheritedTaskType: null,
    inheritedSessionId: null,
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({ payload: 'hello' }),
    'generated-session-id',
    undefined,
  );
});
```

- [ ] **Step 6: Update the basic poller test (no thread fetcher) to pass undefined history**

In the first `describe('EnrichmentPoller', ...)` block, update the test `'fetches task, enriches, posts job, then acks task'` to verify `enrich` is called with `undefined` as history:

```typescript
expect(mockEnrich).toHaveBeenCalledWith(task, 'generated-session-id', undefined);
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: FAIL — `enrich` called with wrong arguments (payload is concatenated, no history arg)

- [ ] **Step 8: Update the enrichment poller source**

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`:

Replace lines 59-63 (the thread context prepend block):

```typescript
        if (threadResult.threadContext) {
          task.payload = `--- Thread Context ---\n${threadResult.threadContext}\n--- Current Message ---\n${task.payload}`;
          logger.info({ task_id: task.task_id }, 'Prepended thread context to payload');
        }
```

With:

```typescript
        // threadContext is now passed as separate history to enrich()
```

Then update the `enrich` call (line ~73) to pass thread context as history:

Replace:

```typescript
const enrichmentResult = this.enrichmentService.enrich(task, sessionId);
```

With:

```typescript
const threadHistory = threadResult?.threadContext ?? undefined;
const enrichmentResult = this.enrichmentService.enrich(task, sessionId, threadHistory);
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): separate thread context into history field instead of concatenating into payload"
```

---

### Task 5: Pass `history` through API route and orchestrator

**Files:**
- Modify: `packages/api/src/routes/jobs.ts:11,44-58`
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts:55-67`
- Test: `packages/api/src/__tests__/routes/jobs.test.ts`
- Test: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Write failing API test for history passthrough**

In `packages/api/src/__tests__/routes/jobs.test.ts`, add after the `setup_hook` test:

```typescript
it('returns 201 with history when provided', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/jobs')
    .send({ ...validJobSubmission(), history: 'user: hello\nassistant: hi' });
  expect(res.status).toBe(201);
  expect(res.body.history).toBe('user: hello\nassistant: hi');
  expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(
    expect.objectContaining({ history: 'user: hello\nassistant: hi' }),
  );
});

it('returns 201 without history when not provided', async () => {
  const app = buildApp();
  const res = await request(app)
    .post('/jobs')
    .send(validJobSubmission());
  expect(res.status).toBe(201);
  expect(res.body.history).toBeUndefined();
});
```

- [ ] **Step 2: Write failing orchestrator test for history passthrough**

In `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`, add a new test:

```typescript
it('passes history through to JobAttempt', async () => {
  const job = createJob({ history: 'user: hello\nassistant: hi' });
  await orchestrator.handle(job);

  expect(mockClaudeExecute).toHaveBeenCalledWith(
    expect.objectContaining({
      history: 'user: hello\nassistant: hi',
      payload: 'What is 2+2?',
    }),
    mockEnv,
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/api && npx vitest run src/__tests__/routes/jobs.test.ts`
Expected: FAIL — `history` not in response
Run: `cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: FAIL — `history` not in JobAttempt

- [ ] **Step 4: Update API route to pass through `history`**

In `packages/api/src/routes/jobs.ts`, update the destructuring (line 11) to include `history`:

```typescript
const { task_id, task_type, payload, history, executors, submitted_at, session_id, system_prompt, marketplaces, task_source, setup_hook, setup_hook_timeout_ms } = req.body;
```

And in the `job` construction (line ~44-58), add after the `payload` line:

```typescript
...(history ? { history } : {}),
```

- [ ] **Step 5: Update orchestrator to pass `history` to `JobAttempt`**

In `packages/daemon/task/src/core/task-orchestrator.ts`, update the `attempt` construction (line ~55-67) to include `history`:

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
};
```

- [ ] **Step 6: Run all tests to verify they pass**

Run: `cd packages/api && npx vitest run`
Expected: All PASS
Run: `cd packages/daemon/task && npx vitest run`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/jobs.ts packages/api/src/__tests__/routes/jobs.test.ts packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts
git commit -m "feat(api,orchestrator): pass history field through API route and JobAttempt"
```

---

### Task 6: Add `--continue` with fallback to `ClaudeCliExecutor`

**Files:**
- Modify: `packages/daemon/task/src/adapters/claude-cli-executor.ts`
- Test (modify existing): `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts`

**Note:** The test file already exists with comprehensive tests and uses `vi.mocked(spawn)`, `createMockChild()`, and `emitOutput()` helpers. We add new tests using the existing patterns rather than replacing the file.

- [ ] **Step 1: Update existing test helpers for new fields**

In `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts`:

Add `session_id` to `createJobAttempt`:

```typescript
function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-456',
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'claude_code',
    executor_model: 'opus',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    session_id: 'session-1',
    ...overrides,
  };
}
```

Add `isExistingWorkspace` to `createEnv`:

```typescript
function createEnv(overrides?: Partial<ExecutionEnvironment>): ExecutionEnvironment {
  return {
    workDir: '/tmp/localagent-job-test',
    pluginDirs: [],
    isExistingWorkspace: false,
    ...overrides,
  };
}
```

- [ ] **Step 2: Add new tests for `--continue` with fallback**

Append the following tests inside the existing `describe('ClaudeCliExecutor', ...)` block, after the last existing test:

```typescript
  it('spawns fresh session with history + payload when workspace is new and history exists', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(
      createJobAttempt({ history: 'user: hi\nassistant: hello', payload: 'do something' }),
      createEnv({ isExistingWorkspace: false }),
    );
    emitOutput(child, 'done', '', 0);
    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--continue');
    expect(child.stdinData).toBe(
      '--- Thread Context ---\nuser: hi\nassistant: hello\n--- Current Message ---\ndo something',
    );
  });

  it('tries --continue first when workspace exists, returns on success', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(
      createJobAttempt({ payload: 'do something' }),
      createEnv({ isExistingWorkspace: true }),
    );
    emitOutput(child, 'continued', '', 0);
    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('continued');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain('--continue');
    expect(child.stdinData).toBe('do something');
  });

  it('falls back to fresh session when --continue fails', async () => {
    const child1 = createMockChild();
    const child2 = createMockChild();
    mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

    const resultPromise = executor.execute(
      createJobAttempt({ history: 'user: hi\nassistant: hello', payload: 'do something' }),
      createEnv({ isExistingWorkspace: true }),
    );

    // First call: --continue fails
    emitOutput(child1, '', 'no session found', 1);
    // Wait for fallback to spawn second child
    await new Promise(r => setTimeout(r, 10));
    // Second call: fresh succeeds
    emitOutput(child2, 'fresh output', '', 0);

    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('fresh output');
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    // First call had --continue, payload only
    const firstArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(firstArgs).toContain('--continue');
    expect(child1.stdinData).toBe('do something');

    // Second call: no --continue, history + payload
    const secondArgs = mockSpawn.mock.calls[1][1] as string[];
    expect(secondArgs).not.toContain('--continue');
    expect(child2.stdinData).toBe(
      '--- Thread Context ---\nuser: hi\nassistant: hello\n--- Current Message ---\ndo something',
    );
  });

  it('falls back with payload only when --continue fails and no history', async () => {
    const child1 = createMockChild();
    const child2 = createMockChild();
    mockSpawn.mockReturnValueOnce(child1 as any).mockReturnValueOnce(child2 as any);

    const resultPromise = executor.execute(
      createJobAttempt({ payload: 'do something' }),
      createEnv({ isExistingWorkspace: true }),
    );
    emitOutput(child1, '', 'no session', 1);
    await new Promise(r => setTimeout(r, 10));
    emitOutput(child2, 'output', '', 0);

    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(child2.stdinData).toBe('do something');
  });

  it('does not use --continue when workspace is new even with no history', async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValue(child as any);

    const resultPromise = executor.execute(
      createJobAttempt({ payload: 'do something' }),
      createEnv({ isExistingWorkspace: false }),
    );
    emitOutput(child, 'done', '', 0);
    const result = await resultPromise;

    expect(result.status).toBe('success');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--continue');
    expect(child.stdinData).toBe('do something');
  });
```

- [ ] **Step 3: Run tests to verify new tests fail (existing tests may also fail due to `isExistingWorkspace` not yet on the interface)**

Run: `cd packages/daemon/task && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: FAIL — executor doesn't have continue logic yet

- [ ] **Step 4: Refactor `ClaudeCliExecutor` with `spawnClaude` helper and continue-fallback**

Replace the contents of `packages/daemon/task/src/adapters/claude-cli-executor.ts` with:

```typescript
import { spawn } from 'node:child_process';
import { JobAttempt, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:claude-cli');

export class ClaudeCliExecutor implements TaskExecutor {
  async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning Claude Code');

    if (!job.payload) {
      logger.error({ job_id: job.job_id, task_id: job.task_id }, 'Job payload is missing or empty — skipping');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Job payload is missing or empty',
      };
    }

    if (env.isExistingWorkspace) {
      const continueResult = await this.spawnClaude(job, env, { continue: true, includeHistory: false });
      if (continueResult.status === 'success') {
        return continueResult;
      }
      logger.warn(
        { job_id: job.job_id, session_id: job.session_id, exit_code: continueResult.exit_code },
        'Claude --continue failed, falling back to fresh session',
      );
    }

    return this.spawnClaude(job, env, { continue: false, includeHistory: true });
  }

  private spawnClaude(
    job: JobAttempt,
    env: ExecutionEnvironment,
    opts: { continue: boolean; includeHistory: boolean },
  ): Promise<TaskResultSubmission> {
    const args = [
      '--dangerously-skip-permissions',
      '--model', job.executor_model,
      ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
      ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
      ...(opts.continue ? ['--continue'] : []),
      '-p', '-',
    ];

    const input = opts.includeHistory && job.history
      ? `--- Thread Context ---\n${job.history}\n--- Current Message ---\n${job.payload}`
      : job.payload;

    return new Promise((resolve) => {
      const child = spawn('claude', args, { cwd: env.workDir });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      child.stdin.write(input);
      child.stdin.end();

      child.on('close', (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();

        if (code !== 0) {
          logger.error(
            { job_id: job.job_id, task_id: job.task_id, exit_code: code, stdout, stderr },
            'Claude Code failed',
          );

          resolve({
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            status: 'failure',
            exit_code: code,
            stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
            stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
          });
        } else {
          logger.info({ job_id: job.job_id, task_id: job.task_id, stdout, stderr }, 'Claude Code completed');

          resolve({
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            status: 'success',
            exit_code: 0,
            stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
            stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
          });
        }
      });

      child.on('error', (err) => {
        logger.error(
          { job_id: job.job_id, task_id: job.task_id, error: err.message },
          'Failed to spawn Claude Code',
        );

        resolve({
          job_id: job.job_id,
          task_id: job.task_id,
          task_type: job.task_type,
          status: 'failure',
          exit_code: null,
          stdout: '',
          stderr: err.message,
        });
      });
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/daemon/task && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task/src/adapters/claude-cli-executor.ts packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts
git commit -m "feat(executor): add --continue with fallback to ClaudeCliExecutor"
```

---

### Task 7: Add `--continue` with fallback to `TTADKExecutor`

**Files:**
- Modify: `packages/daemon/task/src/adapters/ttadk-executor.ts`
- Test (modify existing): `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts`

**Note:** The test file already exists with comprehensive tests and uses `vi.mocked(execFile)`, a `ExecFileCallback` type alias, and `ChildProcess` mock return. We add new tests using the existing patterns rather than replacing the file.

- [ ] **Step 1: Update existing test helpers for new fields**

In `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts`:

Add `session_id` to `createJobAttempt`:

```typescript
function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-456',
    task_id: 'test-456',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'ttadk',
    executor_model: 'gpt-5.4',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    session_id: 'session-1',
    ...overrides,
  };
}
```

Add `isExistingWorkspace` to `createEnv`:

```typescript
function createEnv(overrides?: Partial<ExecutionEnvironment>): ExecutionEnvironment {
  return {
    workDir: '/tmp/localagent-job-test',
    pluginDirs: [],
    isExistingWorkspace: false,
    ...overrides,
  };
}
```

- [ ] **Step 2: Add new tests for `--continue` with fallback**

Append the following tests inside the existing `describe('TTADKExecutor', ...)` block, after the last existing test:

```typescript
  it('spawns fresh session with history + payload when workspace is new and history exists', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'done', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(
      createJobAttempt({ history: 'user: hi\nassistant: hello', payload: 'do something' }),
      createEnv({ isExistingWorkspace: false }),
    );

    expect(result.status).toBe('success');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const claudeArgs = mockExecFile.mock.calls[0][1] as string[];
    const aFlagValue = claudeArgs[claudeArgs.indexOf('-a') + 1];
    expect(aFlagValue).toContain('--- Thread Context ---');
    expect(aFlagValue).toContain('--- Current Message ---');
    expect(aFlagValue).not.toContain('--continue');
  });

  it('tries --continue first when workspace exists, returns on success', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'continued', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(
      createJobAttempt({ payload: 'do something' }),
      createEnv({ isExistingWorkspace: true }),
    );

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('continued');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const claudeArgs = mockExecFile.mock.calls[0][1] as string[];
    const aFlagValue = claudeArgs[claudeArgs.indexOf('-a') + 1];
    expect(aFlagValue).toContain('--continue');
    expect(aFlagValue).toContain('-p do something');
  });

  it('falls back to fresh session when --continue fails', async () => {
    // First call: --continue fails
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback) => {
      const error = Object.assign(new Error('fail'), { code: 1, stdout: '', stderr: 'no session' });
      (callback as ExecFileCallback)(error, '', 'no session');
      return {} as ChildProcess;
    });
    // Second call: fresh succeeds
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'fresh output', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(
      createJobAttempt({ history: 'user: hi\nassistant: hello', payload: 'do something' }),
      createEnv({ isExistingWorkspace: true }),
    );

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('fresh output');
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    // First call had --continue
    const firstArgs = mockExecFile.mock.calls[0][1] as string[];
    const firstAFlag = firstArgs[firstArgs.indexOf('-a') + 1];
    expect(firstAFlag).toContain('--continue');

    // Second call: no --continue, history + payload
    const secondArgs = mockExecFile.mock.calls[1][1] as string[];
    const secondAFlag = secondArgs[secondArgs.indexOf('-a') + 1];
    expect(secondAFlag).not.toContain('--continue');
    expect(secondAFlag).toContain('--- Thread Context ---');
  });

  it('falls back with payload only when --continue fails and no history', async () => {
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback) => {
      const error = Object.assign(new Error('fail'), { code: 1, stdout: '', stderr: 'no session' });
      (callback as ExecFileCallback)(error, '', 'no session');
      return {} as ChildProcess;
    });
    mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, 'output', '');
      return {} as ChildProcess;
    });

    const result = await executor.execute(
      createJobAttempt({ payload: 'do something' }),
      createEnv({ isExistingWorkspace: true }),
    );

    expect(result.status).toBe('success');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const secondArgs = mockExecFile.mock.calls[1][1] as string[];
    const secondAFlag = secondArgs[secondArgs.indexOf('-a') + 1];
    expect(secondAFlag).not.toContain('--continue');
    expect(secondAFlag).toContain('-p do something');
  });
```

- [ ] **Step 3: Run tests to verify new tests fail (existing tests may also fail due to `isExistingWorkspace` not yet on the interface)**

Run: `cd packages/daemon/task && npx vitest run src/adapters/__tests__/ttadk-executor.test.ts`
Expected: FAIL

- [ ] **Step 4: Refactor `TTADKExecutor` with `spawnTtadk` helper and continue-fallback**

Replace the contents of `packages/daemon/task/src/adapters/ttadk-executor.ts` with:

```typescript
import { execFile } from 'node:child_process';
import { JobAttempt, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:ttadk');

export class TTADKExecutor implements TaskExecutor {
  async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning TTADK');

    if (!job.payload) {
      logger.error({ job_id: job.job_id, task_id: job.task_id }, 'Job payload is missing or empty — skipping');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Job payload is missing or empty',
      };
    }

    if (env.isExistingWorkspace) {
      const continueResult = await this.spawnTtadk(job, env, { continue: true, includeHistory: false });
      if (continueResult.status === 'success') {
        return continueResult;
      }
      logger.warn(
        { job_id: job.job_id, session_id: job.session_id, exit_code: continueResult.exit_code },
        'TTADK --continue failed, falling back to fresh session',
      );
    }

    return this.spawnTtadk(job, env, { continue: false, includeHistory: true });
  }

  private spawnTtadk(
    job: JobAttempt,
    env: ExecutionEnvironment,
    opts: { continue: boolean; includeHistory: boolean },
  ): Promise<TaskResultSubmission> {
    const input = opts.includeHistory && job.history
      ? `--- Thread Context ---\n${job.history}\n--- Current Message ---\n${job.payload}`
      : job.payload;

    const claudeArgs = [
      '--bare',
      '--dangerously-skip-permissions',
      ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
      ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
      ...(opts.continue ? ['--continue'] : []),
      '-p', input,
    ].join(' ');

    const args = ['code', '-t', 'claude', '-m', job.executor_model, '-a', claudeArgs];

    return new Promise((resolve) => {
      execFile(
        'ttadk',
        args,
        { maxBuffer: 50 * 1024 * 1024, cwd: env.workDir },
        (error, stdout, stderr) => {
          if (error) {
            const execErr = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            logger.error(
              { job_id: job.job_id, task_id: job.task_id, exit_code: execErr.code, stdout: execErr.stdout, stderr: execErr.stderr },
              'TTADK failed',
            );

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              task_type: job.task_type,
              status: 'failure',
              exit_code: typeof execErr.code === 'number' ? execErr.code : null,
              stdout: truncate(execErr.stdout ?? '', MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(execErr.stderr ?? '', MAX_RESULT_OUTPUT_BYTES),
            });
          } else {
            logger.info({ job_id: job.job_id, task_id: job.task_id, stdout, stderr }, 'TTADK completed');

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              task_type: job.task_type,
              status: 'success',
              exit_code: 0,
              stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
            });
          }
        },
      );
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/daemon/task && npx vitest run src/adapters/__tests__/ttadk-executor.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run all tests across affected packages**

Run: `cd packages/daemon/task && npx vitest run`
Run: `cd packages/daemon/task-enrichment && npx vitest run`
Run: `cd packages/api && npx vitest run`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/task/src/adapters/ttadk-executor.ts packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts
git commit -m "feat(executor): add --continue with fallback to TTADKExecutor"
```
