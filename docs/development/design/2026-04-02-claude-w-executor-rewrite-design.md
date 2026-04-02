# Claude-w Executor Rewrite Design

**Date:** 2026-04-02
**Type:** Feature rewrite
**Packages:** `@local-agent/shared`, `@local-agent/task-daemon`, `@local-agent/task-enrichment-daemon`

## 1. Context

The task daemon currently has a dedicated TTADK executor path implemented in `packages/daemon/task/src/adapters/ttadk-executor.ts`. That path currently differs from the Claude executor in one important way: it wraps Claude invocation through the `ttadk` binary instead of directly mirroring the Claude subprocess contract. The rewrite should eliminate that wrapper-specific path and make `claude-w` follow the same high-level session behavior as the Claude executor:

- continue existing workspaces first, then fall back to a fresh session
- pass plugins and optional system prompts through to the subprocess
- require an explicit `executor_model`

Current state:

- `packages/shared/src/types.ts` still defines `ttadk` as a valid executor value.
- `packages/daemon/task/src/adapters/ttadk-executor.ts` invokes the `ttadk` binary.
- `packages/daemon/task/src/core/task-orchestrator.ts` routes `ttadk` jobs to `TTADKExecutor`.
- checked-in enrichment configs such as `packages/daemon/task-enrichment/config/local-agent.yaml` still declare `executor: ttadk`.
- shared model validation still uses TTADK-specific model names such as `glm-5-ttadk` and `glm-4.7-ttadk`.

The requested rewrite removes TTADK entirely and replaces it with a new executor named `claude-w`, backed by the `claude-w` binary from `PATH`. Aside from the binary name and the supported model list, behavior should match the current Claude executor flow, including direct `spawn(...)`, unconditional `--model`, `-p -` with stdin transport, and the existing continue-first then fresh-fallback sequence.

## 2. Goal

Replace the old TTADK executor with a first-class `claude-w` executor across shared types, daemon routing, adapter naming, tests, configs, and docs, while preserving the current Claude-style execution flow and always passing an explicit `--model` flag.

## 3. Non-goals

- No backward compatibility for the `ttadk` executor value.
- No aliasing or migration support for old TTADK model names.
- No custom binary path configuration for `claude-w`.
- No behavioral changes to `claude_code` or `builtin` executors.
- No changes to queueing, ACK/NACK semantics, or executor preference ordering.
- No wrapper-specific prompt transport design beyond matching the current Claude executor subprocess shape.

## 4. User Decisions Captured

- Rename the executor value everywhere from `ttadk` to `claude-w`.
- Remove TTADK completely from shared types, configs, queued job shapes, and docs.
- Hard fail old `ttadk` values after the rewrite; no compatibility layer.
- Invoke the `claude-w` binary from `PATH`.
- Match the current Claude executor subprocess shape: spawn the binary directly, pass arguments as argv, and pipe the prompt over stdin with `-p -`.
- Preserve current continue behavior for existing workspaces: attempt `--continue` first, then fall back to a fresh session.
- Rename the adapter class/file/tests/logging to `claude-w` naming, not TTADK naming.
- Replace checked-in config defaults and fixtures that currently reference `ttadk` or TTADK-only model names.
- Keep normal validation behavior only; no special migration warnings or custom compatibility handling.

## 5. Approaches Considered

### Approach A — Full rename to `claude-w` with Claude-style subprocess flow (recommended)

Rename the executor value and adapter from `ttadk` to `claude-w`, replace the model list, and implement the subprocess behavior by mirroring `ClaudeCliExecutor` while swapping the binary name to `claude-w`.

**Pros**
- Matches the requested clean break.
- Removes stale TTADK terminology from code and docs.
- Keeps execution behavior predictable by reusing the established Claude executor pattern.
- Minimizes design ambiguity for stdin handling, `--continue`, plugins, and system prompt forwarding.

**Cons**
- Requires coordinated changes across shared types, configs, tests, and daemon routing.
- Breaks old `ttadk` configs immediately.

### Approach B — Keep `ttadk` executor value but swap implementation to `claude-w`

Leave `ttadk` in shared types and configs, but change only the implementation behind the adapter.

**Pros**
- Smaller code churn.
- Preserves existing config compatibility.

**Cons**
- Conflicts with the explicit rename request.
- Leaves misleading naming throughout the system.
- Makes future maintenance and debugging less clear.

### Approach C — Add `claude-w` alongside `ttadk`

Introduce `claude-w` as a new executor value while keeping `ttadk` temporarily.

**Pros**
- Supports gradual migration.
- Lower short-term rollout risk.

**Cons**
- Adds migration complexity the user explicitly does not want.
- Requires compatibility logic, duplicated validation, and extra tests.
- Violates YAGNI for the requested clean break.

## 6. Recommended Design

Adopt **Approach A**.

### 6.1 Shared executor type changes

Update `packages/shared/src/types.ts` so the executor set becomes:

```ts
export const TASK_EXECUTORS = ['claude_code', 'claude-w', 'builtin'] as const;
```

Implications:

- `TaskExecutorType` now includes `claude-w` instead of `ttadk`.
- `isTaskExecutorType()` accepts `claude-w` and rejects `ttadk`.
- Any API/job/config validation using shared types automatically hard-fails old executor values.

### 6.2 Shared model validation changes

Replace the `ttadk` entry in `EXECUTOR_MODELS` with the new `claude-w` entry.

Required `claude-w` models:

- `gpt-5.4`
- `gpt-5.3-codex`
- `gpt-5.2-codex`
- `gpt-5.2`
- `glm-5`
- `glm-4.7`
- `kimi-k2.5`
- `minimax-2.5`
- `minimax-2.7`

Resulting shape:

```ts
export const EXECUTOR_MODELS = {
  claude_code: ['opus', 'sonnet', 'haiku'],
  'claude-w': [
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.2-codex',
    'gpt-5.2',
    'glm-5',
    'glm-4.7',
    'kimi-k2.5',
    'minimax-2.5',
    'minimax-2.7',
  ],
  builtin: ['none'],
} as const;
```

No alias map is added.

Implications:

- old TTADK-only model names such as `glm-5-ttadk` and `glm-4.7-ttadk` become invalid everywhere
- normal validation logic remains the only enforcement mechanism
- `claude_code` and `builtin` model lists remain unchanged

### 6.3 Adapter rewrite

Replace `packages/daemon/task/src/adapters/ttadk-executor.ts` with a new adapter named for `claude-w`.

Expected file/class rename:

- `packages/daemon/task/src/adapters/claude-w-executor.ts`
- `ClaudeWExecutor`
- `packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts`

Behavior should mirror `packages/daemon/task/src/adapters/claude-cli-executor.ts`:

- use `spawn`, not shell-joined command strings
- invoke `claude-w` directly
- always include `--dangerously-skip-permissions`
- always include `--model <job.executor_model>`
- pass plugin dirs as repeated `--plugin-dir <dir>` arguments
- include `--append-system-prompt <prompt>` when present
- use `--continue` for existing workspaces on the first attempt
- use `-p -` and write the input to stdin
- capture stdout/stderr, truncate them, and return normal success/failure results
- on `close(code !== 0)`, return failure and allow the orchestrator to try the next preference
- on `error`, return failure with `exit_code: null`

Proposed argv shape:

```ts
const args = [
  '--dangerously-skip-permissions',
  '--model', job.executor_model,
  ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
  ...(job.system_prompt ? ['--append-system-prompt', job.system_prompt] : []),
  ...(options.mode === 'continue' ? ['--continue'] : []),
  '-p', '-',
];

const child = spawn('claude-w', args, { cwd: env.workDir });
```

This intentionally matches the current Claude executor subprocess contract rather than preserving TTADK's old `code -t claude -a ...` wrapper form.

### 6.4 Fresh vs continue behavior

Preserve the existing two-step workspace behavior already used by both current executors:

- if `env.isExistingWorkspace` is `true`, first run with `--continue` and prompt input equal to `job.payload`
- if that attempt succeeds, return immediately
- if it fails, log a warning and retry fresh
- fresh mode uses the current `buildFreshInput()` format:

```text
--- Thread Context ---
<job.history>
--- Current Message ---
<job.payload>
```

This keeps session continuation semantics unchanged during the executor rewrite.

### 6.5 Orchestrator and routing changes

Update `packages/daemon/task/src/core/task-orchestrator.ts` so executor resolution becomes:

```ts
if (executor === 'claude_code') return new ClaudeCliExecutor();
if (executor === 'claude-w') return new ClaudeWExecutor();
if (executor === 'builtin') return new CleanupExecutor();
```

Implications:

- `ttadk` can no longer be resolved
- failed jobs or configs using `ttadk` are rejected by standard validation before execution where possible
- routing logic structure otherwise stays unchanged

### 6.6 Checked-in config updates

Update all checked-in enrichment/config files and fixtures that currently reference `ttadk` or TTADK-specific model names.

Known immediate example:

`packages/daemon/task-enrichment/config/local-agent.yaml`

Current:

```yaml
rules:
  localagent-exec:
    executors:
      - executor: ttadk
        executor_model: gpt-5.4
```

Updated:

```yaml
rules:
  localagent-exec:
    executors:
      - executor: claude-w
        executor_model: gpt-5.4
```

Any checked-in tests/fixtures using `glm-5-ttadk`, `glm-4.7-ttadk`, or `executor: ttadk` must be updated to valid `claude-w` values.

### 6.7 Docs and naming cleanup

Update human-facing docs only where they function as current source-of-truth for executor architecture or checked-in examples that engineers are likely to copy during implementation.

At minimum:

- this design doc
- any checked-in docs that explicitly define the current executor set or show active example configs
- any human-facing references in tests/loggers/comments touched by the rewrite

Historical design/plan docs may keep TTADK references when they are describing past decisions rather than current architecture; they only need edits if they would mislead implementation of this rewrite.

The goal is to avoid a mixed state where runtime code says `claude-w` but current guidance still instructs people to use `ttadk`, without forcing a repo-wide rewrite of archival documents.

## 7. File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/types.ts` | Modify | Replace `ttadk` with `claude-w` in executor union and model map |
| `packages/shared/src/__tests__/types.test.ts` | Modify | Update executor/model validation tests for `claude-w` and rejection of old TTADK values |
| `packages/daemon/task/src/adapters/ttadk-executor.ts` | Delete/replace | Remove old TTADK adapter |
| `packages/daemon/task/src/adapters/claude-w-executor.ts` | Create | New adapter that mirrors Claude CLI behavior with binary `claude-w` |
| `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts` | Delete/replace | Remove old TTADK adapter test |
| `packages/daemon/task/src/adapters/__tests__/claude-w-executor.test.ts` | Create | Verify `claude-w` spawn args, stdin piping, continue flow, plugin/system prompt forwarding, and failures |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Modify | Route `claude-w` to `ClaudeWExecutor` |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Modify | Update fixtures and routing expectations from `ttadk` to `claude-w` |
| `packages/daemon/task-enrichment/config/local-agent.yaml` | Modify | Replace `executor: ttadk` with `executor: claude-w` |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Update expected validated executor/model values |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Modify | Update any stored executor fixtures from `ttadk` to `claude-w` |
| current source-of-truth docs under `docs/development/design/` and `docs/development/plans/` | Modify selectively | Remove stale TTADK references only where they describe active executor architecture or copy-pasteable configs |

## 8. Test Strategy

### Shared
- `isTaskExecutorType('claude-w')` returns true.
- `isTaskExecutorType('ttadk')` returns false.
- `isValidExecutorModel('claude-w', <new model>)` succeeds for every allowed value.
- `isValidExecutorModel('claude-w', 'glm-5-ttadk')` fails.
- `isValidExecutorPreferences()` accepts `claude-w` entries and rejects old TTADK entries.

### Daemon adapter
- `ClaudeWExecutor` spawns `claude-w`, not `ttadk`.
- Spawned args always include `--dangerously-skip-permissions` and `--model <executor_model>`.
- Prompt is sent via stdin using `-p -`.
- `--plugin-dir` flags are forwarded exactly.
- `--append-system-prompt` is forwarded when provided.
- Existing workspaces use `--continue` first.
- Failed continue attempts fall back to fresh mode.
- Success/non-zero exit/spawn error/empty payload all return the expected `TaskResultSubmission` shape.

### Orchestrator
- `claude-w` preference resolves to `ClaudeWExecutor`.
- `ttadk` no longer resolves.
- Multi-preference fallback still works when `claude-w` appears in the array.

### Enrichment/config integration
- checked-in YAML rules with `claude-w` validate successfully.
- checked-in YAML rules with `ttadk` fail validation after the rewrite.
- updated config fixtures use only valid `claude-w` model names.

## 9. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Old checked-in fixtures still use `ttadk` and break tests unexpectedly | Update all repo configs/tests in the same change set |
| Partial rename leaves stale imports/class names | Rename file, class, test file, and orchestrator references together |
| `claude-w` wrapper differs subtly from Claude CLI input expectations | Intentionally mirror the established Claude subprocess contract and verify with adapter tests |
| Missing `--model` causes wrapper defaults to drift | Always pass `--model` unconditionally in `ClaudeWExecutor` |
| Docs remain inconsistent with runtime behavior | Update the current-source-of-truth docs touched by executor architecture |

## 10. Acceptance Criteria

1. `TaskExecutorType` contains `claude-w` and no longer contains `ttadk`.
2. Shared validation accepts only the new `claude-w` model list for that executor.
3. Old executor value `ttadk` is rejected by normal validation logic.
4. Old TTADK-only model names are rejected by normal validation logic.
5. The daemon routes `claude-w` jobs to a renamed `ClaudeWExecutor`.
6. `ClaudeWExecutor` invokes `claude-w` from `PATH` using the same subprocess pattern as `ClaudeCliExecutor`.
7. `ClaudeWExecutor` always passes `--model <job.executor_model>`.
8. Continue-first then fresh-fallback behavior remains intact for existing workspaces.
9. Checked-in configs/tests/docs no longer use `ttadk` as a current executor.
10. Updated tests cover shared validation, adapter behavior, routing, and checked-in config expectations.
