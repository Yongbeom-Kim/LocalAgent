# Cursor Agent CLI executor

**Date:** 2026-04-02  
**Status:** Reviewed (approve with changes incorporated below)  
**Packages:** `@local-agent/shared`, `@local-agent/task-daemon` (primary); optional later: `@local-agent/task-enrichment-daemon` (YAML examples)

## Problem

The task daemon runs coding agents via pluggable executors (`claude_code`, `claude-w`, `builtin`). Operators who standardize on [Cursor’s `agent` CLI](https://cursor.com/docs/cli/overview) cannot select it in `ExecutorPreference` / enrichment rules today.

## Goals

- Add a new `TaskExecutorType` value that spawns the `agent` binary in **headless / scriptable** mode, consistent with existing executors (capture stdout/stderr, exit code → `TaskResultSubmission`).
- Reuse the same **session workspace** semantics as other agents: `JobEnvironment` supplies `workDir`; reuse workspace → try `--continue` then fall back to a fresh prompt (mirror `ClaudeCliExecutor` / `ClaudeWExecutor`).
- Keep validation and orchestration patterns aligned with `packages/daemon/task/src/core/task-orchestrator.ts` and `packages/shared/src/types.ts`.

## Non-goals

- Parsing JSON tool traces from Cursor (only final aggregated text in stdout, like other executors).
- Mapping `session_id` to Cursor chat IDs (`--resume`) — Cursor session identity is separate from LocalAgent’s filesystem session directory unless we discover a stable on-disk token (out of scope v1).
- Passing Claude-style `--plugin-dir` / marketplace clones into Cursor CLI (no matching flag in current `agent --help`; see gaps below).

## Clarifications / assumptions

The design-and-plan workflow normally uses several rounds of stakeholder Q&A. For this pass the following are **working assumptions**; adjust before implementation if any are wrong:

1. **Binary name:** `agent` on `PATH` (same as local install at `~/.local/bin/agent`).
2. **Authentication:** The daemon host already has Cursor CLI auth (`agent login` / stored credentials); failures surface as non-zero exit + stderr (no LocalAgent-side OAuth).
3. **Automation flags:** Headless tasks use `--print`, `--trust`, and `--force` (or `--yolo`) so jobs do not block on interactive approvals, analogous to Claude’s `--dangerously-skip-permissions`. Acceptable risk for trusted worker hosts only.
4. **`executor_model`:** Cursor’s catalog changes frequently (`agent models`). Prefer **validated freeform** model ids (length + character class) rather than a giant static allowlist; **tune the regex** against `agent models` output if ids ever include `/`, `:`, or other punctuation.
5. **`system_prompt`:** No `agent` flag equivalent to `--append-system-prompt`; v1 **prepends** system text to the user prompt inside a clear delimiter block.

### Security note (ops)

`--print` alone is **not** sufficient for mutating automation behavior in public Cursor CLI documentation summaries — pairing **`--print` with `--force` or `--yolo`** is what allows non-interactive tool/terminal use analogous to Claude Code’s `--dangerously-skip-permissions`. **Only run on trusted worker hosts**; document alongside existing high-privilege executors.

### Pinned CLI reference (local check, 2026-04-02)

Verified on host: binary `agent` (`/Users/bytedance/.local/bin/agent`), `agent --version` / `agent --help`. Canonical headless smoke:

`agent --print --trust --force --workspace <workDir> --model <id> --output-format text "prompt"`

**Implementation must set both** `cwd: env.workDir` **and** `--workspace env.workDir` so relative paths match other executors’ behavior.

**Prompt channel:** Cursor is invoked with a **single trailing argv** holding the full prompt (after optional `--`). Claude adapters use **stdin** (`-p -`); `agent` does not mirror that pattern in a quick stdin probe, so argv is intentional. **Risk:** very large `payload`/`history` may approach OS `ARG_MAX` limits — document for operators; if this appears in production, reconsider chunking or a Cursor-supported stdin mode if one is added later.

## Context: current architecture

- `TaskOrchestrator` resolves `TaskExecutorType` in `resolveExecutor` and runs `ExecutorPreference[]` in order.
- CLI executors implement `TaskExecutor.execute(job: JobAttempt, env: ExecutionEnvironment)`.
- `ExecutionEnvironment` provides `workDir`, `pluginDirs`, `isExistingWorkspace`.
- Claude-style executors: empty payload → failure; existing workspace → `--continue` with raw payload, else fresh prompt with optional `history` wrapper.

Reference: Cursor `agent` (local help summary):

- Non-interactive: `--print`, optional `--output-format text|json|stream-json`.
- Workspace: `--workspace <path>` (set to `env.workDir`).
- Model: `--model <id>`.
- Session continuation: `--continue`.
- Trust / automation: `--trust`, `--force` / `--yolo`.

## Approaches considered

### A — Thin `spawn` wrapper (recommended)

Implement `CursorAgentExecutor` parallel to `ClaudeCliExecutor`: build argv, spawn `agent`, collect streams, map exit code to success/failure, truncate with `MAX_RESULT_OUTPUT_BYTES`.

**Pros:** Minimal code, matches existing tests and logging patterns; easy to reason about.  
**Cons:** Cursor CLI behavior drift requires occasional doc/flag updates.

### B — JSON output + structured parsing

Use `--output-format json` and parse tool/result objects.

**Pros:** Richer telemetry later.  
**Cons:** Schema coupling to Cursor; more code; not required for parity with other executors.

### C — Dynamic model list via subprocess

Call `agent models` during validation.

**Pros:** Always “accurate.”  
**Cons:** Slow, flaky in API path, auth-dependent; poor fit for `isValidExecutorModel` in shared package.

**Recommendation:** **A** for v1; **B** only if product needs structured traces; **C** rejected for validation hot path.

## Proposed design

### 1. Shared types (`packages/shared/src/types.ts`)

- Extend `TASK_EXECUTORS` with `'cursor_agent'` (name mirrors product: Cursor Agent CLI).
- **`ExecutorModelType`:** Use a conditional so `cursor_agent` is **`string`** while other executors stay tuple-derived:

  `T extends 'cursor_agent' ? string : (typeof EXECUTOR_MODELS)[T][number]`

- **`EXECUTOR_MODELS['cursor_agent']`:** Keep a **non-empty** `as const` tuple of **examples only** (e.g. `['auto', 'composer-2-fast', 'gpt-5.4-medium']`) so `satisfies Record<TaskExecutorType, readonly string[]>` still holds. **`isValidExecutorModel` must branch:** for `cursor_agent`, validate with **length + regex** (not `includes` on that tuple alone).
- **`getExecutorModelOptions('cursor_agent')`:** Return a human string that does not imply an exhaustive allowlist, e.g. `auto, composer-2-fast, gpt-5.4-medium, … (any id from agent models; pattern-validated)` — so enrichment logs and dev ergonomics stay honest.

API route `jobs.ts` uses a **generic** executors error string today (not model-specific), so no copy change required unless other call sites say “must be one of …” for models.

### 2. Executor adapter (`packages/daemon/task/src/adapters/cursor-agent-executor.ts`)

Behavior:

- Validate payload non-empty (same as Claude).
- **Fresh vs continue:** Same branching as `ClaudeCliExecutor` using `env.isExistingWorkspace`.
- **Argv template** (single positional prompt string after `--`):

  `agent --print --trust --force --workspace <workDir> --model <executor_model> --output-format text [--continue] -- <fullPromptString>`

  Use `spawn('agent', args, { cwd: env.workDir, shell: false })` where the final element of `args` is **one** string containing the entire prompt (including newlines).

- **`system_prompt`:** If set, `prompt = "<system block>\n\n<payload or history-wrapped payload>"`.
- **`pluginDirs`:** If non-empty, log `debug` once that Cursor executor ignores plugin paths in v1 (marketplace integration TBD).

Exit handling: mirror `ClaudeCliExecutor` (`close` code, `error` event, truncation).

### 3. Orchestrator (`task-orchestrator.ts`)

Add branch: `if (executor === 'cursor_agent') return new CursorAgentExecutor();`

### 4. Tests

- New `cursor-agent-executor.test.ts` patterned on `claude-cli-executor.test.ts`: mock `spawn`, assert argv contain `--print`, `--trust`, `--force`, `--workspace`, `--model`, optional `--continue`, delimiter `--`, and **one** trailing prompt argument; assert `cwd` is `env.workDir`.
- Update `packages/shared/src/__tests__/types.test.ts` for new executor, regex model validation (`auto`, long string, bad charset), and `getExecutorModelOptions('cursor_agent')`.
- Update `task-orchestrator.test.ts` (or equivalent) so **`cursor_agent` routes to `CursorAgentExecutor`**.

### 5. Documentation / config examples (optional in v1)

If we touch enrichment examples, add one `{ executor: cursor_agent, executor_model: auto }` pair; otherwise a short note in this design is enough.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Cursor CLI flag changes | Pin behavior to documented `agent --help`; add integration smoke in internal runbooks |
| `--continue` may not match Claude semantics | Document; same fallback pattern as Claude executors |
| Headless `--force` is dangerous | Restrict to trusted worker machines; document parity with existing Claude “skip permissions” |
| Model id validation too strict/loose | Tune regex with real `agent models` samples |

## Verification

- Unit: `pnpm --filter @local-agent/shared vitest run src/__tests__/types.test.ts`
- Unit: `pnpm --filter @local-agent/task-daemon vitest run src/adapters/__tests__/cursor-agent-executor.test.ts`
- Manual: run task daemon against a job with `cursor_agent` / `auto` on a host with `agent` logged in

## Open follow-ups (not v1)

- Structured JSON output ingestion.
- Correlating LocalAgent `session_id` with Cursor resume tokens if Cursor exposes stable ids per workspace.
- MCP / marketplace parity if `agent` gains equivalent extension flags.
