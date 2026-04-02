# Design: Add `ttcodex` Executor

**Date:** 2026-04-02
**Status:** Approved for implementation planning
**Type:** Feature addition
**Packages:** `@local-agent/shared`, `@local-agent/task-daemon`, `@local-agent/task-enrichment-daemon`, `@local-agent/lark-listener-daemon`, `@local-agent/api`

## 1. Problem

The current executor set supports `claude`, `claude-w`, `cursor`, and `builtin`, but it does not expose a first-class executor for running OpenAI Codex through the TTADK wrapper.

The user wants a new executor named `ttcodex` that:

- is a brand-new executor contract value
- invokes TTADK with `-t codex`
- supports a small explicit model allowlist
- resumes existing workspace conversations using Codex's non-interactive resume flow
- strips known TTADK wrapper noise from captured results so users see Codex output rather than TTADK banners

Without this executor, Codex-through-TTADK usage remains ad hoc and cannot participate in the existing task submission, enrichment, routing, and result-reporting pipeline.

## 2. Goal

Add a first-class `ttcodex` executor that runs Codex via TTADK, uses the existing workspace/session model, supports fresh and resume execution modes, and normalizes TTADK output so task results contain the useful Codex response.

## 3. Non-goals

- No marketplace / plugin forwarding for `ttcodex` in v1.
- No persistence of Codex session IDs in LocalAgent metadata.
- No generic wrapper abstraction shared by all executors.
- No freeform model validation; `ttcodex` gets an explicit static allowlist.
- No heuristics that strip arbitrary stderr text; only known TTADK wrapper lines are removed.
- No changes to queue semantics, polling, ACK behavior, or result schema shape.

## 4. Scope Assessment

This is one coherent feature, not multiple subsystems.

Although it touches shared validation, task-daemon routing, enrichment examples, and tests, all changes hang off one contract addition:

- new executor name: `ttcodex`
- new model allowlist
- new task-daemon adapter behavior
- result normalization for TTADK-wrapped Codex runs

That makes a single design and implementation plan the correct scope.

## 5. User Decisions Captured

- The executor name is exactly `ttcodex`.
- `ttcodex` is a new executor, not a rename or alias.
- Supported models on day one are:
  - `gpt-5.4`
  - `gpt-5.3-codex`
  - `gpt-5.2-codex`
- TTADK command shape should be built around:
  - fresh: `ttadk code -m <model> -t codex -a 'exec ...'`
  - continue: `ttadk code -m <model> -t codex -a 'exec resume --last ...'`
- Existing workspaces should use Codex resume via an explicit continue command rather than relying on implicit behavior.
- Fresh-vs-resume behavior should mirror current executor fallback semantics: try continue first for existing workspaces, then fall back to fresh on failure.
- `system_prompt` support in v1 is implemented by embedding system text inside the `exec` prompt payload (using LocalAgent delimiter blocks) rather than by adding a new TTADK flag.
- `ttcodex` should not implement plugin / marketplace forwarding in v1; leave a code comment documenting the gap.
- The adapter should include `--skip-git-repo-check` in the Codex command string by default.
- Result normalization should strip only known TTADK wrapper lines.
- Sanitization should prefer `stdout`, but if sanitized `stdout` is empty, use sanitized `stderr` as fallback.
- User-facing docs/help should refer to the executor simply as `ttcodex`, not “TTADK Codex wrapper”.

## 6. Current State

The live architecture already provides the pieces `ttcodex` needs to plug into:

- `packages/shared/src/types.ts`
  - defines canonical executor names and per-executor model allowlists
  - validates `ExecutorPreference[]`
- `packages/daemon/task/src/core/task-orchestrator.ts`
  - resolves executor adapters from `TaskExecutorType`
  - uses workspace setup once, then tries executor preferences in order
- `packages/daemon/task/src/services/job-environment.ts`
  - manages per-session workspaces and plugin directory discovery
- existing executors
  - `claude` and `claude-w` show the continue-then-fresh pattern
  - `cursor` shows argv-built prompt transport and workspace reuse without stdin piping

What is missing is a TTADK/Codex-specific adapter that matches Codex resume semantics and handles TTADK's stream quirks.

### 6.1 Where `ttcodex` Enters the Pipeline

In the current LocalAgent architecture, the executor that actually runs in the task daemon is selected from `Job.executors: ExecutorPreference[]`.

- `POST /tasks` (in `packages/api/src/routes/tasks.ts`) accepts `Task` objects and is primarily used as an ingress for tasks that will later be enriched into jobs; control tasks may optionally include `executor` / `executor_model` fields.
- `POST /jobs` (in `packages/api/src/routes/jobs.ts`) is the contract boundary for the task daemon: it requires a non-empty `executors` array and validates it via `isValidExecutorPreferences()` from `@local-agent/shared`.

For this feature, the critical compatibility requirement is:

- `isValidExecutorPreferences([{ executor: 'ttcodex', executor_model: 'gpt-5.4' }])` must become `true`.

## 7. Observed TTADK Codex Behavior

The design is based on direct probes run on 2026-04-02.

### 7.1 Repo workspace probe

Command run:

```bash
ttadk code -m gpt-5.4 -t codex -a 'exec "echo HELLO"' > stdout.txt 2> stderr.txt
```

Observed behavior:

- `stdout` contained TTADK startup output:
  - ASCII banner
  - product/version/team lines
  - login success line
  - `Launching Codex CLI...`
- `stderr` contained Codex runtime metadata and transcript:
  - Codex version header
  - workdir/model/provider/approval/sandbox/session metadata
  - user prompt transcript
  - Codex narration of the executed shell command
- the final answer text appeared in both streams in this successful probe

### 7.2 Untrusted-directory probes

Fresh and resume probes from a directory outside a trusted repo showed:

- `stdout` still contained TTADK banner/login/launch lines
- `stdout` also contained a TTADK warning line in Chinese about missing codebase repo information
- `stderr` contained the actionable Codex failure only:

```text
Not inside a trusted directory and --skip-git-repo-check was not specified.
```

This confirms two design requirements:

1. We must pass `--skip-git-repo-check` in the Codex command payload.
2. We cannot assume useful output always lands in `stdout`; fallback to sanitized `stderr` is required.

## 8. Approaches Considered

### Approach A - Reuse `cursor` executor shape with minimal TTADK substitutions

Model `ttcodex` as a mostly mechanical fork of `cursor`: spawn a binary, build one prompt string, collect stdout/stderr, and add a small sanitizer.

**Pros**

- Smallest diff in task-daemon code
- Matches existing execution and test patterns

**Cons**

- TTADK-specific command-building and stream behavior become harder to reason about
- Risks burying wrapper-specific quirks in generic-looking code

### Approach B - Add a TTADK-specific Codex adapter with explicit sanitization rules (recommended)

Implement `TTCodexExecutor` as its own adapter that owns TTADK/Codex command construction, continue/fresh behavior, and stream normalization.

**Pros**

- Keeps TTADK-specific behavior isolated
- Makes sanitization and fallback rules explicit and testable
- Easier to evolve if TTADK wrapper behavior changes

**Cons**

- Slightly more bespoke code than a minimal copy of `cursor`

### Approach C - Build a generic wrapped-CLI executor abstraction first

Create an abstraction for “wrappers around other CLIs”, then implement `ttcodex` on top of it.

**Pros**

- Less duplication if many wrappers arrive later

**Cons**

- Over-engineered for one new executor
- Forces abstraction decisions before the real shared shape is proven

## 9. Recommendation

Adopt **Approach B**.

`ttcodex` has enough wrapper-specific behavior that it deserves its own adapter:

- TTADK command string construction
- Codex resume semantics via `resume --last`
- `--skip-git-repo-check`
- known-line stripping in stdout
- fallback to stderr when stdout contains only wrapper noise

That is specific logic, not just another spawn target.

## 10. Proposed Design

### 10.1 Shared contract in `@local-agent/shared`

Update `packages/shared/src/types.ts`:

- add `ttcodex` to `TASK_EXECUTORS`
- add `EXECUTOR_MODELS.ttcodex = ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2-codex']`
- keep using existing helpers unchanged in shape:
  - `isTaskExecutorType()`
  - `isValidExecutorModel()`
  - `getExecutorModelOptions()`
  - `isValidExecutorPreferences()`

This keeps API, enrichment, listener parsing, and daemon routing aligned through one shared source of truth.

### 10.2 Task-daemon adapter

Create `packages/daemon/task/src/adapters/ttcodex-executor.ts` with class `TTCodexExecutor` implementing `TaskExecutor`.

#### Execution behavior

- Empty payload returns failure immediately, matching existing executors.
- If `env.isExistingWorkspace` is true and `job.skipContinue` is not set:
  - run continue mode first
  - on success, return result
  - on failure, log and fall back to fresh mode
- Otherwise run fresh mode directly.

#### Command transport

Spawn TTADK directly:

```ts
spawn('ttadk', ['code', '-m', job.executor_model, '-t', 'codex', '-a', builtArg], {
  cwd: env.workDir,
  shell: false,
});
```

Where `builtArg` is one shell-safe string for TTADK's `-a` flag.

Design note: `cwd` is intentionally `env.workDir` (the LocalAgent session workspace). This makes Codex transcript storage and `resume --last` behavior scoped to the LocalAgent session directory rather than the repository where the daemon is launched.

#### `-a` command builder

Fresh mode:

```text
exec --skip-git-repo-check "<prompt>"
```

Continue mode:

```text
exec resume --last --skip-git-repo-check "<prompt>"
```

The adapter should quote/escape the prompt so embedded newlines and quotes survive transport.

Implementation note: the daemon must not rely on shell escaping. It should pass a single `-a` argument string to `ttadk` via `spawn(..., { shell: false })` and escape the prompt explicitly (for example, by using `JSON.stringify(prompt)` to produce a double-quoted string with correct backslash escaping).

#### Prompt shaping

Base prompt rules:

- fresh without history: use `job.payload`
- fresh with history: wrap exactly like existing executors:

```text
--- Thread Context ---
<history>
--- Current Message ---
<payload>
```

- continue mode: use just `job.payload`

If `job.system_prompt` exists, prepend it inside the prompt body using the same clear delimiters used by the `cursor` executor:

```text
--- System ---
<system_prompt>
--- User ---
<base prompt>
```

This preserves current LocalAgent prompt-shaping conventions without introducing a TTADK-specific system flag dependency.

#### Marketplace / plugin handling

`job.marketplaces` should still flow through workspace setup unchanged so repository clones remain available in the session directory if configured.

However, `TTCodexExecutor` should not forward plugin directories to Codex in v1. It should:

- ignore `env.pluginDirs` at runtime
- log a debug message when plugin directories are present
- include a short code comment noting that marketplace/plugin forwarding is intentionally unsupported for `ttcodex` v1

This preserves YAGNI while documenting the known gap.

### 10.3 Stream sanitization and result selection

`TTCodexExecutor` must normalize TTADK output before returning `TaskResultSubmission`.

#### Known lines to strip

The sanitizer should remove only known TTADK wrapper lines, including:

- ASCII banner block
- `TikTok AI-Driven Development Kit`
- `Version ...`
- `Team: ...`
- login success line
- `Launching Codex CLI...`
- the observed TTADK repo-info warning line

Implementation note: the login success line includes an email address, so stripping should be done by matching a stable prefix/pattern rather than the full line literal.

Implementation note: the repo-info warning line contains non-ASCII text in some environments; in code it should be stripped by matching a stable ASCII substring (for example, a line containing "codebase" or "repo") rather than depending on an exact Unicode literal.

The sanitizer must not remove arbitrary Codex transcript or failure text.

#### Output selection rules

1. Sanitize `stdout`
2. If sanitized `stdout` is non-empty after trimming, use it as `stdout`
3. Sanitize `stderr` with the same known-line rules
4. If sanitized `stdout` is empty but sanitized `stderr` has useful content, copy sanitized `stderr` into `stdout`
5. Preserve `stderr` as the sanitized stderr stream so actionable failures remain visible

Rationale:

- successful runs may surface answer text in both streams
- untrusted/trust-check failures showed the actionable message only in `stderr`
- the contract should prefer the user-facing answer channel while still exposing operational detail

### 10.4 Orchestrator routing

Update `packages/daemon/task/src/core/task-orchestrator.ts`:

```ts
if (executor === 'ttcodex') return new TTCodexExecutor();
```

No other orchestrator behavior changes are needed.

### 10.5 API, listener, and enrichment implications

Because executor and model validation already centralize in `@local-agent/shared`, the rest of the system should pick up `ttcodex` mostly through shared helpers.

Impacted areas still need literal updates in tests and docs where executor lists are asserted or rendered:

- API route tests for executor validation and model options
- listener `/new` parsing tests or submission fixtures that enumerate valid executors
- enrichment rules/tests that validate executor preferences or display help text

The live checked-in `local-agent.yaml` currently contains only a setup hook, so no required production config addition is needed for v1 beyond documentation/examples.

## 11. File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/types.ts` | Modify | Add `ttcodex` executor and model allowlist |
| `packages/shared/src/index.ts` | Modify | Re-export updated shared types/helpers if needed |
| `packages/shared/src/__tests__/types.test.ts` | Modify | Cover executor/model validation and options for `ttcodex` |
| `packages/daemon/task/src/adapters/ttcodex-executor.ts` | Create | New TTADK Codex executor adapter |
| `packages/daemon/task/src/adapters/__tests__/ttcodex-executor.test.ts` | Create | Unit tests for command building, fallback, and sanitization |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Modify | Route `ttcodex` to `TTCodexExecutor` |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Modify | Verify orchestrator routing for `ttcodex` |
| `packages/api/src/routes/tasks.ts` | Modify | Shared validation wiring may need assertion updates if executor options are surfaced |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Modify | Cover `ttcodex` executor/model acceptance and error text |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Modify | Ensure POST `/jobs` executor-preferences validation accepts `ttcodex` model pairs |
| `packages/daemon/lark-listener/src/message-handler.ts` | Modify | Update any help or examples that enumerate executors |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Modify | Update enumerated executor expectations |
| `packages/daemon/lark-listener/src/adapters/task-submitter.ts` | Modify | Update any surfaced executor help/example text |
| `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts` | Modify | Update executor/model fixtures if user-facing help is asserted |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Only if tests or helper copy enumerate valid executors explicitly |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Update validation fixtures/examples for `ttcodex` |
| `docs/development/design/2026-04-02-ttcodex-executor-design.md` | Create | Source-of-truth design doc |
| `docs/development/plans/2026-04-02-ttcodex-executor.md` | Create | Implementation plan |

## 12. Test Strategy

### Shared

- `isTaskExecutorType('ttcodex')` returns true
- `isValidExecutorModel('ttcodex', 'gpt-5.4')` returns true
- invalid models for `ttcodex` return false
- `getExecutorModelOptions('ttcodex')` returns the three-model list in exact order

### Adapter

- fresh mode builds `ttadk code -m <model> -t codex -a 'exec --skip-git-repo-check "..."'`
- continue mode builds `exec resume --last --skip-git-repo-check "..."`
- continue failure falls back to fresh mode
- `system_prompt` is prepended inside the prompt body
- history wrapping matches existing executor format for fresh fallback
- plugin directories are ignored and logged, not forwarded
- known TTADK stdout lines are stripped
- sanitized stderr is promoted to stdout when sanitized stdout is empty
- non-zero exit codes map to failure while preserving sanitized streams

### Orchestrator

- `ttcodex` preference resolves to `TTCodexExecutor`
- executor fallback ordering remains unchanged when `ttcodex` is in a preference list

### API / integration surfaces

- task submission accepts `ttcodex` + valid model
- invalid `ttcodex` model is rejected with helpful options
- `/new` / routing helper text includes `ttcodex` where applicable

## 13. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| TTADK wrapper output changes and sanitizer misses new wrapper lines | Keep sanitizer narrowly scoped and easy to extend; cover observed lines in tests |
| `resume --last` may reopen an unintended Codex thread inside the same workspace | Accept as v1 trade-off; explicit Codex session tracking remains a future enhancement |
| Shell quoting bugs in `-a` break prompts containing quotes/newlines | Centralize `-a` string construction and test quoting behavior with representative multiline fixtures |
| Marketplace directories exist but are ignored by Codex | Log the behavior and add a code comment so the limitation is explicit |
| `--skip-git-repo-check` weakens repository trust checks | This is intentional per user direction; keep behavior explicit in docs/tests |

## 14. Acceptance Criteria

1. `ttcodex` is a valid `TaskExecutorType` everywhere shared validation is used.
2. `ttcodex` accepts exactly `gpt-5.4`, `gpt-5.3-codex`, and `gpt-5.2-codex` in v1.
3. The task daemon routes `ttcodex` jobs to a dedicated `TTCodexExecutor`.
4. Existing workspaces use `exec resume --last --skip-git-repo-check ...` first and fall back to fresh execution on failure.
5. Fresh execution uses `exec --skip-git-repo-check ...`.
6. `system_prompt` and thread history are incorporated using existing LocalAgent prompt delimiters.
7. `ttcodex` does not forward plugin directories in v1, and that limitation is explicit in code/tests.
8. Known TTADK wrapper lines are stripped from captured results.
9. If sanitized stdout is empty and sanitized stderr has useful content, the result promotes sanitized stderr into stdout.
10. Tests cover shared validation, adapter behavior, orchestrator routing, and user-facing validation/help surfaces impacted by the new executor.
