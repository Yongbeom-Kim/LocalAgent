# Design: Enrichment System Prompt

**Date:** 2026-03-31
**Status:** Draft

## Problem

The enrichment daemon transforms tasks into job submissions with executor preferences and marketplace configs, but there is no way to customize the system prompt given to the agent. All tasks use the executor's default system prompt regardless of task type, making it impossible to give task-type-specific instructions (e.g., "You are a code reviewer. Focus on security issues.") without embedding them in the user payload.

## Goal

Allow each enrichment rule in the YAML config to specify an optional `system_prompt` string that is threaded through the full pipeline and passed to the executor as an `--append-system-prompt` flag. This gives operators per-task-type control over agent behavior without modifying the user's payload.

## Constraints & Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Prompt mode | Append to default | Preserves Claude's built-in behavior; uses `--append-system-prompt` flag |
| Prompt source | Inline in YAML | Simple; avoids file-reference complexity |
| Scope | Per-rule only | Different task types need different prompts; no global prompt needed |
| Required? | Optional | Rules without `system_prompt` work exactly as today |
| Empty handling | Treated as no prompt | Empty string or whitespace-only is silently ignored |
| Templating | None | Static string; keep it simple |
| Length limit | None | Trust the config author |
| API input | Config-only | `system_prompt` is set by enrichment from YAML, not accepted from external API callers |
| Observability | Visible in GET responses | `system_prompt` is returned in job details for debugging |
| Executor scope | Both claude_code and ttadk | Both wrap Claude underneath and support the flag |
| Data flow | Full pipeline | `system_prompt` flows through `JobSubmission` → `Job` → `JobAttempt` → executor |

## Design

### YAML Config Schema

The `system_prompt` field is added to `EnrichmentRule`:

```yaml
rules:
  code_review:
    system_prompt: |
      You are a code reviewer. Focus on security vulnerabilities,
      performance issues, and correctness. Be concise.
    executors:
      - executor: claude_code
        executor_model: sonnet

  default:
    executors:
      - executor: claude_code
        executor_model: sonnet
```

Rules without `system_prompt` (like `default` above) work exactly as before.

### Shared Types (`packages/shared/src/types.ts`)

Add `system_prompt?: string` to `JobSubmission`, `Job`, and `JobAttempt`:

```typescript
export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  system_prompt?: string;       // NEW
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
}

export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  enriched_at: string;
  system_prompt?: string;       // NEW
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
}

export interface JobAttempt {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
  enriched_at: string;
  system_prompt?: string;       // NEW
  marketplaces?: MarketplaceConfig[];
}
```

### Enrichment Service (`enrichment-service.ts`)

The `EnrichmentRule` interface gains `system_prompt?: string`. The `enrich()` method copies it to the `JobSubmission` if present and non-empty:

```typescript
interface EnrichmentRule {
  executors: Array<{ executor: string; executor_model: string }>;
  system_prompt?: string;     // NEW
  marketplaces?: Array<{ url: string; plugins: string[] }>;
}
```

In `enrich()`:

```typescript
const systemPrompt = rule.system_prompt?.trim() || undefined;

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

Empty or whitespace-only `system_prompt` is silently ignored (treated as absent).

### API Layer

The API routes for jobs (`POST /jobs`, `GET /jobs/next`) already pass through all fields from the request body / database. Since `system_prompt` is an optional string field:

- **POST /jobs**: The field flows through from the enrichment daemon's `JobSubmission`. No special validation needed beyond existing JSON handling. The API does not accept `system_prompt` from external callers — it's only set by the enrichment daemon.
- **GET /jobs/next**: Returns the full `Job` object including `system_prompt` if present.
- **Job storage**: The in-memory queue or database stores it as part of the job record.

### Task Orchestrator

The `TaskOrchestrator` already copies fields from `Job` to `JobAttempt`. It needs to include `system_prompt`:

```typescript
const attempt: JobAttempt = {
  job_id: job.job_id,
  task_id: job.task_id,
  task_type: job.task_type,
  payload: job.payload,
  executor: selected.executor,
  executor_model: selected.executor_model,
  submitted_at: job.submitted_at,
  enriched_at: job.enriched_at,
  system_prompt: job.system_prompt,   // NEW
  marketplaces: job.marketplaces,
};
```

### Claude Code Executor (`claude-cli-executor.ts`)

Add `--append-system-prompt` to the args when `system_prompt` is present:

```typescript
const args = [
  '--dangerously-skip-permissions',
  '--model', job.executor_model,
  ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
  ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
  '-p', job.payload,
];
```

### TTADK Executor (`ttadk-executor.ts`)

Same pattern — append `--append-system-prompt` to the Claude args string:

```typescript
const claudeArgs = [
  '--bare',
  '--dangerously-skip-permissions',
  ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
  ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
  '-p', job.payload,
].join(' ');
```

## Data Flow

```
enrichment.yaml          EnrichmentService         API            TaskOrchestrator      Executor
─────────────────────────────────────────────────────────────────────────────────────────────────
system_prompt: "..."  →  JobSubmission.system_prompt  →  Job.system_prompt  →  JobAttempt.system_prompt  →  --append-system-prompt "..."
(optional)               (optional)                     (stored)              (copied)                     (CLI flag)
```

## Files Changed

| File | Change |
|------|--------|
| `packages/shared/src/types.ts` | Add `system_prompt?: string` to `JobSubmission`, `Job`, `JobAttempt` |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Add `system_prompt` to `EnrichmentRule` interface; copy trimmed value to `JobSubmission` in `enrich()` |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Tests: system_prompt flows through, empty/whitespace ignored, absent = no field |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Pass `system_prompt` from `Job` to `JobAttempt` |
| `packages/daemon/task/src/adapters/claude-cli-executor.ts` | Add `--append-system-prompt` flag when `system_prompt` present |
| `packages/daemon/task/src/adapters/ttadk-executor.ts` | Add `--append-system-prompt` flag when `system_prompt` present |
| `packages/daemon/task/src/__tests__/claude-cli-executor.test.ts` | Test: system_prompt adds flag; absent = no flag |
| `packages/daemon/task/src/__tests__/ttadk-executor.test.ts` | Test: system_prompt adds flag; absent = no flag |
| `packages/daemon/task-enrichment/config/enrichment.yaml` | No change required (field is optional) |

## Out of Scope

- File-based system prompts (`system_prompt_file`) — can be added later if needed
- Global system prompt shared across all rules — per-rule is sufficient
- Variable interpolation / templating in prompts — static strings only
- Replacing the default system prompt (`--system-prompt`) — append-only for safety
- API-side validation preventing external callers from setting `system_prompt` — this is a trusted internal API
