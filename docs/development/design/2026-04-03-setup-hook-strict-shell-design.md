# Design: Strict Shell Contract for Setup Hooks

**Date**: 2026-04-03
**Status**: Approved
**Author**: Codex

---

## Overview

Tighten the task daemon's setup-hook runtime contract so every configured `setup_hook` runs under bash strict mode: `set -euo pipefail`.

Today the runner invokes hooks with `bash -c <script>`, which allows unset variables and earlier pipeline failures to be ignored unless the script opts into stricter behavior itself. The new behavior makes strict execution mandatory for all setup hooks without changing the enrichment schema or adding new YAML fields.

---

## Problem Statement

Setup hooks are part of environment preparation. If they partially fail but still return success, the executor runs against a broken workspace and the real failure shows up later in a harder-to-diagnose way.

The current runner does not enforce:

- `-e`: exit on many (but not all) command failures
- `-u`: error on unset variable expansion
- `-o pipefail`: fail a pipeline if any command in it fails

Note: `set -e` has well-known exceptions in bash (for example failures in `cmd && ...` / `cmd || ...` lists do not necessarily abort the script). This change is still valuable, but it is not a guarantee that *all* failed commands will immediately terminate every hook.

This makes hook behavior too permissive for infrastructure setup.

---

## Goals

1. Run every setup hook with `bash -euo pipefail`.
2. Keep this as a runtime-only behavior change in the task daemon.
3. Preserve the existing error surface: hook failures still bubble up as `Setup hook failed: ...`.
4. Preserve the existing logging shape.
5. Identify and fix any repository-owned hook config that is already invalid or becomes invalid under the stricter contract.

## Non-Goals

- Adding per-hook opt-in or opt-out configuration.
- Changing the enrichment YAML schema or shared job types.
- Adding user-facing docs beyond these design and planning artifacts.
- Introducing a configurable shell or non-bash execution path.
- Reworking setup-hook logging, timeout behavior, or environment variable injection.

---

## Decision

Adopt invocation-level strict mode by changing the runner from:

```bash
bash -c "<script>"
```

to:

```bash
bash -euo pipefail -c "<script>"
```

In Node's `execFile` argument-array form, this should be expressed explicitly as either:

```ts
['-euo', 'pipefail', '-c', script]
```

or (more verbose, but less "bash-option" magical):

```ts
['-e', '-u', '-o', 'pipefail', '-c', script]
```

Both forms are valid; the second is easier to audit.

This keeps strictness as a runner contract rather than mutating hook content before execution.

### Alternatives Considered

1. Prepend `set -euo pipefail` to the script body.
This would also work, but it makes strictness part of generated script content instead of part of the runner contract.

2. Materialize hooks into temporary script files and execute those.
This is more explicit, but adds filesystem churn and more moving parts without solving a real problem in the current design.

Recommended approach: change the bash invocation only.

---

## Existing Config Risk Found During Planning

The repository-owned hook in `packages/daemon/task-enrichment/config/local-agent.yaml` is already invalid:

```yaml
setup_hook: |
  git clone --depth 1 git@github.com:Yongbeom-Kim/LocalAgent.git ./LocalAgent
  ./LocalAgent && git config --local user.name "Kim Yongbeom" && git config --local user.email "dernbu@gmail.com"
  nohup git -C "$PWD/LocalAgent" fetch --unshallow --tags </dev/null &>/dev/null &
```

The second line tries to execute `./LocalAgent` as a command. Because it is a directory, bash should fail with exit code 126. The intended behavior is directory navigation, so the rollout should repair this hook. The likely fix is one of:

- `cd ./LocalAgent && git config ...`
- `git -C ./LocalAgent config ...`

Because you want the hook to navigate into the repo directly, the rollout should use `cd ./LocalAgent`.

Also note that even under `set -e`, a failure in the left-hand side of an `&&` list does not necessarily abort the script, so this current hook can fail on line 2 and still reach line 3 and exit successfully. Repairing the hook is therefore required independently of the strict-shell change.

---

## Detailed Design

### 1. SetupHookRunner Contract

`packages/daemon/task/src/services/setup-hook-runner.ts` remains the single execution point for setup hooks.

Current behavior:

- invokes `bash -c <script>`
- sets `cwd` to the job workspace
- injects `LOCALAGENT_*` environment variables
- logs stdout/stderr
- throws `Setup hook failed: ...` on failure

New behavior:

- invokes `bash -euo pipefail -c <script>`
- preserves all other behavior exactly

No changes are needed to call sites, job payload structure, or enrichment flow.

### 2. JobEnvironment

`packages/daemon/task/src/services/job-environment.ts` should remain unchanged unless small refactors are needed by tests. It already delegates setup-hook execution to `SetupHookRunner` and already cleans up failed workspaces.

### 3. Config Rollout Repair

The repo-owned `local-agent.yaml` hook should be repaired as part of the same change so the repository's own default hook is compatible with the enforced runner contract.

This is still within scope because it is not a schema change or documentation change; it is a repository configuration fix required by the new runtime behavior and by the already-broken current script.

---

## File Changes

| File | Change |
|------|--------|
| `packages/daemon/task/src/services/setup-hook-runner.ts` | Modify bash invocation to `bash -euo pipefail -c` |
| `packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts` | Update tests for the new shell contract as needed |
| `packages/daemon/task-enrichment/config/local-agent.yaml` | Repair the invalid repository-owned hook |

Potentially touched only if tests require fixture updates:

| File | Change |
|------|--------|
| `packages/daemon/task/src/services/__tests__/job-environment.test.ts` | Adjust expectations only if error behavior or fixture assumptions need to change |

---

## Testing Strategy

Keep testing minimal and focused.

- Update the existing `SetupHookRunner` test file to verify the strict shell contract if current coverage is insufficient.
- Run the existing task-daemon tests affected by the runner and environment setup path.
- If the stricter contract breaks existing tests, fix the tests or fixtures rather than widening scope.

No new broad test matrix is required.

---

## Impact and Compatibility

- This is an intentional breaking runtime behavior change for setup hooks.
- Every existing hook now runs under strict bash mode.
- Hooks that relied on permissive shell behavior may fail earlier.
- The repository's current `local-agent.yaml` hook already needs repair regardless of strict mode.

---

## Acceptance Criteria

1. `SetupHookRunner` always executes setup hooks with `bash -euo pipefail -c`.
2. Failure reporting remains `Setup hook failed: ...`.
3. Existing logging behavior remains materially unchanged.
4. The repository-owned hook in `packages/daemon/task-enrichment/config/local-agent.yaml` is repaired to use `cd ./LocalAgent` instead of treating `./LocalAgent` as a command.
5. Relevant existing tests pass after the change.
