# Lark Thread Natural-Language Continuation Implementation Plan

**Goal:** Make Lark thread replies continue the current conversation with natural language, while keeping root messages on the explicit `/task <type> <executor> <model> <payload>` contract.

**Architecture:** Keep `lark-listener` syntax-only: it forwards explicit `/task` commands, thread control commands, and continuation candidates without deciding whether the message is root or threaded. `ThreadContextFetcher` and `EnrichmentPoller` own all thread-membership and inherited-state decisions, rewriting `thread_reply` placeholder tasks into fully routed work when metadata is present and rejecting invalid root/thread usage otherwise.

**Tech Stack:** TypeScript, Vitest, Express, Lark API integration, Rush monorepo

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/shared/src/types.ts` | Add internal `thread_reply` task marker if shared constants are used |
| Modify | `packages/shared/src/routing-errors.ts` | Add root/thread-specific usage and rejection text helpers |
| Modify | `packages/shared/src/__tests__/routing-errors.test.ts` | Cover new thread-only and thread-reply help messages |
| Modify | `packages/daemon/lark-listener/src/message-handler.ts` | Normalize continuation candidates and submit `thread_reply` placeholders without thread checks |
| Modify | `packages/daemon/lark-listener/src/adapters/task-submitter.ts` | No semantic change expected; adjust only if submit signature or helper names change |
| Modify | `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Cover continuation submission and local malformed-command rejection |
| Modify | `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Return explicit `not_thread` / `thread` / `error` lookup results |
| Modify | `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts` | Cover tri-state lookup behavior |
| Modify | `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Rewrite `thread_reply` tasks from inherited metadata and reject lookup/metadata failures |
| Modify | `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Cover successful continuation, root rejection, and incomplete metadata rejection |
| Modify | `docs/development/design/2026-04-02-task-explicit-routing-contract-design.md` | Add note pointing to the newer thread continuation refinement |
| Modify | `docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md` | Add note that `/new` is now thread-only in Lark |

---

### Task 1: Add Shared Error Text for Root vs Thread Guidance

**Files:**
- Modify: `packages/shared/src/routing-errors.ts`
- Test: `packages/shared/src/__tests__/routing-errors.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests in `packages/shared/src/__tests__/routing-errors.test.ts` for helper output like:

```ts
it('formats thread reply guidance', () => {
  expect(formatThreadReplyHelpMessage()).toBe(
    'Thread replies must be natural language, /new, or /end.',
  );
});

it('formats threaded /task rejection guidance', () => {
  expect(formatThreadTaskCommandRejectedMessage()).toBe(
    'Cannot use /task in a thread. Reply with natural language, /new, or /end.\nUse /task only as a new root message.',
  );
});

it('formats root /new thread-only guidance', () => {
  expect(formatThreadOnlyCommandMessage('/new')).toBe(
    'The /new command can only be used inside a thread.',
  );
});
```

- [ ] **Step 2: Run the shared tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/__tests__/routing-errors.test.ts`

Expected: FAIL because the new helpers do not exist yet.

- [ ] **Step 3: Implement the new shared helpers**

In `packages/shared/src/routing-errors.ts`, add small string helpers for:

- thread reply guidance
- threaded `/task` rejection
- thread-only command rejection for `/new` and `/end`

Keep them as plain exported functions so both listener and enrichment can reuse the same copy.

- [ ] **Step 4: Re-run the shared tests**

Run: `cd packages/shared && npx vitest run src/__tests__/routing-errors.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/routing-errors.ts packages/shared/src/__tests__/routing-errors.test.ts
git commit -m "feat(shared): add thread continuation routing messages"
```

---

### Task 2: Teach the Listener to Submit Continuation Candidates Without Thread Checks

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts`
- Test: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Add coverage in `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` for:

```ts
it('submits plain text as thread_reply continuation candidate', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: 'fix the CI pipeline' }),
  }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'thread_reply',
    'fix the CI pipeline',
    { source: 'lark', message_id: 'om_msg1' },
    undefined,
    undefined,
  );
  expect(replier.reply).not.toHaveBeenCalled();
});

it('normalizes non-text image into a continuation candidate payload', async () => {
  await handler.handle(makeEvent({
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_v3_abc' }),
  }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'thread_reply',
    '[Image: img_v3_abc]',
    { source: 'lark', message_id: 'om_msg1' },
    undefined,
    undefined,
  );
});

it('submits bare /new without local thread validation', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: '/new' }),
  }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'new_instance',
    '',
    { source: 'lark', message_id: 'om_msg1' },
    undefined,
    undefined,
  );
});
```

- [ ] **Step 2: Run the listener tests to verify failure**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`

Expected: FAIL because the handler still rejects plain text and non-text up front.

- [ ] **Step 3: Implement syntax-only continuation submission**

In `packages/daemon/lark-listener/src/message-handler.ts`:

- preserve the existing explicit `/task` root parsing contract
- preserve `/new`, `/new <executor> <model>`, and `/end` parsing
- submit plain text as `task_type: 'thread_reply'`
- submit normalized non-text as `task_type: 'thread_reply'`
- keep `/new`, `/new <executor> <model>`, and `/end` as forwarded control commands
- keep malformed `/task` and malformed `/new` as local usage rejections

Do not perform any thread-membership check here.

- [ ] **Step 4: Re-run the listener tests**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts
git commit -m "feat(lark-listener): forward continuation candidates"
```

---

### Task 3: Make Thread Lookup Explicitly Distinguish Root, Thread, and Failure

**Files:**
- Modify: `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests in `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts` for a tri-state API:

```ts
it('returns kind not_thread when message is a root message', async () => {
  const result = await fetcher.fetchThreadContext('om_msg1');
  expect(result).toEqual({ kind: 'not_thread' });
});

it('returns kind thread with inherited metadata when thread lookup succeeds', async () => {
  const result = await fetcher.fetchThreadContext('om_new_msg');
  expect(result?.kind).toBe('thread');
  expect(result).toMatchObject({
    kind: 'thread',
    inheritedTaskType: 'code_review',
    inheritedSessionId: expect.any(String),
  });
});

it('returns kind error after retry exhaustion', async () => {
  mockFetch.mockRejectedValue(new Error('Network error'));

  const result = await fetcher.fetchThreadContext('om_msg1');
  expect(result).toEqual({ kind: 'error', reason: expect.stringMatching(/failed/i) });
});
```

- [ ] **Step 2: Run the fetcher tests to verify failure**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts`

Expected: FAIL because the fetcher currently returns `null` for both root and failure.

- [ ] **Step 3: Implement the tri-state lookup result**

In `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`:

- replace the nullable return contract with an explicit union
- return `{ kind: 'not_thread' }` for root messages
- return `{ kind: 'thread', ... }` for successful thread lookups
- return `{ kind: 'error', reason }` after retry exhaustion

Keep the existing metadata extraction rules, `/new` fencing, and line stripping behavior unchanged.

- [ ] **Step 4: Re-run the fetcher tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts
git commit -m "feat(enrichment): make thread lookup tri-state"
```

---

### Task 4: Rewrite `thread_reply` Tasks Using Inherited Thread Metadata

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests in `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` for:

```ts
it('rewrites thread_reply into inherited task routing and session', async () => {
  const task = createTask({
    task_type: 'thread_reply',
    payload: 'fix the failing tests',
    executor: undefined,
    executor_model: undefined,
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });

  mockThreadContextFetcher.fetchThreadContext.mockResolvedValue({
    kind: 'thread',
    threadContext: 'user: original\nassistant: reply',
    inheritedTaskType: 'code_review',
    inheritedSessionId: 'session-123',
    inheritedExecutor: 'claude',
    inheritedExecutorModel: 'sonnet',
  });

  await poller.pollOnce();

  expect(mockEnrich).toHaveBeenCalledWith(
    expect.objectContaining({
      task_type: 'code_review',
      payload: 'fix the failing tests',
      executor: 'claude',
      executor_model: 'sonnet',
    }),
    'session-123',
    'user: original\nassistant: reply',
  );
});

it('rejects thread_reply when inherited metadata is incomplete', async () => {
  mockThreadContextFetcher.fetchThreadContext.mockResolvedValue({
    kind: 'thread',
    threadContext: null,
    inheritedTaskType: null,
    inheritedSessionId: 'session-123',
    inheritedExecutor: 'claude',
    inheritedExecutorModel: 'sonnet',
  });

  await poller.pollOnce();

  expect(mockFetch).toHaveBeenCalledWith(
    'http://localhost:3000/results',
    expect.objectContaining({
      body: JSON.stringify(expect.objectContaining({
        stdout: expect.stringMatching(/metadata is incomplete/i),
      })),
    }),
  );
});

it('rejects threaded /task with the thread reply guidance', async () => {
  mockThreadContextFetcher.fetchThreadContext.mockResolvedValue({
    kind: 'thread',
    threadContext: null,
    inheritedTaskType: 'code_review',
    inheritedSessionId: 'session-123',
    inheritedExecutor: 'claude',
    inheritedExecutorModel: 'sonnet',
  });

  const task = createTask({
    task_type: 'code_review',
    payload: 'review this diff',
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });

  await poller.pollOnce();

  expect(mockFetch).toHaveBeenCalledWith(
    'http://localhost:3000/results',
    expect.objectContaining({
      body: JSON.stringify(expect.objectContaining({
        stdout: 'Cannot use /task in a thread. Reply with natural language, /new, or /end.\nUse /task only as a new root message.',
      })),
    }),
  );
});

it('rejects root thread_reply with the root /task usage hint', async () => {
  mockThreadContextFetcher.fetchThreadContext.mockResolvedValue({ kind: 'not_thread' });

  const task = createTask({
    task_type: 'thread_reply',
    payload: 'fix the bug',
    executor: undefined,
    executor_model: undefined,
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });

  await poller.pollOnce();

  expect(mockFetch).toHaveBeenCalledWith(
    'http://localhost:3000/results',
    expect.objectContaining({
      body: JSON.stringify(expect.objectContaining({
        stdout: 'Usage: /task <type> <executor> <model> <payload> or /end (in a thread)',
      })),
    }),
  );
});

it('rejects root /new with thread-only guidance', async () => {
  mockThreadContextFetcher.fetchThreadContext.mockResolvedValue({ kind: 'not_thread' });

  const task = createTask({
    task_type: 'new_instance',
    payload: '',
    executor: undefined,
    executor_model: undefined,
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });

  await poller.pollOnce();

  expect(mockFetch).toHaveBeenCalledWith(
    'http://localhost:3000/results',
    expect.objectContaining({
      body: JSON.stringify(expect.objectContaining({
        stdout: 'The /new command can only be used inside a thread.',
      })),
    }),
  );
});
```

- [ ] **Step 2: Run the poller tests to verify failure**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`

Expected: FAIL because `thread_reply` does not exist and the poller still assumes all non-control threaded Lark tasks are invalid.

- [ ] **Step 3: Implement thread continuation rewriting and root/thread rejection in enrichment**

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`:

- detect the internal `thread_reply` task type
- use the new tri-state lookup result
- when lookup returns `thread`, require inherited `task_type`, `session_id`, `executor`, and `executor_model`
- rewrite the task object to the inherited routed shape before calling `enrichmentService.enrich(...)`
- when lookup returns `not_thread`, reject `thread_reply`, `/new`, and `/end` with the appropriate root/thread-only message
- when lookup returns `error`, publish a rejection instead of falling back to a new session
- keep `/task`-in-thread rejection in enrichment, but update the rejection copy to the new thread guidance
- keep `/new` and `/end` behavior aligned with the design

- [ ] **Step 4: Re-run the poller tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): continue Lark thread replies with inherited routing"
```

---

### Task 5: Tighten the Enrichment Boundary for Thread-Only Commands

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Add failing regression tests for `/new` and `/end` scope**

Cover these cases:

- root `/new` is rejected in enrichment with `The /new command can only be used inside a thread.`
- root `/end` is rejected in enrichment with `The /end command can only be used inside a thread.`
- root plain text and root non-text continuation candidates are rejected in enrichment with the `/task` usage hint
- bare threaded `/new` still inherits the current executor/model as already designed

- [ ] **Step 2: Run the affected tests to verify failure**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`

Expected: At least the new root command scope cases FAIL.

- [ ] **Step 3: Implement the boundary behavior**

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`:

- if a `new_instance` or `cleanup` Lark task resolves to `not_thread`, reject with the thread-only message instead of proceeding
- if a `thread_reply` task resolves to `not_thread`, reject with the root `/task` usage hint
- if a lookup resolves to `error`, reject conservatively instead of creating new work

This keeps all thread-membership authority in enrichment.

- [ ] **Step 4: Re-run the targeted tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): enforce thread-only Lark commands"
```

---

### Task 6: Update Related Design Docs and Run a Regression Sweep

**Files:**
- Modify: `docs/development/design/2026-04-02-task-explicit-routing-contract-design.md`
- Modify: `docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md`

- [ ] **Step 1: Add short refinement notes to the earlier specs**

In `docs/development/design/2026-04-02-task-explicit-routing-contract-design.md`, add a short note near the top that root `/task` remains the explicit entrypoint, but plain thread replies are now refined by the newer thread continuation design.

In `docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md`, add a short note that `/new` and `/new <executor> <model>` are now thread-only for Lark.

- [ ] **Step 2: Run the focused regression suites**

Run: `cd packages/shared && npx vitest run src/__tests__/routing-errors.test.ts`

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts src/__tests__/task-submitter.test.ts`

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts src/__tests__/enrichment-poller.test.ts src/__tests__/enrichment-service.test.ts`

Expected: PASS

- [ ] **Step 3: Run the broader package test suites**

Run: `cd packages/daemon/lark-listener && npx vitest run`

Run: `cd packages/daemon/task-enrichment && npx vitest run`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add docs/development/design/2026-04-02-task-explicit-routing-contract-design.md docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md
git commit -m "docs: align routing specs with natural thread continuation"
```
