# Enrichment System Prompt Implementation Plan

**Goal:** Allow enrichment rules to specify an optional `system_prompt` that flows through the full pipeline and is passed to executors as `--append-system-prompt`.

**Architecture:** Add `system_prompt?: string` to the shared types (`JobSubmission`, `Job`, `JobAttempt`), read it from YAML config in `EnrichmentService`, thread it through the API and orchestrator unchanged, and pass it as a CLI flag in both executors.

**Tech Stack:** TypeScript, js-yaml, vitest, Claude Code CLI (`--append-system-prompt`)

---

### Task 1: Add `system_prompt` to Shared Types

**Files:**
- Modify: `packages/shared/src/types.ts:71-107`

- [ ] **Step 1: Add `system_prompt?: string` to `JobSubmission`**

Add the field after `submitted_at`:

```typescript
export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}
```

- [ ] **Step 2: Add `system_prompt?: string` to `Job`**

Add the field after `enriched_at`:

```typescript
export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  enriched_at: string;
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}
```

- [ ] **Step 3: Add `system_prompt?: string` to `JobAttempt`**

Add the field after `enriched_at`:

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
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): add system_prompt to JobSubmission, Job, and JobAttempt types"
```

---

### Task 2: Add `system_prompt` to Enrichment Service

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts:7-14` (interface), `:88-97` (return)

- [ ] **Step 1: Add `system_prompt` to `EnrichmentRule` interface**

```typescript
interface EnrichmentRule {
  executors: Array<{ executor: string; executor_model: string }>;
  system_prompt?: string;
  marketplaces?: Array<{ url: string; plugins: string[] }>;
}
```

- [ ] **Step 2: Thread `system_prompt` through `enrich()` return value**

Add before the `return` statement in `enrich()` (around line 88):

```typescript
const systemPrompt = rule.system_prompt?.trim() || undefined;
```

Then add the field to the returned object:

```typescript
return {
  task_id: task.task_id,
  task_type: task.task_type,
  payload: task.payload,
  executors,
  submitted_at: task.submitted_at,
  ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
  marketplaces: rule.marketplaces,
  ...(task.task_source ? { task_source: task.task_source } : {}),
};
```

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts
git commit -m "feat(enrichment): read system_prompt from rule and include in JobSubmission"
```

---

### Task 3: Add Enrichment Service Tests for `system_prompt`

**Files:**
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Write tests for system_prompt passthrough**

Add a new `describe('system_prompt passthrough')` block after the `task_source passthrough` block (after line 239):

```typescript
describe('system_prompt passthrough', () => {
  it('includes system_prompt in enriched job when rule has one', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        code_review: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          system_prompt: 'You are a code reviewer. Focus on security.',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'code_review' }));

    expect(result).not.toBeNull();
    expect(result!.system_prompt).toBe('You are a code reviewer. Focus on security.');
  });

  it('omits system_prompt when rule has none', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.system_prompt).toBeUndefined();
  });

  it('treats empty string system_prompt as absent', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          system_prompt: '',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.system_prompt).toBeUndefined();
  });

  it('treats whitespace-only system_prompt as absent', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          system_prompt: '   \n  ',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.system_prompt).toBeUndefined();
  });

  it('trims leading/trailing whitespace from system_prompt', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          system_prompt: '  Be concise.  ',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.system_prompt).toBe('Be concise.');
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`

Expected: All tests pass, including the 5 new `system_prompt passthrough` tests.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "test(enrichment): add system_prompt passthrough tests"
```

---

### Task 4: Thread `system_prompt` Through Task Orchestrator

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts:53-63`

- [ ] **Step 1: Add `system_prompt` to `JobAttempt` construction**

In the `handle()` method, add `system_prompt: job.system_prompt` to the attempt object (around line 53-63):

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
  system_prompt: job.system_prompt,
  marketplaces: job.marketplaces,
};
```

- [ ] **Step 2: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts
git commit -m "feat(task-daemon): pass system_prompt from Job to JobAttempt"
```

---

### Task 5: Add `--append-system-prompt` to Claude Code Executor

**Files:**
- Modify: `packages/daemon/task/src/adapters/claude-cli-executor.ts:24-29`

- [ ] **Step 1: Add system prompt flag to args array**

Replace the `args` construction (lines 24-29):

```typescript
const args = [
  '--dangerously-skip-permissions',
  '--model', job.executor_model,
  ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
  ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
  '-p', job.payload,
];
```

- [ ] **Step 2: Commit**

```bash
git add packages/daemon/task/src/adapters/claude-cli-executor.ts
git commit -m "feat(task-daemon): pass --append-system-prompt in Claude Code executor"
```

---

### Task 6: Add `--append-system-prompt` to TTADK Executor

**Files:**
- Modify: `packages/daemon/task/src/adapters/ttadk-executor.ts:24-29`

- [ ] **Step 1: Add system prompt flag to claudeArgs array**

Replace the `claudeArgs` construction (lines 24-29):

```typescript
const claudeArgs = [
  '--bare',
  '--dangerously-skip-permissions',
  ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
  ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
  '-p', job.payload,
].join(' ');
```

- [ ] **Step 2: Commit**

```bash
git add packages/daemon/task/src/adapters/ttadk-executor.ts
git commit -m "feat(task-daemon): pass --append-system-prompt in TTADK executor"
```

---

### Task 7: Add Executor Tests for `--append-system-prompt`

**Files:**
- Create: `packages/daemon/task/src/__tests__/claude-cli-executor.test.ts`
- Create: `packages/daemon/task/src/__tests__/ttadk-executor.test.ts`

- [ ] **Step 1: Write tests for ClaudeCliExecutor system_prompt flag**

Create `packages/daemon/task/src/__tests__/claude-cli-executor.test.ts` with tests that verify:

1. When `system_prompt` is present on the `JobAttempt`, the args array passed to `execFile` includes `['--append-system-prompt', '<the prompt>']` before `-p`.
2. When `system_prompt` is absent/undefined, the args array does NOT contain `--append-system-prompt`.

Mock `node:child_process` `execFile` to capture the args. Use a `JobAttempt` fixture with and without `system_prompt`. Assert on the args array passed to `execFile`.

- [ ] **Step 2: Write tests for TTADKExecutor system_prompt flag**

Create `packages/daemon/task/src/__tests__/ttadk-executor.test.ts` with the same two test cases:

1. When `system_prompt` is present, the joined `claudeArgs` string passed via `-a` includes `--append-system-prompt <prompt>`.
2. When `system_prompt` is absent, `--append-system-prompt` does not appear in the args.

Mock `node:child_process` `execFile` to capture the args.

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd packages/daemon/task && npx vitest run`

Expected: All new and existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/task/src/__tests__/claude-cli-executor.test.ts packages/daemon/task/src/__tests__/ttadk-executor.test.ts
git commit -m "test(task-daemon): add executor tests for --append-system-prompt flag"
```

---

### Task 8: Run Full Test Suite

**Files:**
- Test: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`
- Test: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Test: `packages/daemon/task/src/__tests__/claude-cli-executor.test.ts`
- Test: `packages/daemon/task/src/__tests__/ttadk-executor.test.ts`

- [ ] **Step 1: Run enrichment daemon tests**

Run: `cd packages/daemon/task-enrichment && npx vitest run`

Expected: All tests pass.

- [ ] **Step 2: Run task daemon tests**

Run: `cd packages/daemon/task && npx vitest run`

Expected: All tests pass. The existing `task-poller.test.ts` tests should still pass since `system_prompt` is optional and existing test fixtures don't include it.

- [ ] **Step 3: Run shared package build to verify types compile**

Run: `cd packages/shared && npx tsc --noEmit`

Expected: No type errors.
