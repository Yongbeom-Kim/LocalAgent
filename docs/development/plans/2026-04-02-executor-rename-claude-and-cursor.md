# Executor Rename to `claude` and `cursor` Implementation Plan

**Goal:** Rename the executor contract from `claude_code`/`cursor_agent` to `claude`/`cursor` across active code paths, internal adapter names, tests, config, and current docs, with no backward-compatibility aliases.

**Architecture:** Treat `@local-agent/shared` as the contract pivot: once the canonical executor literals change there, downstream packages should either continue working through shared validation or be updated where they still hard-code old values or old symbol names. The task daemon gets a real internal rename for adapter files/classes/loggers, while the rest of the repo mostly follows via fixture updates, config changes, and targeted historical-doc notes.

**Assumptions (per design §9.9):** No DB or queue migrations; in-flight or stored payloads with old executor strings may fail validation after deploy, which is acceptable. No migration task.

**Tech Stack:** TypeScript, Vitest, Express, Lark integrations, Rush monorepo

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/shared/src/types.ts` | Rename `TaskExecutorType` literals and `EXECUTOR_MODELS` keys to `claude` / `cursor` |
| Modify | `packages/shared/src/__tests__/types.test.ts` | Update allowlist, validation, and helper coverage to the renamed literals |
| Rename | `packages/daemon/task/src/adapters/claude-cli-executor.ts` -> `packages/daemon/task/src/adapters/claude-executor.ts` | Rename file/class/logger/messages to `ClaudeExecutor` |
| Rename | `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts` -> `packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts` | Rename imports/describes and keep subprocess behavior coverage |
| Rename | `packages/daemon/task/src/adapters/cursor-agent-executor.ts` -> `packages/daemon/task/src/adapters/cursor-executor.ts` | Rename file/class/logger/messages to `CursorExecutor` |
| Rename | `packages/daemon/task/src/adapters/__tests__/cursor-agent-executor.test.ts` -> `packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts` | Rename imports/describes and keep subprocess behavior coverage |
| Modify | `packages/daemon/task/src/core/task-orchestrator.ts` | Update imports, executor routing literals, and class references |
| Modify | `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Update mocks, imports, and expected executor literals |
| Modify | `packages/daemon/task/src/__tests__/task-poller.test.ts` | Update posted executor/result expectations |
| Modify | `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts` | Update mocked adapter import paths if needed after file renames |
| Modify | `packages/daemon/task/src/services/__tests__/gc-executor.test.ts` | Update executor fixtures |
| Modify | `packages/daemon/task-enrichment/config/enrichment.yaml` | Switch default executor literals to `claude` |
| Modify | `packages/daemon/task-enrichment/config/local-agent.yaml` | Same executor literal renames as enrichment defaults |
| Modify | `packages/daemon/task-enrichment/config/byted.local.yaml` | Same executor literal renames as enrichment defaults |
| Modify | `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Replace hard-coded GC executor literal with `claude` |
| Modify | `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Update explicit `/new` and inherited executor expectations |
| Modify | `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts` | Update inherited metadata fixtures/expectations to `claude` / `cursor` |
| Modify | `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Update YAML fixtures and executor arrays |
| Modify | `packages/api/src/__tests__/routes/jobs.test.ts` | Update accepted/rejected executor payloads |
| Modify | `packages/api/src/__tests__/routes/results.test.ts` | Update result executor expectations |
| Modify | `packages/api/src/__tests__/services/rabbitmq.test.ts` | Update queue fixtures that still use old executor names |
| Modify | `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Update `/new cursor ...` and `/new claude ...` expectations |
| Modify | `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts` | Update visible `executor:` line expectations |
| Modify | `docs/development/design/2026-04-02-cursor-agent-executor-design.md` | Add short superseded note pointing to the new rename design/plan |
| Modify | `docs/development/plans/2026-04-02-cursor-agent-executor.md` | Add short superseded note pointing to the new rename design/plan |
| Modify | `docs/development/design/2026-04-02-cursor-agent-model-selection-design.md` | Add short note that current executor naming now uses `cursor` |
| Modify | `docs/development/plans/2026-04-02-cursor-agent-model-selection.md` | Add short note pointing to the new rename design/plan |
| Modify | `docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md` | Add short note pointing to the new rename design/plan |
| Modify | `docs/development/plans/2026-04-02-new-instance-executor-model-inheritance.md` | Add short note pointing to the new rename design/plan |

---

### Task 1: Rename the Shared Executor Contract

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing shared tests**

Update **every** occurrence in `packages/shared/src/__tests__/types.test.ts` (not only the snippets below): rename `claude_code` → `claude` and `cursor_agent` → `cursor` in fixtures, `getExecutorModelOptions` cases, `isValidExecutorPreferences`, `MarketplaceConfig` job samples, `TaskResultSubmission` shape tests, and the cursor static-allowlist comment tied to `CURSOR_AGENT_MODELS_EXPECTED` (keep the constant name or rename it—either way, point it at `EXECUTOR_MODELS.cursor`). Import `isTaskExecutorType` from `../types` and add or extend coverage so legacy strings are rejected:

```ts
it('rejects legacy executor names', () => {
  expect(isTaskExecutorType('claude_code')).toBe(false);
  expect(isTaskExecutorType('cursor_agent')).toBe(false);
});
```

Representative updates (apply the same pattern across the rest of the file):

```ts
it('defines claude models', () => {
  expect(EXECUTOR_MODELS.claude).toEqual(['opus', 'sonnet', 'haiku']);
});

it('defines cursor static allowlist', () => {
  expect(EXECUTOR_MODELS.cursor).toEqual(CURSOR_AGENT_MODELS_EXPECTED);
});

it('returns comma-separated list for cursor', () => {
  expect(getExecutorModelOptions('cursor')).toBe(EXECUTOR_MODELS.cursor.join(', '));
});
```

- [ ] **Step 2: Run the shared tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`

Expected: FAIL because `types.ts` still exposes `claude_code` and `cursor_agent`.

- [ ] **Step 3: Implement the contract rename in `types.ts`**

Update `packages/shared/src/types.ts`:

```ts
export const TASK_EXECUTORS = ['claude', 'claude-w', 'builtin', 'cursor'] as const;

export const EXECUTOR_MODELS = {
  claude: ['opus', 'sonnet', 'haiku'],
  'claude-w': [/* unchanged list */],
  builtin: ['none'],
  cursor: [/* unchanged cursor model allowlist */],
} as const satisfies Record<TaskExecutorType, readonly string[]>;
```

Keep helper signatures unchanged. Only rename the canonical literals and keys.

- [ ] **Step 4: Re-run the shared tests**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): rename executors to claude and cursor"
```

---

### Task 2: Rename Task-Daemon Adapters and Routing

**Files:**
- Rename: `packages/daemon/task/src/adapters/claude-cli-executor.ts` -> `packages/daemon/task/src/adapters/claude-executor.ts`
- Rename: `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts` -> `packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts`
- Rename: `packages/daemon/task/src/adapters/cursor-agent-executor.ts` -> `packages/daemon/task/src/adapters/cursor-executor.ts`
- Rename: `packages/daemon/task/src/adapters/__tests__/cursor-agent-executor.test.ts` -> `packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts`
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
- Modify: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`
- Modify: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Modify: `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`
- Modify: `packages/daemon/task/src/services/__tests__/gc-executor.test.ts`

- [ ] **Step 1: Write the failing task-daemon test updates**

Update `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`:

```ts
vi.mock('../../adapters/claude-executor', () => ({
  ClaudeExecutor: vi.fn(function (this: { execute: typeof mockClaudeExecute }) {
    this.execute = mockClaudeExecute;
  }),
}));

vi.mock('../../adapters/cursor-executor', () => ({
  CursorExecutor: vi.fn(function (this: { execute: typeof mockCursorExecute }) {
    this.execute = mockCursorExecute;
  }),
}));

it('returns TaskResultSubmission from ClaudeExecutor for claude jobs', async () => {
  const result = await orchestrator.handle(createJob({
    executors: [{ executor: 'claude', executor_model: 'opus' }],
  }));

  expect(ClaudeExecutor).toHaveBeenCalledTimes(1);
  expect(result.executor).toBe('claude');
});

it('returns TaskResultSubmission from CursorExecutor for cursor jobs', async () => {
  const result = await orchestrator.handle(createJob({
    executors: [{ executor: 'cursor', executor_model: 'auto' }],
  }));

  expect(CursorExecutor).toHaveBeenCalledTimes(1);
  expect(result.executor).toBe('cursor');
});
```

Update the renamed adapter tests so they instantiate `ClaudeExecutor` / `CursorExecutor` and still assert the same spawn behavior.

Also update `packages/daemon/task/src/__tests__/task-poller.test.ts` and `packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts`: change `vi.mock` targets and imports from `../adapters/claude-cli-executor` / `ClaudeCliExecutor` to `../adapters/claude-executor` / `ClaudeExecutor` (and executor string literals in job fixtures if present).

- [ ] **Step 2: Run the focused task-daemon suites to verify they fail**

Run: `cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts src/adapters/__tests__/claude-cli-executor.test.ts src/adapters/__tests__/cursor-agent-executor.test.ts src/__tests__/task-poller.test.ts`

Expected: FAIL because imports, filenames, class names, and executor literals still use the old names.

- [ ] **Step 3: Rename the adapter files and symbols**

Rename files, then update class names, logger namespaces, and human-readable log strings.

In `packages/daemon/task/src/adapters/claude-executor.ts`:

```ts
const logger = createLogger('task-daemon:claude');

export class ClaudeExecutor implements TaskExecutor {
  async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning Claude');
    // existing spawn('claude', ...) behavior unchanged
  }
}
```

In `packages/daemon/task/src/adapters/cursor-executor.ts`:

```ts
const logger = createLogger('task-daemon:cursor');

export class CursorExecutor implements TaskExecutor {
  async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning Cursor');
    // existing spawn('agent', ...) behavior unchanged
  }
}
```

Across both adapter files, replace **all** human-readable log strings that still use legacy product wording (`Claude Code`, `Cursor agent`, `cursor_agent` in messages, etc.) with terminology from design §9.6—e.g. continuation/failure/success/spawn lines and the plugin-directory debug message—not only the `Spawning …` lines shown above.

In `packages/daemon/task/src/core/task-orchestrator.ts`, update imports and routing:

```ts
import { ClaudeExecutor } from '../adapters/claude-executor';
import { CursorExecutor } from '../adapters/cursor-executor';

private resolveExecutor(executor: TaskExecutorType): TaskExecutor {
  if (executor === 'claude') return new ClaudeExecutor();
  if (executor === 'claude-w') return new ClaudeWExecutor();
  if (executor === 'builtin') return new CleanupExecutor();
  if (executor === 'cursor') return new CursorExecutor();
  throw new Error(`Unknown executor: ${executor}`);
}
```

Update all daemon tests and fixtures in this task to the renamed file paths and literals.

- [ ] **Step 4: Re-run the focused task-daemon suites**

Run: `cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts src/adapters/__tests__/claude-executor.test.ts src/adapters/__tests__/cursor-executor.test.ts src/__tests__/task-poller.test.ts src/__tests__/task-poller-concurrent.test.ts src/services/__tests__/gc-executor.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/adapters/claude-executor.ts packages/daemon/task/src/adapters/__tests__/claude-executor.test.ts packages/daemon/task/src/adapters/cursor-executor.ts packages/daemon/task/src/adapters/__tests__/cursor-executor.test.ts packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts packages/daemon/task/src/__tests__/task-poller.test.ts packages/daemon/task/src/__tests__/task-poller-concurrent.test.ts packages/daemon/task/src/services/__tests__/gc-executor.test.ts
git add -u packages/daemon/task/src/adapters/claude-cli-executor.ts packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts packages/daemon/task/src/adapters/cursor-agent-executor.ts packages/daemon/task/src/adapters/__tests__/cursor-agent-executor.test.ts
git commit -m "refactor(task-daemon): rename claude and cursor executors"
```

---

### Task 3: Update Enrichment, API, and Thread-Context Fallout

**Files:**
- Modify: `packages/daemon/task-enrichment/config/enrichment.yaml`
- Modify: `packages/daemon/task-enrichment/config/local-agent.yaml`
- Modify: `packages/daemon/task-enrichment/config/byted.local.yaml`
- Modify: `packages/daemon/task-enrichment/src/enrichment-poller.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`
- Modify: `packages/api/src/__tests__/routes/jobs.test.ts`
- Modify: `packages/api/src/__tests__/routes/results.test.ts`
- Modify: `packages/api/src/__tests__/services/rabbitmq.test.ts`

- [ ] **Step 1: Write the failing integration-facing test updates**

Update executor fixtures in the impacted tests:

```ts
executors: [{ executor: 'claude', executor_model: 'sonnet' }]
executors: [{ executor: 'cursor', executor_model: 'gpt-5.4-medium-fast' }]
```

Add/adjust explicit expectations that old names are now invalid at the shared-validation boundary (jobs route):

```ts
it('returns 400 when executors use legacy executor names', async () => {
  const res = await request(buildApp()).post('/jobs').send({
    ...validSubmission,
    executors: [{ executor: 'cursor_agent', executor_model: 'auto' }],
  });

  expect(res.status).toBe(400);
});
```

Mirror the same idea in `results.test.ts` if the route validates `executor` / `executor_model` through shared helpers: success-path payloads should use `claude` / `cursor`, and legacy executor strings should yield `400` where the design requires rejection.

In `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts`, update inherited metadata fixtures:

```ts
text: 'executor: claude\nmodel: sonnet\nJob old'
text: 'executor: cursor\nmodel: gpt-5.4-medium-fast\nJob new'
expect(result!.inheritedExecutor).toBe('cursor');
```

- [ ] **Step 2: Run the focused enrichment and API suites to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts src/__tests__/thread-context-fetcher.test.ts src/__tests__/enrichment-service.test.ts`

Run: `cd packages/api && npx vitest run src/__tests__/routes/jobs.test.ts src/__tests__/routes/results.test.ts src/__tests__/services/rabbitmq.test.ts`

Expected: FAIL because fixtures, YAML, and at least one hard-coded executor literal still use the old names.

- [ ] **Step 3: Update config, literals, and fixtures**

In `packages/daemon/task-enrichment/config/enrichment.yaml`, `local-agent.yaml`, and `byted.local.yaml`, replace every `executor: claude_code` (and any `cursor_agent` if present) with `claude` / `cursor` so checked-in defaults match the shared contract. Example shape for `enrichment.yaml`:

```yaml
rules:
  generic:
    executors:
      - executor: claude
        executor_model: sonnet

  new_instance:
    executors:
      - executor: claude
        executor_model: sonnet
```

In `packages/daemon/task-enrichment/src/enrichment-poller.ts`, update the GC fallback literal:

```ts
executors: [{ executor: 'claude', executor_model: 'sonnet' }],
```

Do not add compatibility logic to `ThreadContextFetcher` or `/new` parsing. Their validation should continue to flow through the renamed shared contract.

For `thread-context-fetcher.test.ts`: where a case depended on inheriting from `executor: claude_code` or `executor: cursor_agent`, update the metadata lines to `executor: claude` or `executor: cursor` if the scenario is “valid inheritance,” or change expectations so legacy lines no longer produce a valid inherited executor (per design §9.5—old labels stop validating).

- [ ] **Step 4: Re-run the focused enrichment and API suites**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts src/__tests__/thread-context-fetcher.test.ts src/__tests__/enrichment-service.test.ts`

Run: `cd packages/api && npx vitest run src/__tests__/routes/jobs.test.ts src/__tests__/routes/results.test.ts src/__tests__/services/rabbitmq.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/config/enrichment.yaml packages/daemon/task-enrichment/config/local-agent.yaml packages/daemon/task-enrichment/config/byted.local.yaml packages/daemon/task-enrichment/src/enrichment-poller.ts packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts packages/api/src/__tests__/routes/jobs.test.ts packages/api/src/__tests__/routes/results.test.ts packages/api/src/__tests__/services/rabbitmq.test.ts
git commit -m "feat(contract): apply claude and cursor executor names"
```

---

### Task 4: Update Listener and Notifier User-Facing Surfaces

**Files:**
- Modify: `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts`
- Modify: `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`

- [ ] **Step 1: Write the failing user-surface test updates**

Update **all** fixtures in `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` that still use `cursor_agent` or `claude_code` in `/new` text or expected submit payloads (not only one case). Example for a cursor success path:

```ts
content: JSON.stringify({ text: '/new cursor gpt-5.4-medium-fast' })

expect(submitter.submit).toHaveBeenCalledWith(
  'new_instance',
  JSON.stringify({
    executor: 'cursor',
    executor_model: 'gpt-5.4-medium-fast',
  }),
  { source: 'lark', message_id: 'om_msg1' },
);
```

Update every notifier expectation in `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts` that asserts `executor:` lines or payload executor fields. Example:

```ts
await notifier.notify(createResult({
  executor: 'cursor',
  executor_model: 'gpt-5.4-medium-fast',
}));

expect(content.text).toContain('executor: cursor');
```

- [ ] **Step 2: Run the focused listener/notifier suites to verify they fail**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`

Run: `cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts`

Expected: FAIL because test fixtures still expect the old names.

- [ ] **Step 3: Update the fixtures only**

Keep implementation unchanged unless a test reveals a hard-coded old string outside fixtures. The parser and notifier should already use the executor values passed through the shared contract/result objects.

- [ ] **Step 4: Re-run the focused listener/notifier suites**

Run: `cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts`

Run: `cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/lark-listener/src/__tests__/message-handler.test.ts packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts
git commit -m "test: update user-facing executor naming to claude and cursor"
```

---

### Task 5: Add Superseded Links to Relevant Historical Docs

**Files:**
- Modify: `docs/development/design/2026-04-02-cursor-agent-executor-design.md`
- Modify: `docs/development/plans/2026-04-02-cursor-agent-executor.md`
- Modify: `docs/development/design/2026-04-02-cursor-agent-model-selection-design.md`
- Modify: `docs/development/plans/2026-04-02-cursor-agent-model-selection.md`
- Modify: `docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md`
- Modify: `docs/development/plans/2026-04-02-new-instance-executor-model-inheritance.md`

- [ ] **Step 1: Add short superseded notes at the top of each doc**

Use a brief note like:

```md
> **Naming note:** The current executor naming contract now uses `claude` and `cursor`. For the live rename spec, see `docs/development/design/2026-04-02-executor-rename-claude-and-cursor-design.md` and `docs/development/plans/2026-04-02-executor-rename-claude-and-cursor.md`.
```

Do not rewrite the historical content. Keep the docs append-only.

- [ ] **Step 2: Verify the notes are present and narrow**

Run: `rg "executor-rename-claude-and-cursor" docs/development/design docs/development/plans`

Expected: hits in the six targeted historical docs plus the new design/plan.

- [ ] **Step 3: Commit**

```bash
git add docs/development/design/2026-04-02-cursor-agent-executor-design.md docs/development/plans/2026-04-02-cursor-agent-executor.md docs/development/design/2026-04-02-cursor-agent-model-selection-design.md docs/development/plans/2026-04-02-cursor-agent-model-selection.md docs/development/design/2026-04-02-new-instance-executor-model-inheritance-design.md docs/development/plans/2026-04-02-new-instance-executor-model-inheritance.md
git commit -m "docs: link old executor specs to renamed contract"
```

---

### Task 6: Final Targeted Verification Sweep

**Files:**
- Verify only: all files above

- [ ] **Step 1: Run the targeted impacted suites**

Run:

```bash
cd packages/shared && npx vitest run src/__tests__/types.test.ts
cd packages/api && npx vitest run src/__tests__/routes/jobs.test.ts src/__tests__/routes/results.test.ts src/__tests__/services/rabbitmq.test.ts
cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts src/adapters/__tests__/claude-executor.test.ts src/adapters/__tests__/cursor-executor.test.ts src/__tests__/task-poller.test.ts src/__tests__/task-poller-concurrent.test.ts src/services/__tests__/gc-executor.test.ts
cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts src/__tests__/thread-context-fetcher.test.ts src/__tests__/enrichment-service.test.ts
cd packages/daemon/lark-listener && npx vitest run src/__tests__/message-handler.test.ts
cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts
```

Expected: PASS

- [ ] **Step 2: Search for remaining active legacy references**

Run:

```bash
rg "claude_code|cursor_agent|ClaudeCliExecutor|CursorAgentExecutor|claude-cli|cursor-agent" packages docs/development
```

Confirm **non-test** API routes still rely on shared validation only (no hard-coded legacy executor strings):

```bash
rg "claude_code|cursor_agent" packages/api/src --glob '!**/__tests__/**'
```

Expected: no matches in application code; only intended historical-doc references under `docs/development`, each with a superseded/naming note nearby.

- [ ] **Step 3: If test or search fallout appears, fix it before merge**

Common follow-ups to check:

- stale mock paths after file renames
- overlooked hard-coded executor literals in tests
- old logger namespace assertions
- active docs that still present old names as current behavior

- [ ] **Step 4: Final commit if follow-up fixes were required**

```bash
git add -A
git commit -m "test: resolve executor rename fallout"
```
