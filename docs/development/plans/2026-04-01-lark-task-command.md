# Lark `/task` Command Implementation Plan

**Goal:** Allow Lark users to submit tasks with specific types via `/task <type> <payload>`, routed through type-specific enrichment rules, with unknown types rejected via the result pipeline.

**Architecture:** Parse `/task` prefix in `MessageHandler`, pass `task_type` through `TaskSubmitter`, remove the default fallback in `EnrichmentService` (replace with rejection result), have `EnrichmentPoller` publish failed `TaskResultSubmission` for unknown types, and add a `LarkReplier` adapter for local usage-hint replies.

**Tech Stack:** TypeScript, vitest, Lark API (reply endpoint), existing result pipeline

---

### Task 1: Update `EnrichmentService` to Return Rejection Instead of Null

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts:1-106`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Write failing tests for rejection behavior**

Add to `enrichment-service.test.ts` — a new `describe('rejection for unknown types')` block:

```typescript
describe('rejection for unknown types (no default fallback)', () => {
  let service: EnrichmentService;

  beforeEach(() => {
    service = EnrichmentService.fromObject({
      rules: {
        generic: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
        },
        code_review: {
          executors: [{ executor: 'claude_code', executor_model: 'opus' }],
        },
      },
    });
  });

  it('returns rejected result for unknown task_type', () => {
    const result = service.enrich(createTask({ task_type: 'nonexistent' }));

    expect(result).toEqual({
      type: 'rejected',
      reason: expect.stringContaining('Unknown task type "nonexistent"'),
    });
  });

  it('includes valid types in rejection reason', () => {
    const result = service.enrich(createTask({ task_type: 'nonexistent' }));

    expect(result).toHaveProperty('type', 'rejected');
    expect((result as any).reason).toContain('generic');
    expect((result as any).reason).toContain('code_review');
  });

  it('returns enriched result for known task_type', () => {
    const result = service.enrich(createTask({ task_type: 'generic' }));

    expect(result).toHaveProperty('type', 'enriched');
    expect((result as any).job.executors).toEqual([
      { executor: 'claude_code', executor_model: 'sonnet' },
    ]);
  });
});

describe('getValidTypes', () => {
  it('returns all rule keys', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        generic: { executors: [{ executor: 'claude_code', executor_model: 'sonnet' }] },
        code_review: { executors: [{ executor: 'claude_code', executor_model: 'opus' }] },
      },
    });

    expect(service.getValidTypes()).toEqual(expect.arrayContaining(['generic', 'code_review']));
    expect(service.getValidTypes()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: FAIL — `enrich` returns `null` (not rejection object), `getValidTypes` doesn't exist.

- [ ] **Step 3: Define `EnrichmentResult` type and update `enrich()` return type**

In `enrichment-service.ts`, add the type and update the method:

```typescript
import { Task, JobSubmission, isTaskExecutorType, isValidExecutorModel, TaskExecutorType, ExecutorPreference, createLogger } from '@local-agent/shared';

// ... existing EnrichmentRule and EnrichmentConfig interfaces ...

export type EnrichmentResult =
  | { type: 'enriched'; job: JobSubmission }
  | { type: 'rejected'; reason: string };
```

Update the `enrich` method:

```typescript
  enrich(task: Task): EnrichmentResult {
    const rule = this.rules[task.task_type];

    if (!rule) {
      const validTypes = this.getValidTypes().join(', ');
      return {
        type: 'rejected',
        reason: `Unknown task type "${task.task_type}". Available types: ${validTypes}`,
      };
    }

    if (!rule.executors || rule.executors.length === 0) {
      logger.error({ task_id: task.task_id, task_type: task.task_type }, 'Enrichment rule has empty executors array — rejecting task');
      return {
        type: 'rejected',
        reason: `Task type "${task.task_type}" has invalid configuration (empty executors).`,
      };
    }

    const executors: ExecutorPreference[] = [];
    for (const entry of rule.executors) {
      if (!isTaskExecutorType(entry.executor)) {
        logger.error({ task_id: task.task_id, executor: entry.executor }, 'Invalid executor in enrichment rule — rejecting task');
        return {
          type: 'rejected',
          reason: `Task type "${task.task_type}" has invalid configuration (bad executor).`,
        };
      }
      if (!isValidExecutorModel(entry.executor as TaskExecutorType, entry.executor_model)) {
        logger.error({ task_id: task.task_id, executor: entry.executor, model: entry.executor_model }, 'Invalid executor_model in enrichment rule — rejecting task');
        return {
          type: 'rejected',
          reason: `Task type "${task.task_type}" has invalid configuration (bad executor model).`,
        };
      }
      executors.push({ executor: entry.executor as TaskExecutorType, executor_model: entry.executor_model });
    }

    const systemPrompt = rule.system_prompt?.trim() || undefined;

    return {
      type: 'enriched',
      job: {
        task_id: task.task_id,
        task_type: task.task_type,
        payload: task.payload,
        executors,
        submitted_at: task.submitted_at,
        ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
        marketplaces: rule.marketplaces,
        ...(task.task_source ? { task_source: task.task_source } : {}),
        ...(rule.setup_hook !== undefined ? { setup_hook: rule.setup_hook } : {}),
        ...(rule.setup_hook_timeout_ms !== undefined ? { setup_hook_timeout_ms: rule.setup_hook_timeout_ms } : {}),
      },
    };
  }

  getValidTypes(): string[] {
    return Object.keys(this.rules);
  }
```

- [ ] **Step 4: Update all existing tests to use new return type**

All existing tests that check `service.enrich()` return values need updating. Where they previously checked `result` directly (e.g., `result!.executors`), they now need to check `result.type === 'enriched'` and access `result.job.executors`. Where they checked `result === null`, they now check `result.type === 'rejected'`.

Pattern for enriched results — change:
```typescript
// Before:
const result = service.enrich(createTask());
expect(result).not.toBeNull();
expect(result!.executors).toEqual([...]);

// After:
const result = service.enrich(createTask());
expect(result.type).toBe('enriched');
expect((result as { type: 'enriched'; job: JobSubmission }).job.executors).toEqual([...]);
```

Pattern for rejected results — change:
```typescript
// Before:
const result = service.enrich(createTask({ task_type: 'bad_rule' }));
expect(result).toBeNull();

// After:
const result = service.enrich(createTask({ task_type: 'bad_rule' }));
expect(result.type).toBe('rejected');
```

The `'falls back to default for unknown task_type'` test must be removed — there is no longer a default fallback.

**Important:** Many existing test blocks use `rules: { default: { ... } }` and then call `enrich(createTask({ task_type: 'anything' }))`, relying on the old `default` fallback to match. With the fallback removed, `task_type: 'anything'` no longer matches `rules.default` — it will be rejected. These tests must be updated to use a task_type that matches the rule key. Specifically:

- **"marketplace passthrough" block:** The `'omits marketplaces when rule has none'` test uses `rules.default` with `task_type: 'anything'` — change to `task_type: 'default'` (to match the key directly) or rename the rule to something else and use a matching task_type.
- **"task_source passthrough" block:** Uses `rules.default` with `task_type: 'anything'` in the `beforeEach` — change `task_type` to `'default'` in the `createTask` calls.
- **"setup_hook passthrough" block:** Three tests use `rules.default` with `task_type: 'anything'` — change `task_type` to `'default'`.
- **"system_prompt passthrough" block:** Four tests use `rules.default` with `task_type: 'anything'` — change `task_type` to `'default'`.
- **"fromDirectory" block:** The `'loads and merges rules from multiple YAML files'` test calls `enrich(createTask({ task_type: 'unknown' }))` expecting it to fall back to `default` — change to `task_type: 'default'`. The `'loads .yml files'` and `'ignores non-YAML files'` tests similarly use `task_type: 'anything'` — change to `task_type: 'default'`.

The simplest pattern: wherever the test defines a rule named `default` and expects a non-matching `task_type` to hit it via fallback, change the `task_type` in the `createTask` call to `'default'` so it matches directly.

The `fromFile` test that tests the actual `enrichment.yaml` file will also need updating after Task 6 renames `default` to `generic`.

- [ ] **Step 5: Run all enrichment-service tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "feat(enrichment): return EnrichmentResult with rejection for unknown task types"
```

---

### Task 2: Update `EnrichmentPoller` to Handle Rejections

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts:1-104`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing test for rejection → result publishing**

Add to `enrichment-poller.test.ts`:

```typescript
it('publishes failed result and acks task when enrichment rejects', async () => {
  const task = createTask({
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });
  mockEnrich.mockReturnValue({
    type: 'rejected',
    reason: 'Unknown task type "bad". Available types: generic, code_review',
  });

  mockFetch
    .mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve(task),
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

  // Verify POST /results with failure
  expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://localhost:3000/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: 'task-123',
      task_id: 'task-123',
      status: 'failure',
      exit_code: null,
      stdout: 'Unknown task type "bad". Available types: generic, code_review',
      stderr: '',
      task_source: { source: 'lark', message_id: 'om_msg1' },
    }),
  });
  // Verify task is acked
  expect(mockFetch).toHaveBeenNthCalledWith(3, 'http://localhost:3000/tasks/task-123/ack', {
    method: 'POST',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: FAIL — current code treats `null` returns, not rejection objects.

- [ ] **Step 3: Update `EnrichmentPoller.pollOnce()` to handle `EnrichmentResult`**

In `enrichment-poller.ts`, import the new type and update the enrichment handling:

```typescript
import { Task, createLogger } from '@local-agent/shared';
import { EnrichmentService, type EnrichmentResult } from './enrichment-service';
import type { ThreadContextFetcher } from './adapters/thread-context-fetcher';
```

Replace the enrichment result handling in `pollOnce()`:

```typescript
      const enrichmentResult = this.enrichmentService.enrich(task);

      if (enrichmentResult.type === 'rejected') {
        logger.warn({ task_id: task.task_id, task_type: task.task_type, reason: enrichmentResult.reason }, 'Enrichment rejected task');
        await this.publishRejection(task, enrichmentResult.reason);
        await this.ackTask(task.task_id);
        return;
      }

      const jobSubmission = enrichmentResult.job;
```

Add the `publishRejection` method:

```typescript
  private async publishRejection(task: Task, reason: string): Promise<void> {
    try {
      const body = {
        job_id: task.task_id,
        task_id: task.task_id,
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
```

- [ ] **Step 4: Update existing enrichment-poller tests for new return type**

The existing tests that mock `mockEnrich` need to return the new `EnrichmentResult` format:

```typescript
// Before:
mockEnrich.mockReturnValue(jobSubmission);
// After:
mockEnrich.mockReturnValue({ type: 'enriched', job: jobSubmission });

// Before (null case):
mockEnrich.mockReturnValue(null);
// After:
mockEnrich.mockReturnValue({ type: 'rejected', reason: 'No rule found' });
```

Also update the mock setup to include `getValidTypes`:

```typescript
vi.mock('../enrichment-service', () => ({
  EnrichmentService: vi.fn().mockImplementation(() => ({
    enrich: mockEnrich,
    getValidTypes: vi.fn().mockReturnValue(['generic']),
  })),
}));
```

The test `'acks task and does not post job when enrichment fails (returns null)'` should be updated to verify that a rejection result is published (3 fetch calls: get task, post result, ack task) instead of just acking.

- [ ] **Step 5: Run all enrichment-poller tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): publish failed result for rejected task types"
```

---

### Task 3: Add `LarkReplier` Adapter to lark-listener

**Files:**
- Create: `packages/daemon/lark-listener/src/adapters/lark-replier.ts`
- Create: `packages/daemon/lark-listener/src/__tests__/lark-replier.test.ts`

- [ ] **Step 1: Write failing test for `LarkReplier`**

Create `packages/daemon/lark-listener/src/__tests__/lark-replier.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { LarkReplier } from '../adapters/lark-replier';

describe('LarkReplier', () => {
  let replier: LarkReplier;

  beforeEach(() => {
    vi.clearAllMocks();
    replier = new LarkReplier('app-id', 'app-secret');
  });

  it('fetches tenant token and replies in thread', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 0 }),
      });

    await replier.reply('om_msg123', 'Usage: /task <type> <payload>');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://open.larksuite.com/open-apis/im/v1/messages/om_msg123/reply',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer token-abc',
        }),
        body: JSON.stringify({
          msg_type: 'text',
          content: JSON.stringify({ text: 'Usage: /task <type> <payload>' }),
          reply_in_thread: true,
        }),
      }),
    );
  });

  it('does not throw on token fetch failure (best-effort)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    await expect(replier.reply('om_msg123', 'hello')).resolves.toBeUndefined();
  });

  it('does not throw on reply API failure (best-effort)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ code: 99 }),
      });

    await expect(replier.reply('om_msg123', 'hello')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/lark-replier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `LarkReplier`**

Create `packages/daemon/lark-listener/src/adapters/lark-replier.ts`:

```typescript
import { createLogger } from '@local-agent/shared';
import { LARK_TOKEN_URL, LARK_REACTION_URL_PREFIX } from '../constants';

const logger = createLogger('lark-listener:replier');

export class LarkReplier {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  /**
   * Reply to a message in-thread. Best-effort — errors are logged and swallowed.
   */
  async reply(messageId: string, text: string): Promise<void> {
    try {
      const token = await this.fetchTenantToken();

      const res = await fetch(`${LARK_REACTION_URL_PREFIX}/${messageId}/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: JSON.stringify({ text }),
          reply_in_thread: true,
        }),
      });

      const data = (await res.json()) as { code: number; msg?: string };
      if (data.code !== 0) {
        logger.warn({ messageId, code: data.code, msg: data.msg }, 'Reply API returned non-zero code');
      }
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to reply (best-effort)');
    }
  }

  private async fetchTenantToken(): Promise<string> {
    const res = await fetch(LARK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });

    if (!res.ok) {
      throw new Error(`Lark token request failed with HTTP status ${res.status}`);
    }

    const data = (await res.json()) as { tenant_access_token: string; code: number };
    if (data.code !== 0) {
      throw new Error(`Lark token request failed with code ${data.code}`);
    }
    return data.tenant_access_token;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/lark-replier.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/adapters/lark-replier.ts packages/daemon/lark-listener/src/__tests__/lark-replier.test.ts
git commit -m "feat(lark-listener): add LarkReplier adapter for in-thread text replies"
```

---

### Task 4: Update `TaskSubmitter` to Accept `task_type` Parameter

**Files:**
- Modify: `packages/daemon/lark-listener/src/adapters/task-submitter.ts:1-46`
- Test: `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts`

- [ ] **Step 1: Write failing test for `task_type` parameter**

Add to `task-submitter.test.ts`:

```typescript
it('sends the provided task_type in the request body', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 201,
    json: () => Promise.resolve({ task_id: 'task-abc' }),
  });

  await submitter.submit('code_review', 'review this code');

  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body.task_type).toBe('code_review');
  expect(body.payload).toBe('review this code');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/task-submitter.test.ts`
Expected: FAIL — `submit` only takes 2 args (payload, taskSource).

- [ ] **Step 3: Update `TaskSubmitter.submit()` to accept `taskType`**

In `task-submitter.ts`, change the signature:

```typescript
  async submit(taskType: string, payload: string, taskSource?: TaskSource): Promise<string | null> {
    const body: TaskSubmission = { task_type: taskType, payload, task_source: taskSource };
```

- [ ] **Step 4: Update existing task-submitter tests for new signature**

All existing calls to `submitter.submit('hello')` become `submitter.submit('generic', 'hello')`. Calls with task source like `submitter.submit('hello', taskSource)` become `submitter.submit('generic', 'hello', taskSource)`.

- [ ] **Step 5: Run all task-submitter tests**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/task-submitter.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/lark-listener/src/adapters/task-submitter.ts packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts
git commit -m "feat(lark-listener): accept task_type parameter in TaskSubmitter.submit()"
```

---

### Task 5: Update `MessageHandler` to Parse `/task` Commands

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts:1-94`
- Test: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`

- [ ] **Step 1: Write failing tests for `/task` command parsing**

Add to `message-handler.test.ts`. The `MessageHandler` constructor will now also require a `LarkReplier` mock:

```typescript
import type { LarkReplier } from '../adapters/lark-replier';

// In beforeEach, add:
let replier: { reply: ReturnType<typeof vi.fn> };

beforeEach(() => {
  submitter = { submit: vi.fn().mockResolvedValue('task-abc') };
  reactor = { react: vi.fn().mockResolvedValue(undefined) };
  replier = { reply: vi.fn().mockResolvedValue(undefined) };
  dedup = { has: vi.fn().mockReturnValue(false), add: vi.fn() };
  handler = new MessageHandler(
    submitter as unknown as TaskSubmitter,
    reactor as unknown as LarkReactor,
    replier as unknown as LarkReplier,
    dedup as unknown as DedupMap,
  );
});
```

New tests:

```typescript
describe('/task command parsing', () => {
  it('parses /task <type> <payload> and submits with correct task_type', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/task code_review fix the login bug' }),
    }));

    expect(submitter.submit).toHaveBeenCalledWith(
      'code_review',
      'fix the login bug',
      { source: 'lark', message_id: 'om_msg1' },
    );
    expect(reactor.react).toHaveBeenCalledWith('om_msg1');
  });

  it('parses /task <type> with no payload (empty payload)', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/task code_review' }),
    }));

    expect(submitter.submit).toHaveBeenCalledWith(
      'code_review',
      '',
      { source: 'lark', message_id: 'om_msg1' },
    );
  });

  it('preserves multiline payload', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/task review fix this\nand that too' }),
    }));

    expect(submitter.submit).toHaveBeenCalledWith(
      'review',
      'fix this\nand that too',
      { source: 'lark', message_id: 'om_msg1' },
    );
  });

  it('replies with usage hint for bare /task and does not submit', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/task' }),
    }));

    expect(submitter.submit).not.toHaveBeenCalled();
    expect(reactor.react).not.toHaveBeenCalled();
    expect(replier.reply).toHaveBeenCalledWith(
      'om_msg1',
      'Usage: /task <type> <payload>',
    );
  });

  it('replies with usage hint for /task with only whitespace after', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/task   ' }),
    }));

    expect(submitter.submit).not.toHaveBeenCalled();
    expect(replier.reply).toHaveBeenCalledWith(
      'om_msg1',
      'Usage: /task <type> <payload>',
    );
  });

  it('submits plain messages as task_type generic (no /task prefix)', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: 'just a regular message' }),
    }));

    expect(submitter.submit).toHaveBeenCalledWith(
      'generic',
      'just a regular message',
      { source: 'lark', message_id: 'om_msg1' },
    );
  });

  it('does not treat /taskforce as a /task command (must have word boundary)', async () => {
    await handler.handle(makeEvent({
      content: JSON.stringify({ text: '/taskforce deploy' }),
    }));

    expect(submitter.submit).toHaveBeenCalledWith(
      'generic',
      '/taskforce deploy',
      { source: 'lark', message_id: 'om_msg1' },
    );
    expect(replier.reply).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: FAIL — constructor doesn't accept `LarkReplier`, submit doesn't accept `taskType`.

- [ ] **Step 3: Update `MessageHandler` to parse `/task` and accept `LarkReplier`**

In `message-handler.ts`:

```typescript
import { createLogger, type TaskSource, extractLarkMessageContent } from '@local-agent/shared';
import type { TaskSubmitter } from './adapters/task-submitter';
import type { LarkReactor } from './adapters/lark-reactor';
import type { LarkReplier } from './adapters/lark-replier';
import type { DedupMap } from './services/dedup';

const logger = createLogger('lark-listener:handler');

// ... LarkMessageEvent interface unchanged ...

export class MessageHandler {
  constructor(
    private readonly submitter: TaskSubmitter,
    private readonly reactor: LarkReactor,
    private readonly replier: LarkReplier,
    private readonly dedup: DedupMap,
  ) {}

  async handle(event: LarkMessageEvent): Promise<void> {
    const { message } = event;
    const { message_id, message_type } = message;

    if (this.dedup.has(message_id)) {
      logger.debug({ message_id }, 'Duplicate message, skipping');
      return;
    }

    this.dedup.add(message_id);

    const payload = this.buildPayload(message_type, message.content);

    logger.info(
      { message_id, message_type, chat_type: message.chat_type, sender: event.sender.sender_id.open_id },
      'Processing message',
    );

    const { taskType, taskPayload, isCommand } = this.parseCommand(payload);

    if (isCommand && taskType === null) {
      // Bare /task with no arguments — reply with usage hint
      await this.replier.reply(message_id, 'Usage: /task <type> <payload>');
      return;
    }

    const taskSource: TaskSource = { source: 'lark' as const, message_id: message.message_id };
    const taskId = await this.submitter.submit(taskType ?? 'generic', taskPayload, taskSource);

    if (taskId) {
      logger.info({ message_id, task_id: taskId, task_type: taskType }, 'Task enqueued');
    } else {
      logger.error({ message_id }, 'Failed to enqueue task');
    }

    await this.reactor.react(message_id);
  }

  private parseCommand(payload: string): { taskType: string | null; taskPayload: string; isCommand: boolean } {
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

  // ... buildPayload, extractText, buildStructuredPayload unchanged ...
}
```

- [ ] **Step 4: Update existing message-handler tests for new constructor**

All existing tests need to pass `replier` as the third argument to the `MessageHandler` constructor. Also, `submitter.submit` calls now have `taskType` as the first argument.

Update `beforeEach`:
```typescript
replier = { reply: vi.fn().mockResolvedValue(undefined) };
handler = new MessageHandler(
  submitter as unknown as TaskSubmitter,
  reactor as unknown as LarkReactor,
  replier as unknown as LarkReplier,
  dedup as unknown as DedupMap,
);
```

Update existing assertion for the first test:
```typescript
// Before:
expect(submitter.submit).toHaveBeenCalledWith(
  'fix the CI pipeline',
  { source: 'lark', message_id: 'om_msg1' },
);

// After:
expect(submitter.submit).toHaveBeenCalledWith(
  'generic',
  'fix the CI pipeline',
  { source: 'lark', message_id: 'om_msg1' },
);
```

**Important:** Several tests (image, file, post, sticker, malformed content) access submit args by index like `submitter.submit.mock.calls[0][0]` (payload) and `[0][1]` (taskSource). With the new signature, the indexes shift: `[0][0]` is now `taskType`, `[0][1]` is `payload`, `[0][2]` is `taskSource`. Update all index-based accesses accordingly:
```typescript
// Before:
const payload = submitter.submit.mock.calls[0][0];
const taskSource = submitter.submit.mock.calls[0][1];
// After:
const payload = submitter.submit.mock.calls[0][1];
const taskSource = submitter.submit.mock.calls[0][2];
```

- [ ] **Step 5: Run all message-handler tests**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts
git commit -m "feat(lark-listener): parse /task command and route task_type to submitter"
```

---

### Task 6: Update lark-listener Wiring and Enrichment YAML Config

**Files:**
- Modify: `packages/daemon/lark-listener/src/index.ts`
- Modify: `packages/daemon/task-enrichment/config/enrichment.yaml`

- [ ] **Step 1: Read lark-listener `index.ts` to understand wiring**

Read: `packages/daemon/lark-listener/src/index.ts`

- [ ] **Step 2: Update `index.ts` to create and inject `LarkReplier`**

The `MessageHandler` constructor now requires a `LarkReplier`. Add it alongside the existing `LarkReactor`:

```typescript
import { LarkReplier } from './adapters/lark-replier';

// In main(), after creating LarkReactor:
const replier = new LarkReplier(config.appId, config.appSecret);
const handler = new MessageHandler(submitter, reactor, replier, dedup);
```

- [ ] **Step 3: Update enrichment YAML — rename `default` to `generic`**

Replace `packages/daemon/task-enrichment/config/enrichment.yaml` with:

```yaml
rules:
  # Default type for plain messages (no /task prefix)
  generic:
    executors:
      - executor: claude_code
        executor_model: sonnet
```

- [ ] **Step 4: Update `fromFile` test that references the actual YAML**

In `enrichment-service.test.ts`, the `fromFile` test currently does:
```typescript
const result = service.enrich(createTask({ task_type: 'anything' }));
```
This used to hit the `default` fallback. Now `task_type: 'anything'` won't match `generic`. Change to:
```typescript
const result = service.enrich(createTask({ task_type: 'generic' }));
```

- [ ] **Step 5: Run all tests across both packages**

Run: `cd packages/daemon/task-enrichment && npx vitest run && cd ../../daemon/lark-listener && npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/lark-listener/src/index.ts packages/daemon/task-enrichment/config/enrichment.yaml packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "feat: wire LarkReplier into lark-listener, rename default rule to generic"
```

---

### Task 7: Full Integration Verification

**Files:**
- No new files

- [ ] **Step 1: Run all tests across the monorepo**

Run from the project root:
```bash
npx rush test
```
Or if rush isn't available:
```bash
cd packages/shared && npx vitest run && cd ../api && npx vitest run && cd ../daemon/lark-listener && npx vitest run && cd ../task-enrichment && npx vitest run && cd ../task && npx vitest run
```
Expected: ALL PASS

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npx rush build` (or `cd packages/shared && npx tsc --noEmit && cd ../daemon/lark-listener && npx tsc --noEmit && cd ../task-enrichment && npx tsc --noEmit`)
Expected: No type errors

- [ ] **Step 3: Commit (if any fix-ups needed)**

Only if fixes were needed in steps 1-2.
