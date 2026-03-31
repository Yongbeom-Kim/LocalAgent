# Task Type Thread Inheritance Implementation Plan

**Goal:** Make Lark thread replies inherit the `task_type` from the root message's bot response, so the entire thread uses consistent enrichment rules.

**Architecture:** The lark-result daemon tags each bot reply with a `task_type: <value>` prefix line. When the enrichment daemon processes a thread reply, it extracts the task_type from the first valid bot message and overrides the task's `task_type` (if currently `'generic'`). The tag line is stripped from thread context before it reaches the executor.

**Tech Stack:** TypeScript, Vitest, Lark Open API (existing integration)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Add `task_type` to `TaskResultSubmission` |
| `packages/daemon/task/src/task-poller.ts` | Modify | Attach `task_type` from job to result |
| `packages/api/src/routes/results.ts` | Modify | Pass `task_type` through to RabbitMQ |
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Modify | Prepend `task_type:` line to reply text |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Add `getValidTaskTypes()` method |
| `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Modify | New return type, task_type extraction, stripping |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Modify | Use new return type, apply inherited task_type |

---

### Task 1: Add `task_type` to `TaskResultSubmission`

**Files:**
- Modify: `packages/shared/src/types.ts:135-143`

- [ ] **Step 1: Add `task_type` field to `TaskResultSubmission`**

In `packages/shared/src/types.ts`, add `task_type: string;` to the `TaskResultSubmission` interface:

```typescript
export interface TaskResultSubmission {
  job_id: string;
  task_id: string;
  task_type: string;          // ← ADD THIS LINE
  status: ResultStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  task_source?: TaskSource;
}
```

`TaskResult` extends `TaskResultSubmission`, so it inherits the field automatically.

- [ ] **Step 2: Fix downstream test helpers that construct `TaskResult` without `task_type`**

Adding a required `task_type` field will cause type errors in test files that construct `TaskResult` or `TaskResultSubmission` objects. Add `task_type: 'generic'` to each of these:

- `packages/daemon/lark-result/src/__tests__/lark-poller.test.ts` — `sampleResult` object (after `task_id` line)
- `packages/daemon/telegram-result/src/__tests__/telegram-notifier.test.ts` — `createResult()` helper (after `task_id` line)
- `packages/daemon/telegram-result/src/__tests__/telegram-poller.test.ts` — `sampleResult` object (after `task_id` line)

(The `task-poller.test.ts` and `lark-notifier.test.ts` helpers are updated in their respective tasks.)

- [ ] **Step 3: Build shared package to check for type errors**

Run: `cd packages/shared && npx tsc --noEmit`

Expected: PASS (no type errors in shared package itself). Downstream packages that construct `TaskResultSubmission` without `task_type` in source code (not tests) will be fixed in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts packages/daemon/lark-result/src/__tests__/lark-poller.test.ts packages/daemon/telegram-result/src/__tests__/telegram-notifier.test.ts packages/daemon/telegram-result/src/__tests__/telegram-poller.test.ts
git commit -m "feat(shared): add task_type to TaskResultSubmission type"
```

---

### Task 2: Attach `task_type` from job to result in task-poller

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts:40-44`
- Test: `packages/daemon/task/src/__tests__/task-poller.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe('pollOnce')` block in `packages/daemon/task/src/__tests__/task-poller.test.ts`:

```typescript
it('forwards task_type from job to result submission', async () => {
  const job = createJob({ task_type: 'deploy' });

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
  expect(resultPostBody.task_type).toBe('deploy');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon/task && npx vitest run src/__tests__/task-poller.test.ts`

Expected: FAIL — `resultPostBody.task_type` is undefined because `task-poller.ts` doesn't attach it yet.

- [ ] **Step 3: Implement — attach task_type to result**

In `packages/daemon/task/src/task-poller.ts`, change lines 40-44 from:

```typescript
const resultWithSource: TaskResultSubmission = {
  ...result,
  ...(job.task_source ? { task_source: job.task_source } : {}),
};
```

to:

```typescript
const resultWithSource: TaskResultSubmission = {
  ...result,
  task_type: job.task_type,
  ...(job.task_source ? { task_source: job.task_source } : {}),
};
```

Also add `task_type: 'generic'` to `mockResultSubmission` in the test file (line 22-29) so the mock satisfies the type:

```typescript
const mockResultSubmission: TaskResultSubmission = {
  job_id: 'job-456',
  task_id: 'abc-123',
  task_type: 'generic',
  status: 'success',
  exit_code: 0,
  stdout: 'result output',
  stderr: '',
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task && npx vitest run src/__tests__/task-poller.test.ts`

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/task-poller.ts packages/daemon/task/src/__tests__/task-poller.test.ts
git commit -m "feat(task-daemon): forward task_type from job to result submission"
```

---

### Task 3: Pass `task_type` through results route

**Files:**
- Modify: `packages/api/src/routes/results.ts:11,30-40`

- [ ] **Step 1: Update the results route to extract and pass through `task_type`**

In `packages/api/src/routes/results.ts`, change line 11 from:

```typescript
const { job_id, task_id, status, exit_code, stdout, stderr, task_source } = req.body;
```

to:

```typescript
const { job_id, task_id, status, exit_code, stdout, stderr, task_source, task_type } = req.body;
```

Add validation after the `task_source` validation (after line 27):

```typescript
if (task_type !== undefined && typeof task_type !== 'string') {
  res.status(400).json({ error: 'task_type must be a string if provided' });
  return;
}
```

Update the `result` object construction (line 30-40) to include `task_type`:

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
  ...(task_source ? { task_source } : {}),
};
```

- [ ] **Step 2: Build to check for type errors**

Run: `cd packages/api && npx tsc --noEmit`

Expected: PASS (no type errors)

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/results.ts
git commit -m "feat(api): pass task_type through results route"
```

---

### Task 4: Prepend `task_type:` line in lark-notifier

**Files:**
- Modify: `packages/daemon/lark-result/src/adapters/lark-notifier.ts:63-67`
- Test: `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('LarkNotifier')` block in `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`:

```typescript
it('includes task_type prefix line in reply text', async () => {
  mockFetch
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ code: 0 }),
    });

  await notifier.notify(createResult({ task_type: 'deploy' }));

  const sendCall = mockFetch.mock.calls[1];
  const body = JSON.parse(sendCall[1].body);
  const content = JSON.parse(body.content);
  expect(content.text).toMatch(/^task_type: deploy\n/);
});
```

Also update the `createResult` helper to include `task_type`:

```typescript
function createResult(overrides?: Partial<TaskResult>): TaskResult {
  return {
    result_id: 'res-1',
    job_id: 'job-456',
    task_id: 'task-123',
    task_type: 'generic',
    status: 'success',
    exit_code: 0,
    stdout: 'Task completed successfully',
    stderr: '',
    completed_at: '2026-03-27T00:00:00.000Z',
    ...overrides,
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts`

Expected: FAIL — text doesn't start with `task_type:` prefix.

- [ ] **Step 3: Implement — prepend task_type line**

In `packages/daemon/lark-result/src/adapters/lark-notifier.ts`, change lines 63-67 from:

```typescript
const text = [
  `Job ${result.job_id} (Task ${result.task_id}) — ${result.status}`,
  `Exit code: ${result.exit_code ?? 'N/A'}`,
  snippet ? `Output:\n${snippet}` : 'No output',
].join('\n');
```

to:

```typescript
const text = [
  `task_type: ${result.task_type}`,
  `Job ${result.job_id} (Task ${result.task_id}) — ${result.status}`,
  `Exit code: ${result.exit_code ?? 'N/A'}`,
  snippet ? `Output:\n${snippet}` : 'No output',
].join('\n');
```

- [ ] **Step 4: Run all lark-notifier tests to verify they pass**

Run: `cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts`

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-result/src/adapters/lark-notifier.ts packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts
git commit -m "feat(lark-result): prepend task_type line to bot reply text"
```

---

### Task 5: Add `getValidTaskTypes()` to EnrichmentService

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the end of `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`:

```typescript
describe('getValidTaskTypes', () => {
  it('returns set of all rule keys', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        code_review: {
          executors: [{ executor: 'claude_code', executor_model: 'opus' }],
        },
        deploy: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
        },
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
        },
      },
    });

    const types = service.getValidTaskTypes();

    expect(types).toEqual(new Set(['code_review', 'deploy', 'default']));
  });

  it('returns empty set when no rules', () => {
    const service = EnrichmentService.fromObject({ rules: {} });
    const types = service.getValidTaskTypes();
    expect(types).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts -t "getValidTaskTypes"`

Expected: FAIL — `getValidTaskTypes is not a function`.

- [ ] **Step 3: Implement — add method to EnrichmentService**

In `packages/daemon/task-enrichment/src/enrichment-service.ts`, add this method to the `EnrichmentService` class (after the `enrich` method, before the closing `}`):

```typescript
getValidTaskTypes(): Set<string> {
  return new Set(Object.keys(this.rules));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`

Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "feat(enrichment): add getValidTaskTypes method to EnrichmentService"
```

---

### Task 6: Refactor `ThreadContextFetcher` return type, add extraction and stripping

**Files:**
- Modify: `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`

This is the largest task. It changes the return type from `string | null` to `ThreadContextResult | null`, adds task_type extraction from bot messages, and strips `task_type:` lines from context.

- [ ] **Step 1: Write tests for task_type extraction and stripping**

Add the following `describe` blocks at the end of `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`:

```typescript
describe('task_type extraction from thread messages', () => {
  let fetcher: ThreadContextFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new ThreadContextFetcher(APP_ID, APP_SECRET);
  });

  it('extracts task_type from first bot message with valid tag', async () => {
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
            body: { content: JSON.stringify({ text: 'task_type: deploy\nJob abc — success' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'check status' }) },
          },
        ]),
      );

    const validTypes = new Set(['deploy', 'code_review', 'default']);
    const result = await fetcher.fetchThreadContext('om_new_msg', validTypes);

    expect(result).not.toBeNull();
    expect(result!.inheritedTaskType).toBe('deploy');
  });

  it('skips bot messages with invalid task_type and uses next valid one', async () => {
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
            message_id: 'om_bot1',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'task_type: nonexistent\nJob 1 — success' }) },
          },
          {
            message_id: 'om_bot2',
            sender: { sender_type: 'app' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'task_type: deploy\nJob 2 — success' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const validTypes = new Set(['deploy', 'default']);
    const result = await fetcher.fetchThreadContext('om_new_msg', validTypes);

    expect(result).not.toBeNull();
    expect(result!.inheritedTaskType).toBe('deploy');
  });

  it('returns null inheritedTaskType when no bot message has valid tag', async () => {
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

    const validTypes = new Set(['deploy', 'default']);
    const result = await fetcher.fetchThreadContext('om_new_msg', validTypes);

    expect(result).not.toBeNull();
    expect(result!.inheritedTaskType).toBeNull();
    expect(result!.threadContext).toBe('user: hello\nassistant: Job abc — success');
  });

  it('does not extract task_type when validTaskTypes is not provided', async () => {
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
            body: { content: JSON.stringify({ text: 'task_type: deploy\nJob abc — success' }) },
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
    expect(result!.inheritedTaskType).toBeNull();
  });

  it('ignores task_type tags in user messages', async () => {
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
            body: { content: JSON.stringify({ text: 'task_type: deploy' }) },
          },
          {
            message_id: 'om_new_msg',
            sender: { sender_type: 'user' },
            msg_type: 'text',
            body: { content: JSON.stringify({ text: 'follow up' }) },
          },
        ]),
      );

    const validTypes = new Set(['deploy', 'default']);
    const result = await fetcher.fetchThreadContext('om_new_msg', validTypes);

    expect(result).not.toBeNull();
    expect(result!.inheritedTaskType).toBeNull();
  });
});

describe('task_type line stripping from thread context', () => {
  let fetcher: ThreadContextFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new ThreadContextFetcher(APP_ID, APP_SECRET);
  });

  it('strips task_type line from bot message in thread context', async () => {
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
            body: { content: JSON.stringify({ text: 'task_type: deploy\nJob abc — success' }) },
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
    expect(result!.threadContext).not.toContain('task_type:');
  });

  it('strips task_type line even when validTaskTypes is not provided', async () => {
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
            body: { content: JSON.stringify({ text: 'task_type: deploy\nJob abc — success' }) },
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
    expect(result!.threadContext).not.toContain('task_type:');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts`

Expected: FAIL — `fetchThreadContext` returns `string | null`, not an object with `inheritedTaskType` / `threadContext`.

- [ ] **Step 3: Implement the changes to ThreadContextFetcher**

In `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`:

**A) Add the `ThreadContextResult` interface and `TASK_TYPE_REGEX` constant (after the imports, before the class):**

```typescript
const TASK_TYPE_REGEX = /^task_type: ([a-zA-Z0-9_-]+)$/m;

export interface ThreadContextResult {
  threadContext: string | null;
  inheritedTaskType: string | null;
}
```

**B) Change `fetchThreadContext` signature (line 26) from:**

```typescript
async fetchThreadContext(messageId: string): Promise<string | null> {
```

to:

```typescript
async fetchThreadContext(messageId: string, validTaskTypes?: Set<string>): Promise<ThreadContextResult | null> {
```

**C) Update the retry body (line 29) from:**

```typescript
return await this.doFetch(messageId);
```

to:

```typescript
return await this.doFetch(messageId, validTaskTypes);
```

**D) Change `doFetch` signature (line 41) from:**

```typescript
private async doFetch(messageId: string): Promise<string | null> {
```

to:

```typescript
private async doFetch(messageId: string, validTaskTypes?: Set<string>): Promise<ThreadContextResult | null> {
```

**E) Replace the formatting section (lines 54-67) with:**

```typescript
// Step 3: Extract task_type from first valid bot message
let inheritedTaskType: string | null = null;
if (validTaskTypes && validTaskTypes.size > 0) {
  for (const m of messages) {
    if (m.sender.sender_type === 'user') continue;
    const content = extractLarkMessageContent(m.msg_type, m.body.content);
    const match = content.match(TASK_TYPE_REGEX);
    if (match && validTaskTypes.has(match[1])) {
      inheritedTaskType = match[1];
      break;
    }
  }
}

// Step 4: Format, excluding the current message, stripping task_type lines
const filtered = messages.filter((m) => m.message_id !== messageId);

if (filtered.length === 0) {
  return { threadContext: null, inheritedTaskType };
}

const threadContext = filtered
  .map((m) => {
    const role = m.sender.sender_type === 'user' ? 'user' : 'assistant';
    let content = extractLarkMessageContent(m.msg_type, m.body.content);
    content = content.replace(/^task_type: [a-zA-Z0-9_-]+\n?/m, '');
    return `${role}: ${content}`;
  })
  .join('\n');

return { threadContext: threadContext || null, inheritedTaskType };
```

- [ ] **Step 4: Update existing tests for new return type**

The existing tests in `thread-context-fetcher.test.ts` expect `string | null` returns. Update them to match the new `ThreadContextResult | null` shape.

For tests that expect `null` (no thread found), keep `expect(result).toBeNull()` — these remain correct.

For tests that expect a string, change like this:

- `expect(result).toBe('user: fix the CI pipeline\nassistant: Job abc — success')` → `expect(result!.threadContext).toBe('user: fix the CI pipeline\nassistant: Job abc — success')`
- `expect(result).toBe('user: original question')` → `expect(result!.threadContext).toBe('user: original question')`
- `expect(result).not.toContain('follow up')` → `expect(result!.threadContext).not.toContain('follow up')`
- `expect(result).toBe('assistant: bot message')` → `expect(result!.threadContext).toBe('assistant: bot message')`
- `expect(result).toBe('user: page 1 message\nassistant: page 2 message')` → `expect(result!.threadContext).toBe('user: page 1 message\nassistant: page 2 message')`
- `expect(result).toBe('user: [Image: img_v3_abc]')` → `expect(result!.threadContext).toBe('user: [Image: img_v3_abc]')`

- [ ] **Step 5: Run all thread-context-fetcher tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts`

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts
git commit -m "feat(enrichment): extract task_type from thread messages and strip from context"
```

---

### Task 7: Update enrichment-poller to use new return type and apply inherited task_type

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts:34-39`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write tests for task_type inheritance**

Add to the existing `describe('EnrichmentPoller with ThreadContextFetcher')` block in `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`.

First, update the mock setup. The `EnrichmentService` mock needs `getValidTaskTypes`. Change the `vi.mock` block (lines 8-12) from:

```typescript
vi.mock('../enrichment-service', () => ({
  EnrichmentService: vi.fn().mockImplementation(() => ({
    enrich: mockEnrich,
  })),
}));
```

to:

```typescript
const mockGetValidTaskTypes = vi.fn().mockReturnValue(new Set(['deploy', 'code_review', 'default']));

vi.mock('../enrichment-service', () => ({
  EnrichmentService: vi.fn().mockImplementation(() => ({
    enrich: mockEnrich,
    getValidTaskTypes: mockGetValidTaskTypes,
  })),
}));
```

Add `mockGetValidTaskTypes.mockClear()` to the `beforeEach` blocks (or add to the existing `vi.clearAllMocks()` which handles it).

Then add these tests inside the `describe('EnrichmentPoller with ThreadContextFetcher')` block:

```typescript
it('overrides task_type to inherited value when current is generic', async () => {
  const task = createTask({
    task_type: 'generic',
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'follow up',
  });
  const jobSubmission = createJobSubmission({
    task_type: 'deploy',
    payload: '--- Thread Context ---\nuser: deploy the app\nassistant: Job abc — success\n--- Current Message ---\nfollow up',
  });
  mockEnrich.mockReturnValue(jobSubmission);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: deploy the app\nassistant: Job abc — success',
    inheritedTaskType: 'deploy',
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({ task_type: 'deploy' }),
  );
});

it('does not override task_type when current is not generic', async () => {
  const task = createTask({
    task_type: 'code_review',
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'review this',
  });
  const jobSubmission = createJobSubmission({ task_type: 'code_review' });
  mockEnrich.mockReturnValue(jobSubmission);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: review code\nassistant: Job abc — success',
    inheritedTaskType: 'deploy',
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({ task_type: 'code_review' }),
  );
});

it('keeps generic task_type when no inherited type found', async () => {
  const task = createTask({
    task_type: 'generic',
    task_source: { source: 'lark', message_id: 'om_msg1' },
    payload: 'hello',
  });
  const jobSubmission = createJobSubmission({ task_type: 'generic' });
  mockEnrich.mockReturnValue(jobSubmission);
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'user: hello\nassistant: Job abc — success',
    inheritedTaskType: null,
  });

  mockFetch
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(task) })
    .mockResolvedValueOnce({ status: 201, json: () => Promise.resolve({ job_id: 'job-1', ...jobSubmission }) })
    .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({ acknowledged: true }) });

  await poller.pollOnce();

  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({ task_type: 'generic' }),
  );
});
```

- [ ] **Step 2: Update existing thread context tests for new return shape**

The existing tests in the `describe('EnrichmentPoller with ThreadContextFetcher')` block mock `fetchThreadContext` returning a string. Update them:

- `mockThreadFetcher.fetchThreadContext.mockResolvedValue('user: fix CI')` → `mockThreadFetcher.fetchThreadContext.mockResolvedValue({ threadContext: 'user: fix CI', inheritedTaskType: null })`
- `mockThreadFetcher.fetchThreadContext.mockResolvedValue(null)` — keep as-is (null means no thread found)

Also update the assertion checking the call arguments. Line 176 currently checks:

```typescript
expect(mockThreadFetcher.fetchThreadContext).toHaveBeenCalledWith('om_msg1');
```

Change to:

```typescript
expect(mockThreadFetcher.fetchThreadContext).toHaveBeenCalledWith('om_msg1', expect.any(Set));
```

- [ ] **Step 3: Run tests to verify new tests fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`

Expected: New tests FAIL because `enrichment-poller.ts` still treats the return as `string | null`.

- [ ] **Step 4: Implement — update enrichment-poller**

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`, replace lines 34-39:

```typescript
if (this.threadContextFetcher && task.task_source?.source === 'lark') {
  const threadContext = await this.threadContextFetcher.fetchThreadContext(task.task_source.message_id);
  if (threadContext) {
    task.payload = `--- Thread Context ---\n${threadContext}\n--- Current Message ---\n${task.payload}`;
    logger.info({ task_id: task.task_id }, 'Prepended thread context to payload');
  }
}
```

with:

```typescript
if (this.threadContextFetcher && task.task_source?.source === 'lark') {
  const validTaskTypes = this.enrichmentService.getValidTaskTypes();
  const threadResult = await this.threadContextFetcher.fetchThreadContext(task.task_source.message_id, validTaskTypes);
  if (threadResult) {
    if (task.task_type === 'generic' && threadResult.inheritedTaskType) {
      task.task_type = threadResult.inheritedTaskType;
      logger.info({ task_id: task.task_id, inherited_task_type: threadResult.inheritedTaskType }, 'Inherited task_type from thread root');
    }
    if (threadResult.threadContext) {
      task.payload = `--- Thread Context ---\n${threadResult.threadContext}\n--- Current Message ---\n${task.payload}`;
      logger.info({ task_id: task.task_id }, 'Prepended thread context to payload');
    }
  }
}
```

Note: `this.enrichmentService` is a private field. You need to check whether `enrichmentService` is accessible. Looking at the constructor (line 12), it is `private readonly enrichmentService: EnrichmentService`. This is fine — it's used within the same class.

- [ ] **Step 5: Run all enrichment-poller tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`

Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): inherit task_type from thread root bot response"
```

---

### Task 8: Run full test suite

**Files:** None (verification only)

- [ ] **Step 1: Run all tests across the monorepo**

Run: `cd /Users/bytedance/.ows/workspaces/personal_productivity/LocalAgent && npx rush test`

If `rush test` is not configured, run tests per-package:

```bash
cd packages/shared && npx vitest run && \
cd ../daemon/task && npx vitest run && \
cd ../task-enrichment && npx vitest run && \
cd ../lark-result && npx vitest run && \
cd ../telegram-result && npx vitest run && \
cd ../../api && npx vitest run
```

Expected: ALL PASS

- [ ] **Step 2: Fix any type errors or failures found**

If any test fails, fix it before proceeding.

- [ ] **Step 3: Final commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: resolve test failures from task_type thread inheritance"
```
