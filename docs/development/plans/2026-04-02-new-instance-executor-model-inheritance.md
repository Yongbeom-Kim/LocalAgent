# `/new` Executor and Model Inheritance Implementation Plan

> **Naming note:** The current executor naming contract uses `claude` and `cursor`. For the live rename spec, see `docs/development/design/2026-04-02-executor-rename-claude-and-cursor-design.md` and `docs/development/plans/2026-04-02-executor-rename-claude-and-cursor.md`.

**Goal:** Let `/new` accept an optional `<executor> <model>` pair, persist the chosen pair through visible Lark reply metadata, and make later thread messages inherit that pair unless they explicitly change it.

**Architecture:** Reuse the existing thread-metadata pattern instead of adding new storage. `lark-listener` only parses `/new` syntax and encodes explicit overrides; `task-daemon` and `lark-result` surface the actual executor/model used in result metadata; `ThreadContextFetcher` reads the most recent valid pair from bot replies; `EnrichmentPoller` applies that pair as the effective single-entry executor list for inheriting thread tasks.

**Tech Stack:** TypeScript, Vitest, Express, Lark API integration, Rush monorepo

**Implementation order (dependencies):** Task 1 (listener) and Task 2 (shared + API) are independent and can run in parallel. Task 3 depends on Task 2 types and API acceptance. Task 4 depends on shared types. Task 5 depends on Tasks 1–4 (needs listener payload shape, `ThreadContextResult` fields, and result metadata in replies). Task 6 is the regression sweep.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/daemon/lark-listener/src/message-handler.ts` | Parse `/new <executor> <model>` and encode structured override payload |
| Modify | `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Command-shape tests for bare `/new`, explicit `/new`, and invalid arities |
| Modify | `packages/shared/src/types.ts` | Add optional result metadata fields `executor` and `executor_model` |
| Modify | `packages/shared/src/__tests__/types.test.ts` | Type-shape coverage for optional executor metadata on results |
| Modify | `packages/api/src/routes/results.ts` | Validate and pass through optional `executor` / `executor_model` on posted results |
| Modify | `packages/api/src/__tests__/routes/results.test.ts` | Route tests for valid pair passthrough and invalid partial/invalid pair rejection |
| Modify | `packages/daemon/task/src/core/task-orchestrator.ts` | Annotate final `TaskResultSubmission` with the actual executor/model used |
| Modify | `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Verify annotated result uses the selected executor/model on success and failure |
| Verify (modify only if needed) | `packages/daemon/task/src/task-poller.ts` | `resultWithSource` already spreads `...result`; confirm orchestrator `executor` / `executor_model` reach POST `/results` (add explicit fields only if something strips them) |
| Modify | `packages/daemon/task/src/__tests__/task-poller.test.ts` | Verify poller preserves executor/model when posting results |
| Modify | `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Prepend visible `executor:` / `model:` lines when present |
| Modify | `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts` | Verify reply text includes and omits executor/model lines correctly |
| Modify | `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Extract latest valid executor/model from bot replies and strip metadata lines from prompt history |
| Modify | `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts` | Reverse-scan, trim-before-validate, full-list-vs-fence, and stripping coverage |
| Modify | `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Apply explicit `/new` override, bare `/new` inheritance, ordinary thread inheritance, and control-command exemptions |
| Modify | `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Cover explicit override, inherited override, config fallback, and non-inheritance for `gc` / `cleanup` |

---

### Task 1: Parse Explicit `/new <executor> <model>` Syntax

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts`
- Test: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests in `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` for:

```ts
it('submits /new <executor> <model> as new_instance with structured payload', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: '/new cursor_agent gpt-5.4-medium-fast' }),
  }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'new_instance',
    JSON.stringify({
      executor: 'cursor_agent',
      executor_model: 'gpt-5.4-medium-fast',
    }),
    { source: 'lark', message_id: 'om_msg1' },
  );
});

it('rejects /new with only one arg', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: '/new cursor_agent' }),
  }));

  expect(submitter.submit).not.toHaveBeenCalled();
  expect(replier.reply).toHaveBeenCalledWith(
    'om_msg1',
    'Usage: /task <type> <payload> or /end (in a thread)',
  );
});

it('rejects /new with more than two args', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: '/new cursor_agent gpt-5.4-medium-fast extra' }),
  }));

  expect(submitter.submit).not.toHaveBeenCalled();
  expect(replier.reply).toHaveBeenCalled();
});

it('does not treat /newfoo as /new', async () => {
  await handler.handle(makeEvent({
    content: JSON.stringify({ text: '/newfoo' }),
  }));

  expect(submitter.submit).toHaveBeenCalledWith(
    'generic',
    '/newfoo',
    { source: 'lark', message_id: 'om_msg1' },
  );
});
```

- [ ] **Step 2: Run the listener tests to verify the new cases fail**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`

Expected: FAIL because `/new` currently only accepts the bare form and rejects any args.

- [ ] **Step 3: Implement the minimal parser change**

Update `packages/daemon/lark-listener/src/message-handler.ts` so `/new` behaves like:

```ts
if (payload === '/new') {
  return { taskType: 'new_instance', taskPayload: '', isCommand: true };
}

if (payload.startsWith('/new ') || payload.startsWith('/new\n')) {
  const rest = payload.slice('/new'.length).trim();
  const args = rest.split(/\s+/);

  if (args.length === 2) {
    return {
      taskType: 'new_instance',
      taskPayload: JSON.stringify({
        executor: args[0],
        executor_model: args[1],
      }),
      isCommand: true,
    };
  }

  return { taskType: null, taskPayload: '', isCommand: true };
}
```

Do not validate executor/model semantics here; keep `lark-listener` responsible only for command shape.

- [ ] **Step 4: Re-run the listener tests**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts
git commit -m "feat(lark-listener): accept explicit executor/model on /new"
```

---

### Task 2: Extend the Result Contract for Executor Metadata

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/__tests__/types.test.ts`
- Modify: `packages/api/src/routes/results.ts`
- Modify: `packages/api/src/__tests__/routes/results.test.ts`

- [ ] **Step 1: Write the failing tests**

Add one low-cost type-shape test in `packages/shared/src/__tests__/types.test.ts`:

```ts
it('accepts optional executor metadata on TaskResultSubmission shape', () => {
  const result = {
    job_id: 'job-1',
    task_id: 'task-1',
    task_type: 'generic',
    status: 'success',
    exit_code: 0,
    stdout: 'done',
    stderr: '',
    executor: 'claude_code',
    executor_model: 'sonnet',
  };

  expect(result.executor).toBe('claude_code');
  expect(result.executor_model).toBe('sonnet');
});
```

Add route tests in `packages/api/src/__tests__/routes/results.test.ts`:

```ts
it('returns 201 with executor metadata when a valid pair is provided', async () => {
  const res = await request(buildApp()).post('/results').send({
    ...validSubmission(),
    executor: 'claude_code',
    executor_model: 'sonnet',
  });

  expect(res.status).toBe(201);
  expect(res.body.executor).toBe('claude_code');
  expect(res.body.executor_model).toBe('sonnet');
});

it('returns 400 when executor is provided without executor_model', async () => {
  const res = await request(buildApp()).post('/results').send({
    ...validSubmission(),
    executor: 'claude_code',
  });

  expect(res.status).toBe(400);
});

it('returns 400 when executor/model pair is invalid', async () => {
  const res = await request(buildApp()).post('/results').send({
    ...validSubmission(),
    executor: 'claude_code',
    executor_model: 'gpt-5.4',
  });

  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run the shared and API tests to confirm failure**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`

Run: `cd packages/api && npx vitest run src/__tests__/routes/results.test.ts`

Expected: API tests FAIL because `/results` does not yet validate or return executor metadata.

- [ ] **Step 3: Implement the shared type and API route changes**

In `packages/shared/src/types.ts`, add optional fields to both `TaskResultSubmission` and `TaskResult`:

```ts
  executor?: TaskExecutorType;
  executor_model?: string;
```

In `packages/api/src/routes/results.ts`, import the existing shared validators and implement pair validation:

```ts
if ((executor === undefined) !== (executor_model === undefined)) {
  res.status(400).json({ error: 'executor and executor_model must be provided together' });
  return;
}

if (
  executor !== undefined &&
  (!isTaskExecutorType(executor) || !isValidExecutorModel(executor, executor_model))
) {
  res.status(400).json({ error: 'executor and executor_model must be a valid pair' });
  return;
}
```

Then include the optional fields in the published result object:

```ts
...(executor !== undefined ? { executor } : {}),
...(executor_model !== undefined ? { executor_model } : {}),
```

- [ ] **Step 4: Re-run the shared and API tests**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`

Run: `cd packages/api && npx vitest run src/__tests__/routes/results.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/__tests__/types.test.ts packages/api/src/routes/results.ts packages/api/src/__tests__/routes/results.test.ts
git commit -m "feat(results): add executor metadata to result contract"
```

---

### Task 3: Annotate the Final Attempt and Surface It in Lark Replies

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
- Modify: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`
- Modify: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Modify: `packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- Modify: `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`

- [ ] **Step 1: Write the failing tests**

Add orchestrator assertions in `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`:

```ts
it('annotates successful result with executor metadata from the chosen preference', async () => {
  const result = await orchestrator.handle(createJob({
    executors: [{ executor: 'cursor_agent', executor_model: 'auto' }],
  }));

  expect(result.executor).toBe('cursor_agent');
  expect(result.executor_model).toBe('auto');
});

it('annotates final failure with executor metadata from the last attempted preference', async () => {
  mockClaudeExecute.mockResolvedValueOnce({
    ...mockResultSubmission,
    status: 'failure',
    exit_code: 1,
    stderr: 'first failure',
  });
  mockClaudeWExecute.mockResolvedValueOnce({
    ...mockResultSubmission,
    status: 'failure',
    exit_code: 1,
    stderr: 'second failure',
  });

  const result = await orchestrator.handle(createJob({
    executors: [
      { executor: 'claude_code', executor_model: 'opus' },
      { executor: 'claude-w', executor_model: 'gpt-5.4' },
    ],
  }));

  expect(result.executor).toBe('claude-w');
  expect(result.executor_model).toBe('gpt-5.4');
});
```

Add a task-poller assertion in `packages/daemon/task/src/__tests__/task-poller.test.ts`:

```ts
it('forwards executor metadata from orchestrator result to POST /results', async () => {
  mockClaudeExecute.mockResolvedValueOnce({
    ...mockResultSubmission,
    executor: 'claude_code',
    executor_model: 'opus',
  });

  // existing poll flow...
  const resultPostBody = JSON.parse(mockFetch.mock.calls[1][1].body);
  expect(resultPostBody.executor).toBe('claude_code');
  expect(resultPostBody.executor_model).toBe('opus');
});
```

Add notifier tests in `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`:

```ts
it('prepends executor and model lines when both are present', async () => {
  await notifier.notify(createResult({
    executor: 'cursor_agent',
    executor_model: 'gpt-5.4-medium-fast',
  }));

  const content = JSON.parse(JSON.parse(mockFetch.mock.calls[1][1].body).content);
  expect(content.text).toContain('executor: cursor_agent');
  expect(content.text).toContain('model: gpt-5.4-medium-fast');
});

it('omits executor and model lines when executor metadata is absent', async () => {
  await notifier.notify(createResult({ executor: undefined, executor_model: undefined }));

  const content = JSON.parse(JSON.parse(mockFetch.mock.calls[1][1].body).content);
  expect(content.text).not.toContain('executor:');
  expect(content.text).not.toContain('model:');
});
```

- [ ] **Step 2: Run the daemon and notifier tests to confirm failure**

Run: `cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts src/__tests__/task-poller.test.ts`

Run: `cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts`

Expected: FAIL because the orchestrator result is not yet annotated and notifier does not render the new lines.

- [ ] **Step 3: Implement the minimal code changes**

In `packages/daemon/task/src/core/task-orchestrator.ts`, annotate every returned attempt result:

```ts
const annotatedResult: TaskResultSubmission = {
  ...executorResult,
  executor: pref.executor,
  executor_model: pref.executor_model,
};
lastResult = annotatedResult;
```

In `packages/daemon/lark-result/src/adapters/lark-notifier.ts`, prepend `executor:` / `model:` when both are present, and keep the rest of the header aligned with design §8.3 (metadata lines before `Task ID` / `Job ID`):

```ts
const text = [
  ...(result.executor && result.executor_model
    ? [`executor: ${result.executor}`, `model: ${result.executor_model}`]
    : []),
  `task_type: ${result.task_type}`,
  ...(result.session_id ? [`session_id: ${result.session_id}`] : []),
  `Task ID: ${result.task_id}`,
  `Job ID: ${result.job_id}`,
  `status: ${result.status}`,
  `Exit code: ${result.exit_code ?? 'N/A'}`,
  result.stdout ? `Output:\n${result.stdout}` : 'No output',
].join('\n');
```

Update existing `lark-notifier` tests that assert full reply text so they expect this order (or assert on substrings only).

For `packages/daemon/task/src/__tests__/task-poller.test.ts`, keep the implementation minimal. The current `...result` spread should already preserve the new fields, so only touch `task-poller.ts` if the tests prove otherwise.

- [ ] **Step 4: Re-run the daemon and notifier tests**

Run: `cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts src/__tests__/task-poller.test.ts`

Run: `cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts packages/daemon/task/src/__tests__/task-poller.test.ts packages/daemon/lark-result/src/adapters/lark-notifier.ts packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts
git commit -m "feat(thread-metadata): surface executor metadata in results and Lark replies"
```

---

### Task 4: Teach `ThreadContextFetcher` to Inherit and Strip Executor Metadata

**Files:**
- Modify: `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new describe block in `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`:

```ts
it('extracts the most recent valid executor/model pair from bot replies', async () => {
  // thread contains an older claude_code pair and a newer cursor_agent pair
  const result = await fetcher.fetchThreadContext('om_new_msg', new Set(['deploy', 'default']));
  expect(result!.inheritedExecutor).toBe('cursor_agent');
  expect(result!.inheritedExecutorModel).toBe('gpt-5.4-medium-fast');
});

it('trims executor/model values before validation', async () => {
  const result = await fetcher.fetchThreadContext('om_new_msg');
  expect(result!.inheritedExecutor).toBe('claude_code');
  expect(result!.inheritedExecutorModel).toBe('sonnet');
});

it('strips executor/model lines from formatted threadContext', async () => {
  const result = await fetcher.fetchThreadContext('om_new_msg');
  expect(result!.threadContext).not.toContain('executor:');
  expect(result!.threadContext).not.toContain('model:');
});

it('extracts executor/model from the full message list before applying the /new fence', async () => {
  const result = await fetcher.fetchThreadContext('om_new_msg');
  expect(result!.inheritedExecutor).toBe('claude_code');
  expect(result!.threadContext).toBe('assistant: New session instance started.');
});
```

- [ ] **Step 2: Run the fetcher tests to confirm failure**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts`

Expected: FAIL because `ThreadContextResult` does not yet include executor metadata and no stripping exists.

- [ ] **Step 3: Implement the extraction and stripping**

In `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`:

0. Import `isTaskExecutorType`, `isValidExecutorModel`, and `TaskExecutorType` from `@local-agent/shared` (same pattern as other packages).

1. Extend `ThreadContextResult` with:

```ts
  inheritedExecutor: TaskExecutorType | null;
  inheritedExecutorModel: string | null;
```

2. Add regexes:

```ts
const EXECUTOR_REGEX = /^executor: ([a-zA-Z0-9_-]+)$/m;
const MODEL_REGEX = /^model: ([^\n]+)$/m;
const EXECUTOR_LINE_REGEX = /^executor: .*\n?/m;
const MODEL_LINE_REGEX = /^model: .*\n?/m;
```

3. Scan the **full** `messages` array in reverse order before `applyNewInstanceFence(messages)`:

```ts
let inheritedExecutor: TaskExecutorType | null = null;
let inheritedExecutorModel: string | null = null;

for (let i = messages.length - 1; i >= 0; i--) {
  const m = messages[i];
  if (m.sender.sender_type === 'user') continue;
  const content = extractLarkMessageContent(m.msg_type, m.body.content);
  const executorMatch = content.match(EXECUTOR_REGEX);
  const modelMatch = content.match(MODEL_REGEX);
  if (!executorMatch || !modelMatch) continue;

  const executor = executorMatch[1].trim();
  const executorModel = modelMatch[1].trim();
  if (isTaskExecutorType(executor) && isValidExecutorModel(executor, executorModel)) {
    inheritedExecutor = executor;
    inheritedExecutorModel = executorModel;
    break;
  }
}
```

4. When formatting `threadContext`, strip `executor:` and `model:` lines just like `task_type:` and `session_id:` (use prefix-based line removal per design §8.7).

5. Include `inheritedExecutor` / `inheritedExecutorModel` on **every** `ThreadContextResult` return path (including `threadContext: null` when the fenced slice is empty).

- [ ] **Step 4: Re-run the fetcher tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts
git commit -m "feat(thread-context): inherit executor metadata from bot replies"
```

---

### Task 5: Apply Explicit and Inherited Executor Selection in `EnrichmentPoller`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write the failing tests**

Add focused cases to `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`:

```ts
it('uses explicit /new executor override from structured payload', async () => {
  const task = createTask({
    task_type: 'new_instance',
    payload: JSON.stringify({ executor: 'cursor_agent', executor_model: 'auto' }),
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });
  mockThreadFetcher.fetchThreadContext.mockResolvedValue({
    threadContext: 'assistant: earlier',
    inheritedTaskType: 'deploy',
    inheritedSessionId: 'thread-session-id',
    inheritedExecutor: 'claude_code',
    inheritedExecutorModel: 'sonnet',
  });

  // expect POST /jobs body.executors to equal [{ executor: 'cursor_agent', executor_model: 'auto' }]
});

it('rejects explicit /new override when executor pair is invalid', async () => {
  const task = createTask({
    task_type: 'new_instance',
    payload: JSON.stringify({ executor: 'claude_code', executor_model: 'gpt-5.4' }),
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });

  // expect POST /results failure and no call to enrich()
});

it('uses inherited executor pair for bare /new when available', async () => {
  const task = createTask({
    task_type: 'new_instance',
    payload: '',
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });

  // expect POST /jobs body.executors to equal the inherited single pair
});

it('replaces enriched executors with inherited pair for ordinary threaded messages', async () => {
  const task = createTask({
    task_type: 'generic',
    task_source: { source: 'lark', message_id: 'om_msg1' },
  });

  // expect POST /jobs body.executors to equal the inherited single pair
});

it('does not apply inherited executor pair to cleanup tasks', async () => {
  // cleanup (/end) in a thread: POST /jobs should use cleanup enrichment executors, not thread-inherited pair
});
```

- [ ] **Step 2: Run the poller tests to confirm failure**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`

Expected: FAIL because the poller neither parses explicit `/new` overrides nor replaces executor arrays with inherited single pairs.

- [ ] **Step 3: Implement the poller changes**

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`:

1. Add a helper that **only** parses valid explicit overrides (bare `/new` uses `task.payload === ''` from the listener). Use `try/catch` around `JSON.parse` so malformed JSON becomes a rejection, not an uncaught exception.

```ts
function parseNewInstanceOverride(payload: string): { executor: TaskExecutorType; executor_model: string } | null {
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    isTaskExecutorType((parsed as { executor?: unknown }).executor) &&
    isValidExecutorModel(
      (parsed as { executor: TaskExecutorType }).executor,
      (parsed as { executor_model?: unknown }).executor_model,
    )
  ) {
    const p = parsed as { executor: TaskExecutorType; executor_model: string };
    return { executor: p.executor, executor_model: p.executor_model };
  }
  return null;
}
```

2. At the start of the existing `isNewInstanceTask` branch (after the existing source/thread/session guards), **before** `enrich(...)`:

   - If `task.payload.trim() !== ''` (explicit `/new`), then `parseNewInstanceOverride(task.payload)` must succeed; if it returns `null` (invalid JSON or invalid pair), **call `publishRejection` with a clear reason and `ackTask`**, return — do **not** fall back to inherited thread or config executors (design: invalid explicit selection is a rejection, not inheritance).
   - If `task.payload` is empty (bare `/new`), `explicitOverride` is `null`; executor choice is inherited pair or enriched config as below.

3. In the existing early `isNewInstanceTask` branch after `enrich(...)` succeeds:

```ts
enrichmentResult.job.executors = explicitOverride
  ? [explicitOverride]
  : threadResult?.inheritedExecutor && threadResult?.inheritedExecutorModel
    ? [{ executor: threadResult.inheritedExecutor, executor_model: threadResult.inheritedExecutorModel }]
    : enrichmentResult.job.executors;
```

4. In the **generic** path only (after the `enrichmentResult.type === 'rejected'` check has passed — same place as the existing POST `/jobs` block), apply inherited executor override for Lark-thread tasks that are not control commands:

```ts
if (
  !isGcTask &&
  !isCleanupTask &&
  threadResult?.inheritedExecutor &&
  threadResult?.inheritedExecutorModel
) {
  enrichmentResult.job.executors = [{
    executor: threadResult.inheritedExecutor,
    executor_model: threadResult.inheritedExecutorModel,
  }];
}
```

   If new POST `/jobs` call sites are added later, this inheritance must apply to every non-control threaded path or be centralized in one helper so ordinary messages and `/task` lines cannot skip it (design §8.8).

5. Keep `/gc` and `cleanup` excluded from executor inheritance (`/gc` is handled before this block; `cleanup` must not hit the generic override).

- [ ] **Step 4: Re-run the poller tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`

Expected: PASS

- [ ] **Step 5: Run the full enrichment test suite**

Run: `cd packages/daemon/task-enrichment && npx vitest run`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(enrichment): inherit executor selection across thread messages"
```

---

### Task 6: Final Regression Sweep

**Files:**
- Verify only: all files above

- [ ] **Step 1: Run targeted suites in each affected package**

Run:

```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts
cd packages/shared && npx vitest run src/__tests__/types.test.ts
cd packages/api && npx vitest run src/__tests__/routes/results.test.ts
cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts src/__tests__/task-poller.test.ts
cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/thread-context-fetcher.test.ts src/__tests__/enrichment-poller.test.ts
```

Expected: PASS

- [ ] **Step 2: Run broader package suites if the targeted tests pass**

Run:

```bash
cd packages/api && npx vitest run
cd packages/daemon/task && npx vitest run
cd packages/daemon/lark-result && npx vitest run
cd packages/daemon/task-enrichment && npx vitest run
```

Expected: PASS

- [ ] **Step 3: If regressions appear, fix them before merging**

Use `@review-and-fix` only after the feature is fully implemented and the failing tests point to concrete regressions. Do not use it as a substitute for the targeted work above.

- [ ] **Step 4: Final commit if follow-up fixes were required**

```bash
git add -A
git commit -m "test: fix regressions in /new executor inheritance rollout"
```
