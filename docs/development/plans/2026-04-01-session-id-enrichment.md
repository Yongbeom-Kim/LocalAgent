# Session ID Enrichment Implementation Plan

**Goal:** Add a `session_id` (UUID v7) to enriched jobs that propagates through the full pipeline, inheriting from Lark thread bot replies when available.

**Architecture:** Mirror the existing `task_type` inheritance pattern. The enrichment poller assigns `session_id` — either inherited from a bot reply in the Lark thread or freshly generated. The ID flows through `JobSubmission` → `Job` → `JobAttempt` → `TaskResultSubmission` → `TaskResult`. The lark-result daemon embeds `session_id` in bot reply text for future thread inheritance.

**Tech Stack:** TypeScript, uuidv7 (npm), Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/package.json` | Modify | Add `uuidv7` dependency |
| `packages/shared/src/session.ts` | Create | `generateSessionId()` utility |
| `packages/shared/src/index.ts` | Modify | Re-export `generateSessionId` |
| `packages/shared/src/types.ts` | Modify | Add `session_id` to pipeline types |
| `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Modify | Extract + strip `session_id` from thread messages |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Accept `sessionId` param in `enrich()` |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Modify | Assign session_id (inherit or generate), pass to `enrich()` |
| `packages/daemon/task/src/task-poller.ts` | Modify | Forward `session_id` from job to result |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Modify | Include `session_id` in `JobAttempt` |
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Modify | Add `session_id:` line to bot reply text |
| `packages/api/src/routes/jobs.ts` | Modify | Validate and pass `session_id` through |
| `packages/api/src/routes/results.ts` | Modify | Accept optional `session_id` |

---

### Task 1: Add `uuidv7` dependency and `generateSessionId()` utility

**Files:**
- Modify: `packages/shared/package.json`
- Create: `packages/shared/src/session.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Install uuidv7 in the shared package**

```bash
cd packages/shared && npm install uuidv7
```

- [ ] **Step 2: Create `session.ts` with `generateSessionId()`**

Create `packages/shared/src/session.ts`:

```typescript
import { uuidv7 } from 'uuidv7';

export function generateSessionId(): string {
  return uuidv7();
}
```

- [ ] **Step 3: Re-export from `index.ts`**

Add to `packages/shared/src/index.ts`:

```typescript
export { generateSessionId } from './session';
```

- [ ] **Step 4: Build the shared package to verify**

```bash
cd packages/shared && npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/package.json packages/shared/package-lock.json packages/shared/src/session.ts packages/shared/src/index.ts
git commit -m "feat(shared): add generateSessionId utility using uuidv7"
```

---

### Task 2: Add `session_id` to pipeline types

**Files:**
- Modify: `packages/shared/src/types.ts:71-149`

- [ ] **Step 1: Add `session_id: string` to `JobSubmission`, `Job`, `JobAttempt`**

In `packages/shared/src/types.ts`, add `session_id: string` to these interfaces:

`JobSubmission` (after `submitted_at` field, line ~77):
```typescript
export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
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

`Job` (after `enriched_at` field, line ~91):
```typescript
export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
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

`JobAttempt` (after `enriched_at` field, line ~101):
```typescript
export interface JobAttempt {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
  enriched_at: string;
  session_id: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
}
```

- [ ] **Step 2: Add `session_id?: string` to `TaskResultSubmission`**

`TaskResultSubmission` (after `task_type` field, line ~138):
```typescript
export interface TaskResultSubmission {
  job_id: string;
  task_id: string;
  task_type: string;
  session_id?: string;
  status: ResultStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  task_source?: TaskSource;
}
```

Note: `session_id` is optional on `TaskResultSubmission` (and by extension `TaskResult`) because the enrichment poller's `publishRejection()` creates results without going through enrichment.

- [ ] **Step 3: Build to see all type errors across the monorepo**

```bash
cd packages/shared && npm run build
```

Expected: Build succeeds. Downstream packages will have type errors (fixed in later tasks).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): add session_id to Job, JobSubmission, JobAttempt, TaskResultSubmission types"
```

---

### Task 3: Add `session_id` extraction and stripping to `ThreadContextFetcher`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts:1-170`
- Test: `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`

- [ ] **Step 1: Write failing tests for session_id extraction**

Add to `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`, a new `describe` block after the existing `task_type line stripping` block:

```typescript
describe('session_id extraction from thread messages', () => {
  let fetcher: ThreadContextFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new ThreadContextFetcher(APP_ID, APP_SECRET);
  });

  it('extracts session_id from first bot message with valid UUID v7', async () => {
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
            body: { content: JSON.stringify({ text: 'deploy the app' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'Task ID: task-123\nJob ID: job-456\ntask_type: deploy\nsession_id: 019573e0-7b0c-7f00-8000-000000000001\nstatus: success\nExit code: 0\nOutput:\nhello',
              }),
            },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'check status' }) },
          },
        ]),
      );

    const result = await fetcher.fetchThreadContext('om_new_msg');

    expect(result).not.toBeNull();
    expect(result!.inheritedSessionId).toBe('019573e0-7b0c-7f00-8000-000000000001');
  });

  it('returns null inheritedSessionId when no bot message has session_id tag', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'Job abc — success' }) },
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
    expect(result!.inheritedSessionId).toBeNull();
  });

  it('ignores session_id tags in user messages', async () => {
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
            body: { content: JSON.stringify({ text: 'session_id: 019573e0-7b0c-7f00-8000-000000000001' }) },
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
    expect(result!.inheritedSessionId).toBeNull();
  });

  it('ignores malformed session_id (not UUID v7)', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'session_id: not-a-uuid\nJob abc — success' }) },
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
    expect(result!.inheritedSessionId).toBeNull();
  });
});

describe('session_id line stripping from thread context', () => {
  let fetcher: ThreadContextFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new ThreadContextFetcher(APP_ID, APP_SECRET);
  });

  it('strips session_id line from bot message in thread context', async () => {
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
            body: { content: JSON.stringify({ text: 'hello' }) },
          },
          {
            message_id: 'om_bot_reply',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: {
              content: JSON.stringify({
                text: 'task_type: deploy\nsession_id: 019573e0-7b0c-7f00-8000-000000000001\nJob abc — success',
              }),
            },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const validTypes = new Set(['deploy']);
    const result = await fetcher.fetchThreadContext('om_new_msg', validTypes);

    expect(result).not.toBeNull();
    expect(result!.threadContext).toBe('user: hello\nassistant: Job abc — success');
    expect(result!.threadContext).not.toContain('session_id:');
    expect(result!.threadContext).not.toContain('task_type:');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts
```

Expected: FAIL — `inheritedSessionId` property does not exist on `ThreadContextResult`.

- [ ] **Step 3: Implement session_id extraction and stripping**

In `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`:

Add regex constants (after existing `TASK_TYPE_LINE_REGEX` at line 14):
```typescript
const SESSION_ID_REGEX = /^session_id: ([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/m;
const SESSION_ID_LINE_REGEX = /^session_id: [0-9a-f-]+\n?/m;
```

Update `ThreadContextResult` (line 16-19):
```typescript
export interface ThreadContextResult {
  threadContext: string | null;
  inheritedTaskType: string | null;
  inheritedSessionId: string | null;
}
```

In the `doFetch()` method, add session_id extraction after the existing task_type extraction block (after line ~74):
```typescript
    // Extract session_id from first bot message that has one
    let inheritedSessionId: string | null = null;
    for (const m of messages) {
      if (m.sender.sender_type === 'user') continue;
      const content = extractLarkMessageContent(m.msg_type, m.body.content);
      const match = content.match(SESSION_ID_REGEX);
      if (match) {
        inheritedSessionId = match[1];
        break;
      }
    }
```

Update the return statements in `doFetch()` to include `inheritedSessionId`:

The early return (line ~80):
```typescript
    return { threadContext: null, inheritedTaskType, inheritedSessionId };
```

Add stripping of session_id lines in the formatting section (line ~87), after the existing `TASK_TYPE_LINE_REGEX` replace:
```typescript
        content = content.replace(TASK_TYPE_LINE_REGEX, '');
        content = content.replace(SESSION_ID_LINE_REGEX, '');
```

The final return (line ~92):
```typescript
    return { threadContext: threadContext || null, inheritedTaskType, inheritedSessionId };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts
git commit -m "feat(enrichment): extract and strip session_id from thread messages"
```

---

### Task 4: Add `sessionId` parameter to `EnrichmentService.enrich()`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts:69-127`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Write failing test**

Add a new `describe` block at the end of `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`:

```typescript
describe('session_id passthrough', () => {
  it('includes session_id in enriched job when provided', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'default' }), 'ses-uuid-v7-123');

    expect(result.type).toBe('enriched');
    expect((result as { type: 'enriched'; job: JobSubmission }).job.session_id).toBe('ses-uuid-v7-123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts -t "session_id passthrough"
```

Expected: FAIL — `enrich()` doesn't accept second argument / `session_id` not in return.

- [ ] **Step 3: Implement**

In `packages/daemon/task-enrichment/src/enrichment-service.ts`, change the `enrich()` method signature (line 69):

```typescript
  enrich(task: Task, sessionId: string): EnrichmentResult {
```

Add `session_id: sessionId` to the returned `JobSubmission` object (after `task_type: task.task_type`, around line 117):

```typescript
    return {
      type: 'enriched',
      job: {
        task_id: task.task_id,
        task_type: task.task_type,
        payload: task.payload,
        executors,
        submitted_at: task.submitted_at,
        session_id: sessionId,
        system_prompt: systemPrompt,
        marketplaces: rule.marketplaces,
        ...(task.task_source ? { task_source: task.task_source } : {}),
        ...(rule.setup_hook !== undefined ? { setup_hook: rule.setup_hook } : {}),
        ...(rule.setup_hook_timeout_ms !== undefined ? { setup_hook_timeout_ms: rule.setup_hook_timeout_ms } : {}),
      },
    };
```

- [ ] **Step 4: Fix existing tests that call `enrich()` without `sessionId`**

All existing calls to `service.enrich(task)` in `enrichment-service.test.ts` need a second argument. Add a constant at the top of the test file (after `createTask` function):

```typescript
const DUMMY_SESSION_ID = 'test-session-id';
```

Then find-and-replace all `service.enrich(createTask(` with `service.enrich(createTask(` and add `, DUMMY_SESSION_ID)` as the second argument. Specifically, update every call like:

- `service.enrich(createTask({ task_type: 'code_review' }))` → `service.enrich(createTask({ task_type: 'code_review' }), DUMMY_SESSION_ID)`
- `service.enrich(createTask())` → `service.enrich(createTask(), DUMMY_SESSION_ID)`
- `service.enrich(createTask({ task_type: 'unknown_type' }))` → `service.enrich(createTask({ task_type: 'unknown_type' }), DUMMY_SESSION_ID)`
- etc. for all ~20 calls

- [ ] **Step 5: Run all enrichment-service tests**

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "feat(enrichment): add sessionId parameter to EnrichmentService.enrich()"
```

---

### Task 5: Assign `session_id` in `EnrichmentPoller`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts:1-141`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`.

First, mock `generateSessionId` at the top of the file (after the existing mocks around line 16):

```typescript
const mockGenerateSessionId = vi.fn().mockReturnValue('mock-session-id-001');

vi.mock('@local-agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@local-agent/shared')>();
  return {
    ...actual,
    generateSessionId: (...args: unknown[]) => mockGenerateSessionId(...args),
  };
});
```

Note: This mock needs to be placed carefully. The existing file imports `Task`, `JobSubmission`, and `createLogger` from `@local-agent/shared`. Check if there's already a mock for this module — if so, extend it rather than adding a second one.

Update `createJobSubmission` to include `session_id`:
```typescript
function createJobSubmission(overrides?: Partial<JobSubmission>): JobSubmission {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this',
    executors: [
      { executor: 'claude_code', executor_model: 'opus' },
    ],
    submitted_at: '2026-03-29T00:00:00.000Z',
    session_id: 'mock-session-id-001',
    ...overrides,
  };
}
```

Add a new `describe` block at the end:

```typescript
describe('EnrichmentPoller session_id assignment', () => {
  let poller: EnrichmentPoller;
  let mockThreadFetcher: { fetchThreadContext: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateSessionId.mockReturnValue('mock-session-id-001');
    const service = new EnrichmentService() as any;
    mockThreadFetcher = { fetchThreadContext: vi.fn() };
    poller = new EnrichmentPoller(
      'http://localhost:3000',
      service,
      mockThreadFetcher as unknown as ThreadContextFetcher,
    );
  });

  afterEach(() => {
    poller.stop();
  });

  it('generates new session_id when task has no thread', async () => {
    const task = createTask({ payload: 'hello' });
    const jobSubmission = createJobSubmission({ payload: 'hello' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalledWith(expect.anything(), 'mock-session-id-001');
  });

  it('generates new session_id when thread has no inherited session_id', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'follow up',
    });
    const jobSubmission = createJobSubmission();
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: hello',
      inheritedTaskType: null,
      inheritedSessionId: null,
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalledWith(expect.anything(), 'mock-session-id-001');
  });

  it('inherits session_id from thread when available', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'follow up',
    });
    const jobSubmission = createJobSubmission({ session_id: '019573e0-7b0c-7f00-8000-000000000001' });
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue({
      threadContext: 'user: hello\nassistant: Job abc — success',
      inheritedTaskType: 'deploy',
      inheritedSessionId: '019573e0-7b0c-7f00-8000-000000000001',
    });

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).not.toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalledWith(expect.anything(), '019573e0-7b0c-7f00-8000-000000000001');
  });

  it('generates new session_id when thread context fetch fails (returns null)', async () => {
    const task = createTask({
      task_source: { source: 'lark', message_id: 'om_msg1' },
      payload: 'hello',
    });
    const jobSubmission = createJobSubmission();
    mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission });
    mockThreadFetcher.fetchThreadContext.mockResolvedValue(null);

    mockFetch
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
      .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

    await poller.pollOnce();

    expect(mockGenerateSessionId).toHaveBeenCalled();
    expect(mockEnrich).toHaveBeenCalledWith(expect.anything(), 'mock-session-id-001');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts -t "session_id"
```

Expected: FAIL — `enrich()` is called with one argument, not two.

- [ ] **Step 3: Implement session_id assignment in enrichment-poller.ts**

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`:

Add import (line 1):
```typescript
import { Task, createLogger, generateSessionId } from '@local-agent/shared';
```

After the thread context block (after line 47, before `const enrichmentResult`), add session_id logic:

```typescript
      // Determine session_id: inherit from thread or generate new
      let sessionId: string;
      if (threadResult?.inheritedSessionId) {
        sessionId = threadResult.inheritedSessionId;
        logger.info({ task_id: task.task_id, inherited_session_id: sessionId }, 'Inherited session_id from thread');
      } else {
        sessionId = generateSessionId();
        logger.info({ task_id: task.task_id, new_session_id: sessionId }, 'Generated new session_id');
      }
```

Note: `threadResult` is only defined inside the `if (this.threadContextFetcher && task.task_source?.source === 'lark')` block. Declare it before the block so it's accessible:

Move `threadResult` to before the if-block:
```typescript
      let threadResult: ThreadContextResult | null | undefined;

      if (this.threadContextFetcher && task.task_source?.source === 'lark') {
        const validTaskTypes = this.enrichmentService.getValidTaskTypes();
        threadResult = await this.threadContextFetcher.fetchThreadContext(task.task_source.message_id, validTaskTypes);
        // ... existing thread context handling ...
      }

      // Determine session_id
      let sessionId: string;
      if (threadResult?.inheritedSessionId) {
        sessionId = threadResult.inheritedSessionId;
        logger.info({ task_id: task.task_id, inherited_session_id: sessionId }, 'Inherited session_id from thread');
      } else {
        sessionId = generateSessionId();
        logger.info({ task_id: task.task_id, new_session_id: sessionId }, 'Generated new session_id');
      }

      const enrichmentResult = this.enrichmentService.enrich(task, sessionId);
```

Also add the import for `ThreadContextResult`:
```typescript
import type { ThreadContextFetcher, ThreadContextResult } from './adapters/thread-context-fetcher';
```

- [ ] **Step 4: Fix existing enrichment-poller tests**

The existing tests call `mockEnrich` which is verified against `enrich(task)` (one arg). Now `enrich()` takes two args. Update existing test assertions:

In the first `describe('EnrichmentPoller')` block, update `beforeEach` to mock `generateSessionId`:
- The existing tests that don't have a thread fetcher will need `mockGenerateSessionId` to be called.
- Update assertion at line 80: `expect(mockEnrich).toHaveBeenCalledWith(task)` → `expect(mockEnrich).toHaveBeenCalledWith(task, 'mock-session-id-001')`

Similarly update all other `mockEnrich` call assertions in the existing tests.

For the `describe('EnrichmentPoller with ThreadContextFetcher')` block, update assertions similarly and add `inheritedSessionId: null` to the `mockThreadFetcher.fetchThreadContext.mockResolvedValue` calls.

- [ ] **Step 5: Run all enrichment-poller tests**

```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): assign session_id in enrichment poller (inherit or generate)"
```

---

### Task 6: Forward `session_id` in task-orchestrator and task-poller

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts:53-64`
- Modify: `packages/daemon/task/src/task-poller.ts:46-50`
- Test: `packages/daemon/task/src/__tests__/task-poller.test.ts`

- [ ] **Step 1: Write failing test for session_id forwarding in task-poller**

Add to `packages/daemon/task/src/__tests__/task-poller.test.ts`, after the existing `forwards task_type` test (line ~241):

```typescript
    it('forwards session_id from job to result submission', async () => {
      const job = createJob({ session_id: '019573e0-7b0c-7f00-8000-000000000001' });

      mockFetch
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve(job),
        })
        .mockResolvedValueOnce({
          status: 201,
          json: () => Promise.resolve({ result_id: 'res-1' }),
        })
        .mockResolvedValueOnce({
          status: 200,
          json: () => Promise.resolve({ acknowledged: true }),
        });

      await poller.pollOnce();

      const resultPostBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(resultPostBody.session_id).toBe('019573e0-7b0c-7f00-8000-000000000001');
    });
```

Also update `createJob` to include `session_id` in the defaults (line ~49):
```typescript
function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'abc-123',
    task_type: 'generic',
    payload: 'hello',
    executors: [{ executor: 'claude_code', executor_model: 'opus' }],
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    session_id: 'default-session-id',
    ...overrides,
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/daemon/task && npx vitest run src/__tests__/task-poller.test.ts -t "forwards session_id"
```

Expected: FAIL — `session_id` not present in result body.

- [ ] **Step 3: Add `session_id` to `JobAttempt` creation in task-orchestrator.ts**

In `packages/daemon/task/src/core/task-orchestrator.ts`, add `session_id` to the `JobAttempt` construction (line ~53-64):

```typescript
          const attempt: JobAttempt = {
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            payload: job.payload,
            executor: pref.executor,
            executor_model: pref.executor_model,
            submitted_at: job.submitted_at,
            enriched_at: job.enriched_at,
            session_id: job.session_id,
            system_prompt: job.system_prompt,
            marketplaces: job.marketplaces,
          };
```

- [ ] **Step 4: Add `session_id` forwarding in task-poller.ts**

In `packages/daemon/task/src/task-poller.ts`, add `session_id` to the result (line ~46-50):

```typescript
      const resultWithSource: TaskResultSubmission = {
        ...result,
        task_type: job.task_type,
        session_id: job.session_id,
        ...(job.task_source ? { task_source: job.task_source } : {}),
      };
```

- [ ] **Step 5: Run all task-poller tests**

```bash
cd packages/daemon/task && npx vitest run src/__tests__/task-poller.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/task-poller.ts packages/daemon/task/src/__tests__/task-poller.test.ts
git commit -m "feat(task-daemon): forward session_id from job to result submission"
```

---

### Task 7: Add `session_id` line to Lark bot reply

**Files:**
- Modify: `packages/daemon/lark-result/src/adapters/lark-notifier.ts:58-65`
- Test: `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`

- [ ] **Step 1: Write failing tests for session_id in bot reply**

Add to `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`, a new `describe` block:

```typescript
describe('session_id in bot reply text', () => {
  let notifier: LarkNotifier;

  beforeEach(() => {
    vi.clearAllMocks();
    notifier = new LarkNotifier('app-id', 'app-secret', 'user-123');
  });

  it('includes session_id line in reply text when session_id is present', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult({ session_id: '019573e0-7b0c-7f00-8000-000000000001' }));

    const sentBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const text = JSON.parse(sentBody.content).text;
    expect(text).toContain('session_id: 019573e0-7b0c-7f00-8000-000000000001');
  });

  it('omits session_id line when session_id is not present', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await notifier.notify(createResult());

    const sentBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const text = JSON.parse(sentBody.content).text;
    expect(text).not.toContain('session_id:');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts -t "session_id"
```

Expected: FAIL — session_id line not in reply text yet.

- [ ] **Step 3: Add `session_id` line to bot reply text**

In `packages/daemon/lark-result/src/adapters/lark-notifier.ts`, update the `text` construction (line ~58-65):

```typescript
    const text = [
      `Task ID: ${result.task_id}`,
      `Job ID: ${result.job_id}`,
      `task_type: ${result.task_type}`,
      ...(result.session_id ? [`session_id: ${result.session_id}`] : []),
      `status: ${result.status}`,
      `Exit code: ${result.exit_code ?? 'N/A'}`,
      result.stdout ? `Output:\n${result.stdout}` : 'No output',
    ].join('\n');
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-result/src/adapters/lark-notifier.ts packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts
git commit -m "feat(lark-result): add session_id line to bot reply text"
```

---

### Task 8: Pass `session_id` through API routes

**Files:**
- Modify: `packages/api/src/routes/jobs.ts:11,40-53`
- Modify: `packages/api/src/routes/results.ts:11,34-45`
- Test: `packages/api/src/__tests__/routes/jobs.test.ts`
- Test: `packages/api/src/__tests__/routes/results.test.ts`

- [ ] **Step 1: Write failing test for `POST /jobs` session_id validation**

Add to `packages/api/src/__tests__/routes/jobs.test.ts`:

Update `validJobSubmission()` to include `session_id`:
```typescript
function validJobSubmission() {
  return {
    task_id: 'task-123',
    task_type: 'generic',
    payload: 'hello',
    executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
    submitted_at: '2026-03-31T00:00:00.000Z',
    session_id: '019573e0-7b0c-7f00-8000-000000000001',
  };
}
```

Add new tests:
```typescript
  it('returns 201 with session_id when provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/jobs')
      .send(validJobSubmission());
    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe('019573e0-7b0c-7f00-8000-000000000001');
    expect(mockRabbitMQ.publishJob).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: '019573e0-7b0c-7f00-8000-000000000001' }),
    );
  });

  it('returns 400 when session_id is missing', async () => {
    const app = buildApp();
    const { session_id, ...noSessionId } = validJobSubmission();
    const res = await request(app).post('/jobs').send(noSessionId);
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Write failing test for `POST /results` optional session_id**

Add to `packages/api/src/__tests__/routes/results.test.ts`:

```typescript
  it('returns 201 with session_id when provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/results')
      .send({ ...validSubmission(), session_id: '019573e0-7b0c-7f00-8000-000000000001' });
    expect(res.status).toBe(201);
    expect(res.body.session_id).toBe('019573e0-7b0c-7f00-8000-000000000001');
  });

  it('returns 201 without session_id when not provided', async () => {
    const app = buildApp();
    const res = await request(app).post('/results').send(validSubmission());
    expect(res.status).toBe(201);
    expect(res.body.session_id).toBeUndefined();
  });

  it('returns 400 when session_id is not a string', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/results')
      .send({ ...validSubmission(), session_id: 123 });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd packages/api && npx vitest run src/__tests__/routes/jobs.test.ts src/__tests__/routes/results.test.ts
```

Expected: FAIL — session_id not handled in routes.

- [ ] **Step 4: Add `session_id` validation to `POST /jobs` route**

In `packages/api/src/routes/jobs.ts`:

Update destructuring (line 11):
```typescript
      const { task_id, task_type, payload, executors, submitted_at, system_prompt, marketplaces, task_source, setup_hook, setup_hook_timeout_ms, session_id } = req.body;
```

Add validation after the existing `task_source` validation (after line 37):
```typescript
      if (typeof session_id !== 'string' || !session_id) {
        res.status(400).json({ error: 'session_id is required and must be a string' });
        return;
      }
```

Add `session_id` to the `Job` object (after line 47, inside the object):
```typescript
      const job: Job = {
        job_id: uuidv4(),
        task_id,
        task_type,
        payload,
        executors,
        submitted_at,
        enriched_at: new Date().toISOString(),
        session_id,
        ...(system_prompt ? { system_prompt } : {}),
        ...(marketplaces ? { marketplaces } : {}),
        ...(task_source ? { task_source } : {}),
        ...(setup_hook !== undefined ? { setup_hook } : {}),
        ...(setup_hook_timeout_ms !== undefined ? { setup_hook_timeout_ms } : {}),
      };
```

- [ ] **Step 5: Add optional `session_id` handling to `POST /results` route**

In `packages/api/src/routes/results.ts`:

Update destructuring (line 11):
```typescript
      const { job_id, task_id, status, exit_code, stdout, stderr, task_source, task_type, session_id } = req.body;
```

Add validation after the `task_type` check (after line 32):
```typescript
      if (session_id !== undefined && typeof session_id !== 'string') {
        res.status(400).json({ error: 'session_id must be a string if provided' });
        return;
      }
```

Add `session_id` to the `TaskResult` object (around line 44):
```typescript
      const result: TaskResult = {
        result_id: uuidv4(),
        job_id,
        task_id,
        task_type: typeof task_type === 'string' ? task_type : 'generic',
        status: status as TaskResult['status'],
        exit_code: typeof exit_code === 'number' ? exit_code : null,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
        completed_at: new Date().toISOString(),
        ...(typeof session_id === 'string' ? { session_id } : {}),
        ...(task_source ? { task_source } : {}),
      };
```

- [ ] **Step 6: Run all API route tests**

```bash
cd packages/api && npx vitest run src/__tests__/routes/jobs.test.ts src/__tests__/routes/results.test.ts
```

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/routes/jobs.ts packages/api/src/routes/results.ts packages/api/src/__tests__/routes/jobs.test.ts packages/api/src/__tests__/routes/results.test.ts
git commit -m "feat(api): add session_id to jobs and results routes"
```

---

### Task 9: Full build verification

**Files:** None (verification only)

- [ ] **Step 1: Build entire monorepo**

```bash
cd /Users/bytedance/.ows/workspaces/personal_productivity/LocalAgent && npm run build
```

Expected: Build succeeds with no type errors across all packages.

- [ ] **Step 2: Run all tests**

```bash
cd /Users/bytedance/.ows/workspaces/personal_productivity/LocalAgent && npm test
```

Expected: All tests pass.

- [ ] **Step 3: Fix any remaining type errors or test failures**

If any downstream packages fail to compile because they create `Job`, `JobSubmission`, or `JobAttempt` objects without `session_id`, add the field to those constructions. Check:
- `packages/daemon/task/src/core/task-orchestrator.ts` — `JobAttempt` construction (already handled in Task 6)
- Any other files that construct these types

- [ ] **Step 4: Commit any fixes**

Stage only the files that were modified to fix type errors, then commit:

```bash
git add <files-that-were-fixed>
git commit -m "fix: resolve remaining session_id type errors across packages"
```
