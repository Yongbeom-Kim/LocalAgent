# `/kill` Command Implementation Plan

**Goal:** Add a thread-only `/kill` command that stops the currently active LocalAgent-managed executor process for the current session using `SIGTERM` then `SIGKILL` after 15 seconds, while preserving the session for later continuation.

**Architecture:** Implement `/kill` as a new control task type that flows through the existing listener -> enrichment -> job -> result pipeline, parallel to `/end`. Add a shared task-daemon active-execution registry keyed by `session_id`, let killable executor adapters register exactly one live child per session, and have a built-in orchestrator kill path resolve the active handle, terminate it, and return a structured success result with captured output up to the kill point.

**Tech Stack:** TypeScript, Node.js child_process, Express, Vitest, Markdown

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `COMMANDS.md` | Modify | Add `/kill` to the external Lark command contract |
| `packages/shared/src/types.ts` | Modify | Add `kill` control task type and any shared kill-result types/constants |
| `packages/shared/src/routing-errors.ts` | Modify | Extend thread help/thread-only messaging for `/kill` |
| `packages/shared/src/__tests__/routing-errors.test.ts` | Modify | Verify updated thread help and thread-only command messaging |
| `packages/daemon/lark-listener/src/message-handler.ts` | Modify | Parse `/kill` as a bare thread-only command |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Modify | Add `/kill` acceptance and rejection coverage |
| `packages/api/src/routes/tasks.ts` | Modify | Accept `kill` as a control task |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Verify `/kill` control-task validation behavior |
| `packages/daemon/task-enrichment/config/builtin.yaml` | Modify | Add the `kill` rule to built-in control-task config |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Route `kill` to builtin executor |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Verify `kill` enrichment behavior |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Modify | Make `/kill` thread-only and inherit session_id without thread history |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Modify | Verify `/kill` thread validation and job creation |
| `packages/daemon/task/src/services/active-execution-registry.ts` | Create | Track the current live killable execution per session |
| `packages/daemon/task/src/services/killable-process.ts` | Create | Shared helper/types for signal escalation and kill summary |
| `packages/daemon/task/src/services/__tests__/active-execution-registry.test.ts` | Create | Verify registration replacement, lookup, and identity-safe unregister |
| `packages/daemon/task/src/services/__tests__/killable-process.test.ts` | Create | Verify `SIGTERM`/`SIGKILL` escalation and grace-window exit handling |
| `packages/daemon/task/src/task-poller.ts` | Modify | Let `kill` jobs bypass same-session locking so they can interrupt active work |
| `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` | Modify | Prove `kill` does not NACK behind the active session lock |
| `packages/daemon/task/src/ports/task-executor.ts` | Modify | Thread shared runtime services into executors |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Modify | Handle `kill` jobs and pass registry/runtime services to executors |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Modify | Verify built-in `/kill` behavior and registry integration |
| `packages/daemon/task/src/adapters/claude-executor.ts` | Modify | Register active Claude child and expose adapter-specific kill handling |
| `packages/daemon/task/src/adapters/claude-w-executor.ts` | Modify | Register active Claude-W child and expose adapter-specific kill handling |
| `packages/daemon/task/src/adapters/cursor-executor.ts` | Modify | Register active Cursor child and expose adapter-specific kill handling |
| `packages/daemon/task/src/adapters/ttcodex-executor.ts` | Modify | Register active TTCodex child and expose adapter-specific kill handling |
| `packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts` | Modify | Verify active-child registration and kill-result semantics |
| `packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts` | Modify | Verify active-child registration and kill-result semantics |
| `packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts` | Modify | Verify active-child registration and kill-result semantics |
| `packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts` | Modify | Verify active-child registration and kill-result semantics |

### Task 1: Extend the External Command Contract and Shared Routing

**Files:**
- Modify: `COMMANDS.md`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/routing-errors.ts`
- Modify: `packages/shared/src/__tests__/routing-errors.test.ts`

- [ ] **Step 1: Write failing routing-error tests for `/kill` thread messaging**

Add assertions in `packages/shared/src/__tests__/routing-errors.test.ts` for:

```ts
expect(formatThreadReplyHelpMessage()).toBe(
  'Thread replies must be natural language, /new, /end, or /kill.',
);

expect(formatThreadTaskCommandRejectedMessage()).toBe(
  'Cannot use /task in a thread. Reply with natural language, /new, /end, or /kill.\nUse /task only as a new root message.',
);

expect(formatThreadOnlyCommandMessage('/kill')).toBe(
  'The /kill command can only be used inside a thread.',
);
```

- [ ] **Step 2: Run the shared routing-error test file and confirm failure**

Run: `pnpm vitest run packages/shared/src/__tests__/routing-errors.test.ts`
Expected: FAIL because `/kill` is not yet part of the helper text or thread-only union.

- [ ] **Step 3: Update shared types for the new control task**

Modify `packages/shared/src/types.ts` to:

- add `'kill'` to `CONTROL_TASK_TYPES`
- keep control-task validation behavior aligned with `new_instance` and `cleanup`
- optionally introduce small shared kill constants if needed later, such as `KILL_GRACE_PERIOD_MS = 15_000`

- [ ] **Step 4: Update routing errors to include `/kill`**

Modify `packages/shared/src/routing-errors.ts` so:

- `formatThreadReplyHelpMessage()` includes `/kill`
- `formatThreadTaskCommandRejectedMessage()` includes `/kill`
- `formatThreadOnlyCommandMessage()` accepts `'/new' | '/end' | '/kill'`

- [ ] **Step 5: Update `COMMANDS.md` for `/kill`**

Add a new `/kill` section with:

```md
### /kill

Purpose

Stop the currently running managed agent process for the current thread session.

Grammar

/kill

Valid Contexts

- Thread reply only.

Invalid Forms

- Any use as a root message. (Context invalid.)
- Any trailing arguments or extra content (including newlines). (Shape invalid.)
```

Also update shared thread-help references in the contract to include `/kill`.

- [ ] **Step 6: Re-run the routing-error tests and verify they pass**

Run: `pnpm vitest run packages/shared/src/__tests__/routing-errors.test.ts`
Expected: PASS.

### Task 2: Parse `/kill` in the Lark Listener and Accept It Through the Tasks API

**Files:**
- Modify: `packages/daemon/lark-listener/src/message-handler.ts`
- Modify: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/api/src/__tests__/routes/tasks.test.ts`

- [ ] **Step 1: Add failing listener tests for `/kill`**

Extend `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` with:

- bare `/kill` submits `task_type: 'kill'` with empty payload
- `/kill now` replies with the usage hint and does not submit
- `/killfoo` is treated as natural-language continuation, not the command

Mirror the existing `/end` and `/new` test style.

- [ ] **Step 2: Add failing API route tests for `kill` control-task acceptance**

Extend `packages/api/src/__tests__/routes/tasks.test.ts` with:

```ts
it('returns 201 when kill control task omits executor/model', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({ task_type: 'kill', payload: '' });
  expect(res.status).toBe(201);
});

it('returns 400 when kill control task includes invalid executor/model pair', async () => {
  const res = await request(buildApp())
    .post('/tasks')
    .send({ task_type: 'kill', payload: '', executor: 'foo', executor_model: 'bar' });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 3: Run listener and API task-route tests to confirm failure**

Run: `pnpm vitest run packages/daemon/lark-listener/src/__tests__/message-handler.test.ts packages/api/src/__tests__/routes/tasks.test.ts`
Expected: FAIL because `/kill` is not yet parsed as a command or recognized as a control task.

- [ ] **Step 4: Update `MessageHandler.parseCommand()` for `/kill`**

Modify `packages/daemon/lark-listener/src/message-handler.ts` so:

- `payload === '/kill'` returns `{ kind: 'submit', taskType: 'kill', taskPayload: '' }`
- `payload.startsWith('/kill ') || payload.startsWith('/kill\n')` returns usage
- reserved-command detection includes `/kill`
- usage hint string becomes `Usage: /task <type> <executor> <model> <payload> or /end, /kill (in a thread)` or equivalent concise wording consistent with the repo style

- [ ] **Step 5: Ensure the API task route accepts `kill` as a control task**

Once `CONTROL_TASK_TYPES` includes `kill`, confirm `packages/api/src/routes/tasks.ts` needs no extra branching beyond existing control-task validation. Only modify the route if a test still exposes special handling gaps.

- [ ] **Step 6: Re-run listener and task-route tests and verify they pass**

Run: `pnpm vitest run packages/daemon/lark-listener/src/__tests__/message-handler.test.ts packages/api/src/__tests__/routes/tasks.test.ts`
Expected: PASS.

### Task 3: Route `/kill` Through Enrichment as a Thread-Only Built-in Control Task

**Files:**
- Modify: `packages/daemon/task-enrichment/config/builtin.yaml`
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Add failing enrichment-service tests for `kill`**

Add tests in `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` asserting that:

- `task_type: 'kill'` with omitted executor/model yields `[{ executor: 'builtin', executor_model: 'none' }]`
- loading from builtin config includes the `kill` rule alongside cleanup

- [ ] **Step 2: Add failing enrichment-poller tests for `/kill` thread behavior**

Extend `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` with coverage for:

- rejecting `kill` without Lark source
- rejecting `kill` outside a thread using `formatThreadOnlyCommandMessage('/kill')`
- rejecting `kill` in a thread when inherited `session_id` is missing
- creating a `kill` job that inherits `session_id`, skips thread history, and uses builtin executor when valid

Use the existing cleanup tests as the template, but assert the task type stays `kill`.

- [ ] **Step 3: Run enrichment tests to verify failure**

Run: `pnpm vitest run packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`
Expected: FAIL because the builtin config and poller do not yet recognize `kill`.

- [ ] **Step 4: Add the builtin `kill` rule**

Update `packages/daemon/task-enrichment/config/builtin.yaml` to include:

```yaml
rules:
  cleanup: {}
  kill: {}
```

Keep the config minimal and rely on enrichment-service control-task mapping for executor assignment.

- [ ] **Step 5: Extend enrichment service control-task routing**

Modify `packages/daemon/task-enrichment/src/enrichment-service.ts` so the control-task branch maps:

- `cleanup` -> builtin
- `kill` -> builtin
- `new_instance` -> inherited or default external executor

Do not reuse the `/new` branch for kill. `kill` should never accept or require an inherited external executor.

- [ ] **Step 6: Extend enrichment poller with `kill` handling**

Modify `packages/daemon/task-enrichment/src/enrichment-poller.ts` to:

- define `KILL_TASK_TYPE = 'kill'`
- require Lark task source for `kill`
- reject `kill` outside a thread via `formatThreadOnlyCommandMessage('/kill')`
- reject `kill` if thread metadata lacks inherited `session_id`
- bypass inherited task-type mismatch for `kill`, similar to cleanup
- skip prepending thread history for `kill`
- submit a normal job with inherited `session_id` and builtin executor

- [ ] **Step 7: Re-run enrichment tests and verify they pass**

Run: `pnpm vitest run packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`
Expected: PASS.

### Task 4: Build the Shared Active-Execution Registry and Kill Helper

**Files:**
- Create: `packages/daemon/task/src/services/active-execution-registry.ts`
- Create: `packages/daemon/task/src/services/killable-process.ts`
- Create: `packages/daemon/task/src/services/__tests__/active-execution-registry.test.ts`
- Create: `packages/daemon/task/src/services/__tests__/killable-process.test.ts`

- [ ] **Step 1: Write failing registry tests first**

Create `packages/daemon/task/src/services/__tests__/active-execution-registry.test.ts` with tests for:

- registering a target stores it by `session_id`
- registering a second target for the same session replaces the first
- unregister only clears the entry when the caller identity matches the active registration
- lookup returns `undefined` when empty

Suggested API shape:

```ts
const token = registry.register(target);
expect(registry.get('session-1')).toBeDefined();
registry.unregister('session-1', token);
expect(registry.get('session-1')).toBeUndefined();
```

- [ ] **Step 2: Write failing kill-helper tests for signal escalation**

Create `packages/daemon/task/src/services/__tests__/killable-process.test.ts` covering:

- sends `SIGTERM` immediately and resolves when the child closes during grace window
- escalates to `SIGKILL` after 15 seconds if the child stays open
- reports a successful outcome if the child exits naturally during the grace window
- captures and returns `stdout`/`stderr` buffers accumulated up to kill point

Use fake timers for the grace window and a mock EventEmitter child with `kill()` spies.

- [ ] **Step 3: Run the new service tests and confirm failure**

Run: `pnpm vitest run packages/daemon/task/src/services/__tests__/active-execution-registry.test.ts packages/daemon/task/src/services/__tests__/killable-process.test.ts`
Expected: FAIL because the services do not exist yet.

- [ ] **Step 4: Implement the active-execution registry**

Create `packages/daemon/task/src/services/active-execution-registry.ts` with a small in-memory map keyed by `session_id`.

The target payload should include at least:

```ts
interface ActiveExecutionTarget {
  sessionId: string;
  jobId: string;
  taskId: string;
  executor: TaskExecutorType;
  executorModel: string;
  terminate: (graceMs: number) => Promise<KillResult>;
}
```

Have `register()` return an opaque token so unregister is identity-safe and does not accidentally clear a newer fallback child.

- [ ] **Step 5: Implement the shared kill helper**

Create `packages/daemon/task/src/services/killable-process.ts`.

This helper should:

- accept a child process plus accessors for current stdout/stderr text
- support whole-tree termination for killable executors via an explicit signaling primitive, not bare direct-child `.kill()` defaults
- send `SIGTERM`
- wait up to `15_000ms`
- send `SIGKILL` if still active
- resolve a structured kill result containing:
  - signal path
  - wait duration
  - executor metadata passed through by the caller
  - captured stdout/stderr up to kill point

Keep the signal logic explicit. Do not rely on bare `.kill()` defaults.

- [ ] **Step 6: Make the process-tree signaling mechanism explicit in tests**

Decide one concrete mechanism and encode it in the tests before wiring executors. Recommended POSIX path:

- spawn killable executors in a process-group-friendly mode
- signal the process group rather than only the direct child

Add at least one assertion in `packages/daemon/task/src/services/__tests__/killable-process.test.ts` that the helper uses the chosen signaling primitive rather than an implicit direct-child default.

- [ ] **Step 7: Re-run the new service tests and verify they pass**

Run: `pnpm vitest run packages/daemon/task/src/services/__tests__/active-execution-registry.test.ts packages/daemon/task/src/services/__tests__/killable-process.test.ts`
Expected: PASS.

### Task 5: Let `/kill` Bypass Same-Session Locking in the Poller

**Files:**
- Modify: `packages/daemon/task/src/task-poller.ts`
- Modify: `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`

- [ ] **Step 1: Add a failing concurrent-poller regression for `kill`**

Extend `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` with a test that:

- starts a long-running active job holding the session lock for `session-A`
- polls a second job with `task_type: 'kill'` for `session-A`
- proves the kill job is executed immediately rather than NACKed to `/jobs/<id>/nack`

Expected pre-fix failure: the poller treats `kill` like a normal same-session job and requeues it.

- [ ] **Step 2: Run the concurrent poller test file and confirm failure**

Run: `pnpm vitest run packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`
Expected: FAIL on the new `kill` regression.

- [ ] **Step 3: Modify `TaskPoller` to bypass the session lock for `kill` jobs**

Update `packages/daemon/task/src/task-poller.ts` so:

- `job.task_type === 'kill'` dispatches directly to `executeJob(job)` without calling `sessionLock.acquire()`
- kill jobs are still tracked in `inFlightJobs`
- kill jobs do not add the session to `activeSessions`
- the `finally` path skips `sessionLock.release(job.session_id)` for kill jobs because they never owned the lock

- [ ] **Step 4: Re-run the concurrent poller test file and verify it passes**

Run: `pnpm vitest run packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`
Expected: PASS, including the new regression proving `/kill` is not blocked by the active same-session lock.

### Task 6: Integrate the Registry into the Task Orchestrator and Add Built-in Kill Execution

**Files:**
- Modify: `packages/daemon/task/src/ports/task-executor.ts`
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
- Modify: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Add failing orchestrator tests for kill behavior**

Extend `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` with tests for:

- returning success with `No active process` when a `kill` job finds no registered target
- calling the registered target's `terminate(15000)` for a `kill` job and returning its formatted result
- normalizing `/kill` result `exit_code` to `0` for both no-op and terminated-active-process outcomes
- skipping `jobEnv.setup()` for `kill`, like cleanup/gc

Use a real `ActiveExecutionRegistry` instance or a focused mock; avoid over-mocking the kill path.

- [ ] **Step 2: Run the orchestrator test file and confirm failure**

Run: `pnpm vitest run packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`
Expected: FAIL because the orchestrator does not yet recognize `kill` or pass shared runtime services.

- [ ] **Step 3: Extend the task-executor port with runtime services**

Modify `packages/daemon/task/src/ports/task-executor.ts` so executors can receive shared runtime services, for example:

```ts
export interface ExecutorRuntime {
  activeExecutions: ActiveExecutionRegistry;
}

export interface TaskExecutor {
  execute(job: JobAttempt, env: ExecutionEnvironment, runtime: ExecutorRuntime): Promise<TaskResultSubmission>;
}
```

Keep the interface minimal. Built-in executors may ignore the runtime parameter.

- [ ] **Step 4: Implement built-in kill handling in the orchestrator**

Modify `packages/daemon/task/src/core/task-orchestrator.ts` to:

- own a single `ActiveExecutionRegistry` instance
- branch on `job.task_type === 'kill'` before normal executor iteration
- skip env setup for `kill`
- resolve the active target by `session_id`
- return success with `No active process` if absent
- otherwise call `target.terminate(15_000)` and translate that into a `TaskResultSubmission`
- normalize successful `/kill` results to `exit_code: 0`
- pass the shared runtime into normal executor execution paths

Format the kill `stdout` as a short structured block containing outcome, executor/model, signal path, wait duration, and captured stdout. Put captured stderr in the result `stderr` field.

- [ ] **Step 5: Re-run the orchestrator tests and verify they pass**

Run: `pnpm vitest run packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 6: Run a typecheck gate after the executor-port signature change**

Run: `pnpm -C packages/daemon/task tsc --noEmit`
Expected: PASS, confirming all executor callsites and mocks were updated for the new runtime parameter.

### Task 7: Register Live Children in Each Killable Executor Adapter

**Files:**
- Modify: `packages/daemon/task/src/adapters/claude-executor.ts`
- Modify: `packages/daemon/task/src/adapters/claude-w-executor.ts`
- Modify: `packages/daemon/task/src/adapters/cursor-executor.ts`
- Modify: `packages/daemon/task/src/adapters/ttcodex-executor.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts`

- [ ] **Step 1: Add failing adapter tests for active-child registration**

For each executor test file, add focused tests asserting that:

- `execute()` registers the live child with the runtime registry after spawn
- the registration is removed when the child closes or emits spawn error
- on fallback (`continue` -> fresh), the registry points to the fresh child only after the continue child ends

Use a mock `ExecutorRuntime` with a fake registry or a small spy wrapper around the real registry.

- [ ] **Step 2: Add failing adapter tests for kill metadata**

In at least one representative adapter test file, verify that the registered terminate handle returns:

- signal path `SIGTERM -> exited` when the child closes promptly
- captured stdout/stderr up to kill point

You do not need to re-test the full escalation state machine in every adapter; one end-to-end adapter test plus the shared kill-helper tests is sufficient. The other adapter files can assert registration wiring only.

- [ ] **Step 3: Run the executor adapter tests and confirm failure**

Run: `pnpm vitest run packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts`
Expected: FAIL because executors do not yet accept runtime services or register children.

- [ ] **Step 4: Wire active-child registration into each adapter**

For each adapter:

- accept the new runtime parameter
- preserve the existing spawn/continue/fallback behavior
- accumulate stdout/stderr buffers as today
- immediately after spawn, register an active target with:
  - session ID
  - job/task/executor metadata
  - a terminate function built from the shared kill helper and that adapter's child handle
- on `close` or `error`, unregister only if the registration still refers to that child

Keep kill implementation adapter-local by creating the registration payload in each adapter, but reuse the shared kill helper for the actual `SIGTERM`/`SIGKILL` wait logic.

- [ ] **Step 5: Ensure built-in executors remain non-killable**

Do not register anything from `CleanupExecutor` or built-in gc paths. No code change should make cleanup a kill target.

- [ ] **Step 6: Re-run the adapter tests and verify they pass**

Run: `pnpm vitest run packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts`
Expected: PASS.

### Task 8: Run Focused End-to-End Verification for the New Control Path

**Files:**
- Re-run only; no new files expected unless a gap is found

- [ ] **Step 1: Run the full targeted test slice for `/kill`**

Run:

```bash
pnpm vitest run \
  packages/shared/src/__tests__/routing-errors.test.ts \
  packages/daemon/lark-listener/src/__tests__/message-handler.test.ts \
  packages/api/src/__tests__/routes/tasks.test.ts \
  packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts \
  packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts \
  packages/daemon/task/src/services/__tests__/active-execution-registry.test.ts \
  packages/daemon/task/src/services/__tests__/killable-process.test.ts \
  packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts \
  packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts \
  packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts \
  packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts \
  packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the task-daemon package tests if the targeted slice passes**

Run: `pnpm vitest run packages/daemon/task/src`
Expected: PASS, proving the runtime interface change did not break unrelated task-daemon behavior.

- [ ] **Step 3: Run the task-enrichment package tests if the targeted slice passes**

Run: `pnpm vitest run packages/daemon/task-enrichment/src`
Expected: PASS.

- [ ] **Step 4: Commit the feature in coherent slices**

Suggested commit sequence:

```bash
git add COMMANDS.md packages/shared/ packages/daemon/lark-listener/ packages/api/
git commit -m "feat(commands): add /kill thread control command"

git add packages/daemon/task-enrichment/
git commit -m "feat(enrichment): route kill control tasks"

git add packages/daemon/task/src/services/ packages/daemon/task/src/core/ packages/daemon/task/src/adapters/
git commit -m "feat(task): support killing active executor processes"
```

## Notes for Implementation

- Keep `/kill` success semantics exactly as designed: killing an active process and finding no active process are both successful outcomes.
- Do not echo the original input payload/stdin in kill results; only include captured stdout/stderr up to the kill point.
- Do not make setup hooks killable in this feature.
- Do not cancel queued same-session work in this feature.
- Keep the active-execution registry in-memory inside the task-daemon. Do not repurpose session-lock files or OS PID discovery for `/kill`.
