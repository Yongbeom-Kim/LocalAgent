# Thread `/status` Command Implementation Plan

**Goal:** Add a thread-only `/status` command that replies with the existing metadata header block and either `Executor is running` or `Executor is not running`, using live singleton task-daemon session state as the source of truth.

**Architecture:** `lark-listener` parses `/status` into a control task, `task-enrichment` resolves the inherited thread session and queries a small internal HTTP status endpoint exposed by `task-daemon`, and `lark-result-daemon` reuses existing result formatting so the thread reply headers stay unchanged. The task daemon remains the owner of live running state through `TaskPoller.activeSessions`, while config and contract updates make the new daemon-to-daemon lookup explicit and testable.

**Tech Stack:** TypeScript, Node.js HTTP server, Express API conventions already present in repo, Vitest, Docker Compose service env wiring.

---

### Task 1: Update external command contract and shared routing helpers

**Files:**
- Modify: `COMMANDS.md`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/routing-errors.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/routing-errors.test.ts`

- [ ] **Step 1: Write the failing shared-routing test for `/status` help text and thread-only formatting**

Add assertions in `packages/shared/src/__tests__/routing-errors.test.ts` that:
- thread reply help text includes `/status`;
- thread-only formatter accepts `/status` and returns `The /status command can only be used inside a thread.`;
- any command-label typing changes compile.

- [ ] **Step 2: Run the shared routing test to verify it fails**

Run: `cd packages/shared && npx vitest run src/__tests__/routing-errors.test.ts`
Expected: FAIL because `/status` is not yet included in helpers/types.

- [ ] **Step 3: Add `/status` to the external command contract**

Update `COMMANDS.md` with a new `/status` section:
- grammar: `/status`
- valid context: thread reply only
- invalid root usage: context invalid
- invalid trailing args or extra content: shape invalid

Also update the default thread-reply behavior text to mention `/status` alongside natural language, `/new`, and `/end`.

- [ ] **Step 4: Add shared type and routing support for `/status`**

In `packages/shared/src/types.ts`:
- add `'status'` to `CONTROL_TASK_TYPES`.

In `packages/shared/src/routing-errors.ts`:
- widen `formatThreadReplyHelpMessage()` to mention `/status`;
- widen `formatThreadOnlyCommandMessage()` input union to `'/status' | '/new' | '/end'`.

In `packages/shared/src/index.ts`:
- re-export any updated types/helpers without changing import ergonomics.

- [ ] **Step 5: Re-run the shared routing test**

Run: `cd packages/shared && npx vitest run src/__tests__/routing-errors.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit shared contract changes**

```bash
git add COMMANDS.md packages/shared/src/types.ts packages/shared/src/routing-errors.ts packages/shared/src/index.ts packages/shared/src/__tests__/routing-errors.test.ts
git commit -m "feat(shared): add thread-only status command contract"
```

### Task 2: Parse `/status` in the Lark listener

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts`
- Test: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`

- [ ] **Step 1: Write failing listener tests for `/status`**

Add tests in `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` that verify:
- bare `/status` submits `task_type: 'status'` with empty payload;
- `/status now` returns usage and does not submit;
- `/statusfoo` is rejected as malformed usage rather than treated as a valid `/status`.

Also update the expected usage hint string to include `/status (in a thread)`.

- [ ] **Step 2: Run the listener test file to verify it fails**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: FAIL because parser and usage hint do not yet support `/status`.

- [ ] **Step 3: Implement `/status` parsing in `MessageHandler`**

Update `packages/daemon/lark-listener/src/message-handler.ts` to:
- change the usage hint string to mention `/status` and `/end` as thread-only commands;
- parse bare `/status` to `{ kind: 'submit', taskType: 'status', taskPayload: '' }`;
- treat `/status ` or `/status\n...` as malformed usage;
- keep prefix handling aligned with `/new`, `/end`, and `/gc` so `/statusfoo` is not accepted.

- [ ] **Step 4: Re-run the listener tests**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit listener changes**

```bash
git add packages/daemon/lark-listener/src/message-handler.ts packages/daemon/lark-listener/src/__tests__/message-handler.test.ts
git commit -m "feat(lark-listener): parse thread status command"
```

### Task 3: Add task-daemon status endpoint config and live session query

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/daemon/task/src/task-daemon.ts`
- Modify: `packages/daemon/task/src/task-poller.ts`
- Test: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Test: `packages/shared/src/__tests__/config.test.ts`

- [ ] **Step 1: Write failing config, task-poller, and status-endpoint tests**

Add tests for:
- new config defaults/env parsing for the task-daemon status listen port;
- `TaskPoller.isSessionActive(sessionId)` returning `true` while a job is in flight and `false` after completion.

Also add a minimal status-endpoint test that verifies:
- `GET /status/:sessionId` returns JSON `{ session_id, running }`;
- unknown sessions return `running: false`;
- known active sessions return `running: true`.

Use the existing mocked executor promise pattern in `packages/daemon/task/src/__tests__/task-poller.test.ts` so the in-flight window is deterministic.

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/__tests__/config.test.ts`
Expected: FAIL because the new config fields do not exist.

Run: `cd packages/daemon/task && npx vitest run src/__tests__/task-poller.test.ts`
Expected: FAIL because `TaskPoller` does not expose an active-session query yet.

- [ ] **Step 3: Add shared config/constants for daemon status networking**

In `packages/shared/src/constants.ts` add documented defaults such as:
- `DEFAULT_TASK_DAEMON_STATUS_PORT`
- `DEFAULT_TASK_DAEMON_STATUS_URL`

Note: the *URL* is owned by `task-enrichment` (it is the caller). The shared package should only provide a default string constant for enrichment to reuse, not parse it in `loadDaemonConfig()`.

In `packages/shared/src/config.ts` extend config typing/loading so code can read:
- task-daemon status listen port;

Keep this scoped to the task-daemon use case (the only current consumer of `loadDaemonConfig()` in this repo). The enrichment daemon has its own config loader (Task 4).

Keep the existing config shape style: simple env-backed scalar fields with defaults.

- [ ] **Step 4: Expose live session-state query from `TaskPoller`**

In `packages/daemon/task/src/task-poller.ts` add:
- a read-only method `isSessionActive(sessionId: string): boolean` backed by `activeSessions`.

Do not change existing execution flow; the method is an observer only.

- [ ] **Step 5: Start the internal HTTP status endpoint in `task-daemon.ts`**

Update `packages/daemon/task/src/task-daemon.ts` to:
- create a small HTTP server bound for internal daemon traffic;
- serve `GET /status/:sessionId` with JSON `{ session_id, running }`;
- use `poller.isSessionActive(sessionId)` as the answer;

Shutdown ordering requirement:
- stop accepting new status requests by closing the HTTP server first;
- then `await poller.drain()`;
- then exit.

Keep the endpoint minimal and read-only. Avoid pulling Express into task-daemon if a tiny Node `http` server is sufficient.

- [ ] **Step 6: Re-run task-daemon and shared config tests**

Run: `cd packages/shared && npx vitest run src/__tests__/config.test.ts`
Expected: PASS.

Run: `cd packages/daemon/task && npx vitest run src/__tests__/task-poller.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit task-daemon status endpoint groundwork**

```bash
git add packages/shared/src/constants.ts packages/shared/src/config.ts packages/shared/src/__tests__/config.test.ts packages/daemon/task/src/task-daemon.ts packages/daemon/task/src/task-poller.ts packages/daemon/task/src/__tests__/task-poller.test.ts
git commit -m "feat(task-daemon): expose live session status endpoint"
```

### Task 4: Teach task-enrichment config about the task-daemon status URL

**Files:**
- Modify: `packages/daemon/task-enrichment/src/config.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing enrichment config test**

Add assertions that `loadEnrichmentDaemonConfig()` returns a task-daemon status base URL:
- defaulting to the shared default;
- overridable from env (for example `TASK_DAEMON_STATUS_URL`).

- [ ] **Step 2: Run the config test to verify it fails**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/config.test.ts`
Expected: FAIL because the config field does not exist.

- [ ] **Step 3: Implement enrichment status-URL config**

Update `packages/daemon/task-enrichment/src/config.ts` to include the configured task-daemon status base URL using the shared default when env is absent.

- [ ] **Step 4: Re-run the enrichment config test**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit enrichment config changes**

```bash
git add packages/daemon/task-enrichment/src/config.ts packages/daemon/task-enrichment/src/__tests__/config.test.ts
git commit -m "feat(task-enrichment): configure task daemon status url"
```

### Task 5: Implement `/status` handling in the enrichment poller

**Files:**
- Modify: `packages/daemon/task-enrichment/src/index.ts`
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Write failing enrichment-poller tests for `/status`**

Add tests that cover:
- root `/status` gets a thread-only failure result;
- thread `/status` with missing inherited session fails with `The /status command requires an existing session in this thread.`;
- thread `/status` with inherited metadata and status endpoint returning `{ running: true }` publishes a success result whose header fields are inherited and whose `stdout` is `Executor is running`;
- same, with `{ running: false }`, yields `Executor is not running`;
- status endpoint fetch error publishes failure and ACKs the task.

Keep the expected result shape aligned with existing `publishRejection()`/`POST /results` patterns.

- [ ] **Step 2: Run the enrichment poller test file to verify it fails**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: FAIL because `/status` routing does not exist.

- [ ] **Step 3: Thread the status URL into daemon startup**

Update `packages/daemon/task-enrichment/src/index.ts` so `EnrichmentPoller` receives the configured task-daemon status base URL.

- [ ] **Step 4: Implement `/status` branch in `EnrichmentPoller`**

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`:
- detect `task.task_type === 'status'`;
- reuse existing thread-context fetch path;
- reject non-thread `/status` via `formatThreadOnlyCommandMessage('/status')`;
- require inherited `session_id`, `executor`, `executor_model`, and `task_type` for the success path;
- call `GET ${statusBaseUrl}/status/${sessionId}` with a short timeout (<= 1s);

When publishing the synthetic success result, keep the reply headers unchanged by setting:
- `result.task_type` to the *inherited thread task type* (not `'status'`);
- `result.executor`, `result.executor_model`, and `result.session_id` to inherited values;
- `result.job_id` to a deterministic synthetic id (use `task.task_id` unless existing patterns require otherwise);
- `result.status` to `'success'` and `result.exit_code` to `0`;
- `result.stdout` to `Executor is running` or `Executor is not running`.

Avoid introducing any `/status`-specific formatting in the result notifier: this must flow through the normal `/results` path.

- publish a failure result if lookup fails;
- ACK the task in all handled terminal paths.

Avoid passing `/status` through normal enrichment-to-job submission since this is query behavior, not executor work.

- [ ] **Step 5: Re-run the enrichment poller tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit `/status` enrichment behavior**

```bash
git add packages/daemon/task-enrichment/src/index.ts packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "feat(task-enrichment): answer thread status from task daemon"
```

### Task 6: Wire internal service env and verify end-to-end package tests

**Files:**
- Modify: `docker-compose.yml`
- Test: `packages/shared/src/__tests__/routing-errors.test.ts`
- Test: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/config.test.ts`
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`
- Test: `packages/shared/src/__tests__/config.test.ts`
- Test: `packages/daemon/task/src/__tests__/task-poller.test.ts`

- [ ] **Step 1: Update compose env wiring for daemon-to-daemon status lookup**

In `docker-compose.yml`:
- set the task-daemon status listen port env;
- set `TASK_DAEMON_STATUS_URL` for `task-enrichment-daemon` to the internal service URL (for example `http://task-daemon:<port>` in Compose or `http://127.0.0.1:<port>` for local bare-metal runs);
- do not publish the internal status port to the host unless explicitly needed.

- [ ] **Step 2: Run the targeted package test suite**

Run:
```bash
cd packages/shared && npx vitest run src/__tests__/routing-errors.test.ts src/__tests__/config.test.ts
```
Expected: PASS.

Run:
```bash
cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts
```
Expected: PASS.

Run:
```bash
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/config.test.ts src/__tests__/enrichment-poller.test.ts
```
Expected: PASS.

Run:
```bash
cd packages/daemon/task && npx vitest run src/__tests__/task-poller.test.ts
```
Expected: PASS.

- [ ] **Step 3: If any targeted test fails, fix the minimal issue and re-run only the affected package test**

Do not expand scope. Keep fixes limited to `/status` contract/config/status-endpoint integration.

- [ ] **Step 4: Commit integration wiring and final test adjustments**

```bash
git add docker-compose.yml
git commit -m "chore: wire internal task daemon status service"
```
