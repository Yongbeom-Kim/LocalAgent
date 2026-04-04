# Design: GitHub PR Merge Gate for Rush Update, Build, and Tests

**Date:** 2026-04-05
**Status:** Ready for implementation planning
**Depends on:** Rush monorepo structure (implemented), per-package `build` and `test` scripts (implemented)

## Problem

The repo currently depends on human instruction to verify three release-safety checks before merging:

- `rush update`
- `rush build`
- all package test suites

That is fragile for two reasons:

1. the checks depend on the coding agent or reviewer remembering to run them;
2. even if someone remembers, GitHub has no repo-owned merge gate that blocks a pull request when those checks are skipped or fail.

The result is a process problem instead of an enforceable repository policy.

## Goal

Add a GitHub Actions pull-request workflow that becomes the single required merge gate for this repository.

For every PR, the workflow must:

1. run in a Linux Node environment;
2. run `rush update`;
3. run `rush build` for the full repo;
4. run tests for all current and future Rush projects that expose a `test` script;
5. continue running all discovered test suites so the PR author sees the full failure set;
6. fail the single CI job if any setup, build, or test step fails;
7. support GitHub branch protection rollout so the check can be marked required before merge.

## User Decisions

- Platform target is GitHub pull requests.
- The merge gate must cover `rush update`, `rush build`, and all tests.
- The user-facing merge gate is one CI job, not multiple required checks.
- The first version runs against the full monorepo on every PR.
- The workflow should use raw workflow commands rather than introducing a new repo-owned `ci` command.
- `rush update` enforcement is simply "run it and fail if it exits non-zero," not a separate diff-check contract.
- The workflow runs on PRs only, not direct branch pushes.
- The design should include GitHub required-check rollout instructions because the goal is to block merges.
- Tests should cover all current and future Rush projects with a `test` script.
- Tests should keep running across packages and fail only after the full set completes.
- Superseded in-progress PR runs should be canceled.
- Contributor-facing local development docs should mention the merge gate.
- Linux-only CI is acceptable.

## Non-Goals

- Adding affected-project or path-scoped CI in this iteration.
- Adding extra required merge checks such as lint, formatting, security scan, or coverage gates.
- Supporting GitLab CI or GitLab merge requests in this feature.
- Publishing matrix builds across Node versions or operating systems.
- Replacing local developer workflows with CI-only workflows.
- Requiring `rush update` to prove the lockfile is unchanged via a separate `git diff` assertion.

## Existing Context

### 1. Rush is already the monorepo orchestration layer

`rush.json` is the source of truth for the workspace and currently lists all repo projects. The repo already vendors the standard Rush helper scripts under `common/scripts/`, so GitHub Actions can rely on the repo-local Rush bootstrap pattern instead of requiring globally preinstalled Rush.

### 2. Build and test entry points already exist per package

Each Rush project currently exposes:

- `build`: `tsc`
- `test`: `vitest run`

across the repo's current packages (`shared`, `api`, `cli`, and the daemon packages). That means the workflow does not need to invent new package-level contracts to begin enforcing the gate.

### 3. There is no existing GitHub Actions workflow in the repo

The repository currently has no `.github/workflows/` directory. This feature therefore defines the first GitHub PR validation workflow and should keep the contract explicit and small.

### 4. "All tests" must stay future-proof

The user explicitly does not want package names hardcoded into the workflow as the long-term test contract. A future package added to `rush.json` should automatically be included if it defines a `test` script.

## Approaches Considered

### Approach 1: Hardcode every package's test command in the workflow

Example shape:

- `cd packages/shared && npm test`
- `cd packages/api && npm test`
- repeat for each current package

**Why not chosen:**

- breaks the user's "all current and future Rush projects" requirement;
- every new package requires a workflow edit before CI coverage exists;
- creates a maintenance trap where the merge gate lags behind the monorepo.

### Approach 2: One GitHub Actions job with dynamic Rush-project test discovery

Workflow shape:

- install Node;
- bootstrap dependencies through the repo-local Rush script;
- run `rush update`;
- run `rush build`;
- inspect Rush projects and execute tests only for projects that define a `test` script;
- keep going across test packages and fail at the end if any test invocation failed.

**Why chosen:**

- satisfies the one-job merge gate requirement;
- preserves raw workflow commands for setup/build;
- automatically includes future Rush projects that opt into the existing `test` script contract;
- avoids adding a new repo command purely for CI abstraction.

### Approach 3: Add a repo-owned monorepo `rush test` or `ci:verify` command and call that from GitHub Actions

This would centralize CI behavior behind a single checked-in command.

**Why not chosen for V1:**

- adds command-surface area the user said is unnecessary right now;
- does not materially improve the first implementation beyond hiding workflow steps behind another layer;
- can still be introduced later if CI logic grows enough to justify the abstraction.

## Design

### 1. Add a single PR-only workflow with superseded-run cancellation

**New file:** `.github/workflows/pr-merge-gate.yml`

The workflow should:

- trigger on `pull_request` events relevant to code review: `opened`, `synchronize`, `reopened`, `ready_for_review`;
- use a concurrency group keyed by workflow name and PR number (so each PR cancels only its own superseded runs);
- set `cancel-in-progress: true` so outdated runs do not consume capacity or confuse review.

Recommended top-level workflow permissions (keep minimal):

- `permissions: { contents: read }`

Recommended job name:

- `pr-merge-gate`

Recommended displayed workflow name:

- `PR Merge Gate`

The check name should stay stable after rollout because GitHub branch protection binds required checks to the check name.

### 2. Use a single Linux Node job with repo-local Rush bootstrap

The job should run on `ubuntu-latest` and install a supported Node version that satisfies `rush.json`'s `nodeSupportedVersionRange`.

Recommended setup:

- `actions/checkout`
- `actions/setup-node` pinned to Node 22 (within this repo's `nodeSupportedVersionRange`)
- enable dependency caching via `actions/setup-node` (simple, low-noise): `cache: 'pnpm'` and `cache-dependency-path: common/config/rush/pnpm-lock.yaml`
- bootstrap Rush using `node common/scripts/install-run-rush.js`

Recommended command sequence:

1. `node common/scripts/install-run-rush.js update`
2. `node common/scripts/install-run-rush.js build`
3. run the repo test-discovery script/step described below

Why use the repo-local Rush bootstrap script instead of bare `rush`:

- it matches existing repo conventions in prior plans;
- it does not require a global Rush install on the runner;
- it keeps the workflow portable across clean GitHub-hosted environments.

### 3. Keep the merge gate as one required check while still exposing logical phases inside the job

The user wants one blocking CI job. That means `rush update`, `rush build`, and tests should remain steps inside a single job rather than separate required jobs.

Recommended step names:

- `Rush Update`
- `Rush Build`
- `Run All Project Tests`

Behavior:

- if `rush update` fails, the job fails immediately;
- if `rush build` fails, the job fails immediately;
- once test execution starts, the step should continue across all discovered test projects and fail only after surfacing the full failure set.

This preserves a single required status check while still making the job log readable.

### 4. Discover testable Rush projects dynamically from `rush.json` and package manifests

The workflow should not hardcode package names.

Recommended mechanism:

- read `rush.json` to obtain the authoritative `projectFolder` list;
- for each project folder, read its `package.json`;
- select only projects whose `scripts.test` is defined and non-empty;
- execute that package's existing test command from the project directory.

Test execution mechanism (to avoid relying on a global package-manager binary):

- for each discovered project folder, run `node <repoRoot>/common/scripts/install-run-rushx.js test` with `cwd` set to that project folder.

Rationale:

- `rushx` is the Rush-supported way to invoke a project's `package.json` scripts in a Rush repo;
- calling `node common/scripts/install-run-rushx.js` keeps the workflow self-contained and consistent with `install-run-rush.js`.

Recommended implementation shape:

- a small checked-in Node script under `common/scripts/`, for example `common/scripts/run-rush-project-tests.js`

Why a checked-in helper script is still compatible with the "raw workflow commands" decision:

- the workflow remains explicit about the overall merge-gate phases (`update`, `build`, `tests`);
- the script handles only dynamic discovery and test fan-out logic that would be brittle if embedded inline in YAML;
- the script defines repo behavior that is useful to contributors locally as well as in CI.

The script contract should be:

1. parse `rush.json`;
2. resolve each project's `package.json`;
3. print the discovered testable projects in a stable order (use the order provided by `rush.json.projects`);
4. run each project's `test` script sequentially;
5. continue after failures and collect the failed project list;
6. exit `1` at the end if any project failed;
7. exit `0` if every discovered test project passed;
8. exit `0` with a clear message if no projects define a test script.

Sequential execution is preferred for V1 because:

- it is simpler to reason about;
- it avoids hiding failures behind concurrent log interleaving;
- full-repo execution is already an accepted cost in this feature.

### 5. Keep future-project coverage tied to the package `test` script contract

For a new Rush project to automatically join the merge gate, it only needs:

- an entry in `rush.json`;
- a `package.json` with a `test` script.

This is the explicit repo contract for CI inclusion.

Implications:

- packages without a `test` script are intentionally skipped;
- adding a new project without a `test` script is allowed, but it does not satisfy the user's broad preference for "all tests" until that script exists;
- contributor docs should make this contract explicit so new packages do not accidentally bypass validation.

### 6. Document rollout: GitHub branch protection must require the CI job

The workflow file alone does not block merges. The design must therefore include operational rollout instructions for repository settings.

Required rollout outcome:

- branch protection for the protected branch must require the workflow's single PR check before merge.

The implementation should document:

1. In GitHub: `Settings` -> `Branches` -> `Branch protection rules` -> add or edit the rule for the default/protected branch.
2. Enable `Require status checks to pass before merging`.
3. Select the merge-gate status check.
   - Make the job's displayed name stable: set the job `name` to `pr-merge-gate`.
   - In GitHub UI this typically appears as either `pr-merge-gate` or `PR Merge Gate / pr-merge-gate` (workflow name plus job name).
   - After merging the workflow, run it once on a PR so the check name appears in the branch protection dropdown.
4. Ensure the rule applies to the branch used for PR merges.

This is documentation and rollout guidance, not a repo-automated change.

### 7. Update contributor docs to make the gate visible before CI failure

**Likely file:** `docs/LOCAL_DEVELOPMENT.md`

Add a short CI expectations section that tells contributors:

- every PR runs the merge gate;
- the gate executes `rush update`, `rush build`, and all project test scripts;
- running those commands locally before opening or updating a PR reduces avoidable CI failures;
- new Rush projects should define a `test` script if they are expected to participate in the merge gate.

This keeps local expectations aligned with the enforced repository policy.

## Verification

After implementation:

1. open a PR that exercises the new workflow and confirm the single `pr-merge-gate` check appears;
2. confirm `rush update` and `rush build` run successfully on GitHub-hosted Linux;
3. confirm the test-discovery step runs all current test-bearing packages in stable order;
4. intentionally break one package test and confirm the step still runs later package tests before failing;
5. push a second commit to the same PR and confirm the earlier in-progress workflow run is canceled;
6. enable the check in GitHub branch protection and confirm merge is blocked when the check is failing or pending.

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Workflow silently misses a new package | Medium | Make `rush.json` + `scripts.test` the explicit discovery contract and document it in contributor docs |
| Wrong Node version on CI breaks Rush or TypeScript unexpectedly | Low | Pin a Node version inside `rush.json`'s supported range and document the choice in the workflow |
| Inline YAML logic becomes hard to maintain | Medium | Keep discovery logic in a small checked-in Node script rather than shell-heavy inline YAML |
| Single job hides which phase failed | Low | Use clear step names and stable script output for update/build/test phases |
| Branch protection is not configured after merge | Medium | Include explicit rollout instructions and call out that the workflow alone does not block merges |
