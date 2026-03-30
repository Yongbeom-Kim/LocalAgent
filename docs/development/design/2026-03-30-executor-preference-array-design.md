# Executor Preference Array Design

**Date:** 2026-03-30
**Type:** Feature enhancement
**Packages:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/task-enrichment-daemon`, `@local-agent/task-daemon`

## 1. Context

The enrichment system currently maps each `task_type` to a single `{executor, executor_model}` pair via YAML rules. If that executor/model fails, the job fails permanently — there is no fallback.

Current state:
- `enrichment.yaml` defines one `executor` + `executor_model` per rule.
- `EnrichmentService.enrich()` produces a `JobSubmission` with scalar `executor` and `executor_model` fields.
- `JobSubmission` and `Job` types carry scalar `executor`/`executor_model`.
- `TaskOrchestrator.handle()` picks a single executor and runs it once.

The requested change replaces the single executor+model with an ordered array of executor+model pairs (highest to lowest preference), enabling automatic fallback on failure.

## 2. Goal

Replace scalar `executor`/`executor_model` fields with an ordered `executors` array across the enrichment YAML, `JobSubmission`, `Job`, and task-daemon — so that when one executor+model fails, the system automatically tries the next preference until one succeeds or all are exhausted.

## 3. Non-goals

- No changes to task submission (API `POST /tasks` or CLI) — the enrichment layer is the sole source of executor preferences.
- No partial retry or configurable retry policies — any `failure` status triggers fallback.
- No per-attempt result storage — only the final result (first success or last failure) is reported.
- No per-executor marketplace configs — `marketplaces` stays at the rule level.
- No model aliasing, load balancing, or dynamic model discovery.

## 4. User Decisions Captured

- The `executors` array is an **ordered list** (highest to lowest preference) of `{executor, executor_model}` pairs.
- On job failure (any result with `status: 'failure'`), the task-daemon automatically tries the next executor+model in the array.
- All entries in the array are exhausted before the job is marked as failed.
- Each fallback attempt gets a **fresh execution environment** (workDir, plugins).
- Only the **final result** is reported (first success, or the last failure if all exhausted).
- Intermediate failures are logged at **warn** level; final exhaustion at **error** level.
- **Validation:** All `{executor, executor_model}` pairs validated at enrichment time — reject the entire rule if any pair is invalid.
- The `marketplaces` field remains at the **rule level** (shared across all executor entries).
- YAML rules use the `executors` array format, replacing the scalar `executor`/`executor_model` fields.
- The `JobSubmission` and `Job` types replace scalar `executor`/`executor_model` with an `executors` array.
- The API `POST /jobs` and `GET /jobs` endpoints expose the full `executors` array.

## 5. Approaches Considered

### Approach A — Sequential fallback in TaskOrchestrator (selected)

The `TaskOrchestrator.handle()` method receives the full `executors` array from the Job. It iterates through the array, running each executor with a fresh environment. On `failure` status, it logs a warning and tries the next. Returns the first success or the last failure.

**Pros:**
- Minimal new abstractions — extends existing orchestrator loop.
- Fallback logic co-located with execution logic.
- Each attempt gets clean env setup/teardown.
- No new services or polling changes needed.

**Cons:**
- Orchestrator becomes slightly more complex (loop + cleanup per attempt).

### Approach B — FallbackExecutor wrapper

Introduce a `FallbackExecutor` class implementing `TaskExecutor` that wraps concrete executors and iterates through the preference array.

**Pros:**
- Orchestrator stays simple.
- Fallback logic encapsulated and testable in isolation.

**Cons:**
- New class must manage environment lifecycle (currently orchestrator's concern).
- Blurs responsibility between executor and orchestrator layers.

### Approach C — Job-per-attempt via re-enrichment

On failure, the task returns to enrichment, which creates a new Job with the next executor preference.

**Pros:**
- Each attempt is independently trackable.

**Cons:**
- Requires enrichment to track state across attempts.
- Network round-trips per attempt.
- Over-engineered for the use case.

## 6. Recommended Design

Adopt **Approach A** — sequential fallback in TaskOrchestrator.

### 6.1 Shared types (`packages/shared/src/types.ts`)

#### New type: `ExecutorPreference`

```ts
export interface ExecutorPreference {
  executor: TaskExecutorType;
  executor_model: string;
}
```

#### Updated `JobSubmission` and `Job`

Replace scalar `executor`/`executor_model` with `executors` array:

```ts
export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  marketplaces?: MarketplaceConfig[];
}

export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  enriched_at: string;
  marketplaces?: MarketplaceConfig[];
}
```

#### New type: `JobAttempt`

```ts
export interface JobAttempt {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
  enriched_at: string;
  marketplaces?: MarketplaceConfig[];
}
```

Represents a single execution attempt with scalar executor fields. Used by `TaskExecutor.execute()` and constructed by the orchestrator from a `Job` + `ExecutorPreference`.

#### New validation function

```ts
export function isValidExecutorPreferences(
  executors: unknown,
): executors is ExecutorPreference[] {
  if (!Array.isArray(executors) || executors.length === 0) return false;
  return executors.every(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      isTaskExecutorType(e.executor) &&
      isValidExecutorModel(e.executor, e.executor_model),
  );
}
```

Existing `isValidExecutorModel`, `getExecutorModelOptions`, `EXECUTOR_MODELS` remain unchanged — they're still used for per-pair validation.

### 6.2 Enrichment YAML format

Replace:
```yaml
rules:
  default:
    executor: claude_code
    executor_model: sonnet
```

With:
```yaml
rules:
  default:
    executors:
      - executor: claude_code
        executor_model: sonnet
      - executor: ttadk
        executor_model: gpt-5.4
```

Marketplaces remain at rule level:
```yaml
rules:
  code_review:
    executors:
      - executor: claude_code
        executor_model: opus
      - executor: claude_code
        executor_model: sonnet
    marketplaces:
      - url: https://example.com/plugins
        plugins: [linter]
```

### 6.3 EnrichmentService changes

Update `EnrichmentRule` interface:

```ts
interface EnrichmentRule {
  executors: Array<{ executor: string; executor_model: string }>;
  marketplaces?: Array<{ url: string; plugins: string[] }>;
}
```

Update `enrich()` to:
1. Look up rule by `task_type` (or `default`).
2. Validate every `{executor, executor_model}` pair — reject entire task if any is invalid.
3. Return `JobSubmission` with `executors` array (preserving order from YAML).

### 6.4 API changes (`packages/api/src/routes/jobs.ts`)

#### `POST /jobs`

Replace scalar `executor`/`executor_model` validation with `executors` array validation:

```ts
if (!isValidExecutorPreferences(executors)) {
  res.status(400).json({
    error: 'executors must be a non-empty array of valid {executor, executor_model} pairs',
  });
  return;
}
```

Construct `Job` with `executors` array instead of scalar fields.

#### `GET /jobs/next`

No changes needed — returns whatever Job shape is in the queue.

### 6.5 TaskOrchestrator changes

Replace single-executor execution with a fallback loop:

```ts
async handle(job: Job): Promise<TaskResultSubmission> {
  let lastResult: TaskResultSubmission | null = null;

  for (let i = 0; i < job.executors.length; i++) {
    const pref = job.executors[i];
    const isLast = i === job.executors.length - 1;

    let env: ExecutionEnvironment;
    try {
      env = await this.jobEnv.setup(job);
    } catch (error) {
      // env setup failure — hard fail, don't retry
      return { /* failure result */ };
    }

    try {
      const executor = this.resolveExecutor(pref.executor);
      const attempt: JobAttempt = {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        payload: job.payload,
        executor: pref.executor,
        executor_model: pref.executor_model,
        submitted_at: job.submitted_at,
        enriched_at: job.enriched_at,
        marketplaces: job.marketplaces,
      };
      lastResult = await executor.execute(attempt, env);

      if (lastResult.status === 'success') {
        return lastResult;
      }

      if (!isLast) {
        logger.warn({ /* executor, model, attempt */ }, 'Executor failed, trying next preference');
      }
    } catch (error) {
      lastResult = { /* failure result */ };
      if (!isLast) {
        logger.warn({ /* ... */ }, 'Executor threw, trying next preference');
      }
    } finally {
      await this.jobEnv.teardown(env!);
    }
  }

  logger.error({ job_id: job.job_id }, 'All executor preferences exhausted');
  return lastResult!;
}
```

Note: The orchestrator constructs a `JobAttempt` (defined in section 6.1) for each attempt by combining the `Job` fields with the current `ExecutorPreference`'s scalar fields. The `TaskExecutor` interface changes from `execute(job: Job, ...)` to `execute(job: JobAttempt, ...)` (see section 6.6). Executor implementations require only a signature change since `JobAttempt` has the same scalar fields they already use.

#### New helper: `resolveExecutor()`

```ts
private resolveExecutor(executor: TaskExecutorType): TaskExecutor {
  if (executor === 'claude_code') return new ClaudeCliExecutor();
  if (executor === 'ttadk') return new TTADKExecutor();
  throw new Error(`Unknown executor: ${executor}`);
}
```

### 6.6 TaskExecutor port — signature update only

The `TaskExecutor` interface changes its parameter type from `Job` to `JobAttempt`:

```ts
export interface TaskExecutor {
  execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission>;
}
```

Individual executors (`ClaudeCliExecutor`, `TTADKExecutor`) require no logic changes — `JobAttempt` has the same scalar `executor`/`executor_model` fields they already use. Only the import and type annotation change.

### 6.7 Enrichment poller — no changes

The poller POSTs `JobSubmission` to `/jobs`. The shape change (array instead of scalars) is transparent — it just forwards what `EnrichmentService.enrich()` returns.

## 7. File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/types.ts` | Modify | Add `ExecutorPreference`, `JobAttempt` interfaces; add `isValidExecutorPreferences()`; replace `executor`/`executor_model` with `executors` array in `JobSubmission` and `Job` |
| `packages/shared/src/index.ts` | Modify | Re-export `ExecutorPreference`, `JobAttempt`, `isValidExecutorPreferences` |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Update `EnrichmentRule` to use `executors` array; update `enrich()` to validate all pairs and return array |
| `packages/daemon/task-enrichment/config/enrichment.yaml` | Modify | Replace scalar `executor`/`executor_model` with `executors` array |
| `packages/api/src/routes/jobs.ts` | Modify | Replace scalar validation with `isValidExecutorPreferences()`; construct `Job` with `executors` array |
| `packages/daemon/task/src/ports/task-executor.ts` | Modify | Change `execute()` parameter type from `Job` to `JobAttempt` |
| `packages/daemon/task/src/adapters/claude-cli-executor.ts` | Modify | Update `execute()` signature from `Job` to `JobAttempt` (no logic change) |
| `packages/daemon/task/src/adapters/ttadk-executor.ts` | Modify | Update `execute()` signature from `Job` to `JobAttempt` (no logic change) |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Modify | Add fallback loop over `executors` array; construct `JobAttempt` per attempt; extract `resolveExecutor()` helper; fresh env per attempt |
| `packages/daemon/task/src/services/__tests__/job-environment.test.ts` | Modify | Update `Job` test fixtures to use `executors` array instead of scalar fields |
| `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts` | Modify | Update test fixtures from `Job` to `JobAttempt` type (no logic changes) |
| `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts` | Modify | Update test fixtures from `Job` to `JobAttempt` type (no logic changes) |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Modify | Update `Job` test fixtures to use `executors` array |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Update tests for array-based rules and validation |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Modify | Update `JobSubmission` test fixtures to use `executors` array |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Modify | Update `Job`/`JobSubmission` test fixtures to use `executors` array |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Modify | Update tests for `executors` array validation |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Modify | Add tests for fallback behavior: success on first, fallback on failure, all exhausted |

## 8. Test Strategy

### Shared
- `isValidExecutorPreferences()` returns true for valid non-empty arrays.
- `isValidExecutorPreferences()` returns false for empty arrays, non-arrays, and arrays containing invalid pairs.
- Existing `isValidExecutorModel()` tests remain unchanged.

### Enrichment
- `enrich()` returns `JobSubmission` with `executors` array matching YAML order.
- `enrich()` returns null if any executor+model pair in the YAML rule is invalid.
- `enrich()` falls back to `default` rule when task_type not found.
- Marketplaces at rule level are passed through correctly.

### API
- `POST /jobs` succeeds with valid `executors` array.
- `POST /jobs` returns 400 for missing, empty, or invalid `executors`.
- `POST /jobs` response includes `executors` array.

### TaskOrchestrator
- **Happy path:** First executor succeeds — returns success, no fallback.
- **Fallback:** First executor fails, second succeeds — returns success from second.
- **All exhausted:** All executors fail — returns last failure result.
- **Environment:** Each attempt gets fresh `setup()`/`teardown()` cycle.
- **Logging:** Intermediate failures logged at warn; final exhaustion at error.
- **Env setup failure:** Hard fails immediately without trying further executors.

## 9. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking change to `Job`/`JobSubmission` shape | Coordinated deploy of all packages; no external consumers currently |
| Long job execution if many fallbacks | Array length is controlled by YAML config; typically 2-3 entries |
| Intermediate failures mask root cause | Warn-level logs for each intermediate failure preserve diagnostic info |
| Fresh env per attempt increases resource usage | Acceptable trade-off for clean isolation; teardown reclaims resources |
| `TaskExecutor` signature changes from `Job` to `JobAttempt` | Mechanical change; executor logic unchanged since `JobAttempt` has same scalar fields they use |

## 10. Acceptance Criteria

1. YAML enrichment rules use `executors` array format (ordered by preference).
2. `EnrichmentService` validates all pairs and produces `JobSubmission` with `executors` array.
3. `JobSubmission` and `Job` types use `executors: ExecutorPreference[]` instead of scalar fields.
4. API `POST /jobs` validates the `executors` array; `GET /jobs/next` returns it.
5. `TaskOrchestrator` iterates through `executors` array, trying each with fresh env.
6. On `failure` status, orchestrator falls back to next preference (warn log).
7. All executors exhausted produces error log and returns last failure.
8. First success short-circuits — remaining preferences are skipped.
9. `TaskExecutor` interface updated to use `JobAttempt` type; executor implementations require only a signature change (no logic changes).
10. Updated tests cover enrichment, API, and orchestrator fallback scenarios.
