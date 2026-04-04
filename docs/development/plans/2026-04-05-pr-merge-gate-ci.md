# PR Merge Gate CI Implementation Plan

**Goal:** Add a GitHub pull-request merge gate that runs `rush update`, `rush build`, and all current and future Rush-project test scripts in one required CI job.

**Architecture:** Introduce a single GitHub Actions PR workflow at `.github/workflows/pr-merge-gate.yml`, plus a small repo-owned Node helper under `common/scripts/` that discovers Rush projects with `scripts.test`, runs them sequentially, and aggregates failures. Update contributor docs so the CI contract and GitHub branch-protection rollout are explicit.

**Tech Stack:** GitHub Actions YAML, Node.js 22, Rush helper scripts in `common/scripts/`, TypeScript/JSON package manifests, Markdown docs.

---

## File Map

| File | Responsibility |
|------|----------------|
| `.github/workflows/pr-merge-gate.yml` | PR-only workflow, concurrency cancellation, Node setup, Rush update/build, dynamic test step |
| `common/scripts/run-rush-project-tests.js` | Discover Rush projects with `test` scripts, run them sequentially, aggregate failures, exit non-zero when any test fails |
| `docs/LOCAL_DEVELOPMENT.md` | Contributor-facing explanation of the new PR gate and local preflight expectations |
| `docs/development/design/2026-04-05-pr-merge-gate-ci-design.md` | Approved design reference for implementation |

### Task 1: Add the dynamic Rush-project test runner

**Files:**
- Create: `common/scripts/run-rush-project-tests.js`

- [ ] **Step 1: Write the script with the discovery and aggregation contract**

Create `common/scripts/run-rush-project-tests.js` with Node-only logic that:

```js
#!/usr/bin/env node

const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = resolve(__dirname, '..', '..');
const rushConfig = JSON.parse(readFileSync(join(repoRoot, 'rush.json'), 'utf8'));

async function main() {
  const projects = rushConfig.projects
    .map((project) => {
      const packageJsonPath = join(repoRoot, project.projectFolder, 'package.json');
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      return {
        packageName: project.packageName,
        projectFolder: project.projectFolder,
        testScript: packageJson.scripts && packageJson.scripts.test,
      };
    })
    .filter((project) => typeof project.testScript === 'string' && project.testScript.trim().length > 0);

  if (projects.length === 0) {
    console.log('No Rush projects define a test script.');
    process.exit(0);
  }

  const failures = [];

  console.log('Discovered test projects:');
  for (const project of projects) {
    console.log(`- ${project.packageName} (${project.projectFolder})`);
  }

  for (const project of projects) {
    console.log(`\n==> Testing ${project.packageName} (${project.projectFolder})`);
    const exitCode = await runPackageTest(project.projectFolder);
    if (exitCode !== 0) {
      failures.push(project.packageName);
    }
  }

  if (failures.length > 0) {
    console.error(`\nTest failures: ${failures.join(', ')}`);
    process.exit(1);
  }

  console.log('\nAll Rush project tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Implement `runPackageTest(projectFolder)` using Rush's project-script runner so CI does not rely on a global package-manager binary:

- spawn `node`, passing `['common/scripts/install-run-rushx.js', 'test']`
- set `cwd: join(repoRoot, projectFolder)`
- set `stdio: 'inherit'`

Wrap the child process in a Promise that resolves to the child exit code.

Implementation requirements:

- preserve the Rush project order from `rush.json` for stable logs;
- do not rely on `npm`, `pnpm`, or other global package-manager binaries;
- continue after failures and collect every failing package;
- fail only at the end if one or more packages failed;
- keep output simple and readable for GitHub Actions logs;
- do not shell out through `sh -c`.

- [ ] **Step 2: Run the script locally against the current repo**

Run: `node common/scripts/run-rush-project-tests.js`
Expected: the script discovers the current test-bearing Rush projects, runs each package's existing `npm run test`, and exits `0` only if they all pass.

- [ ] **Step 3: Commit**

```bash
git add common/scripts/run-rush-project-tests.js
git commit -m "feat(ci): add Rush project test runner"
```

### Task 2: Add the GitHub PR merge-gate workflow

**Files:**
- Create: `.github/workflows/pr-merge-gate.yml`

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/pr-merge-gate.yml` with this structure:

```yaml
name: PR Merge Gate

permissions:
  contents: read

on:
  pull_request:
    types:
      - opened
      - synchronize
      - reopened
      - ready_for_review

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  pr-merge-gate:
    name: pr-merge-gate
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
          cache-dependency-path: common/config/rush/pnpm-lock.yaml

      - name: Rush Update
        run: node common/scripts/install-run-rush.js update

      - name: Rush Build
        run: node common/scripts/install-run-rush.js build

      - name: Run All Project Tests
        run: node common/scripts/run-rush-project-tests.js
```

Keep the job *display name* stable as `pr-merge-gate` (via `jobs.<id>.name`) so the GitHub check shown on pull requests remains predictable for branch-protection rollout.

- [ ] **Step 2: Validate YAML shape visually and by dry inspection**

Run: `sed -n '1,220p' .github/workflows/pr-merge-gate.yml`
Expected: the file shows a single PR-only job, stable concurrency group, `cancel-in-progress: true`, Node 22 setup, and the three merge-gate phases in order.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pr-merge-gate.yml
git commit -m "feat(ci): add PR merge gate workflow"
```

### Task 3: Document the CI contract for contributors

**Files:**
- Modify: `docs/LOCAL_DEVELOPMENT.md`

- [ ] **Step 1: Add a short CI expectations section**

Update `docs/LOCAL_DEVELOPMENT.md` to include a concise section near the install/build guidance or summary that states:

- every pull request runs the `PR Merge Gate` workflow;
- the gate runs `rush update`, `rush build`, and all Rush-project `test` scripts;
- contributors should run the same checks locally before updating a PR when practical;
- any new Rush project expected to participate in CI must define a `test` script in its `package.json`.

Recommended text shape:

```md
## Pull Request Gate

Every GitHub pull request runs the `PR Merge Gate` workflow.

The gate executes:

- `node common/scripts/install-run-rush.js update`
- `node common/scripts/install-run-rush.js build`
- `node common/scripts/run-rush-project-tests.js`

If you add a new Rush project and want it covered automatically, define a `test` script in that project's `package.json`.
```

- [ ] **Step 2: Review the doc in context**

Run: `sed -n '1,260p' docs/LOCAL_DEVELOPMENT.md`
Expected: the new section reads naturally with the existing local setup instructions and does not contradict current commands.

- [ ] **Step 3: Commit**

```bash
git add docs/LOCAL_DEVELOPMENT.md
git commit -m "docs: describe PR merge gate workflow"
```

### Task 4: Document GitHub rollout for required merge blocking

**Files:**
- Modify: `docs/LOCAL_DEVELOPMENT.md`

- [ ] **Step 1: Add rollout instructions for required status checks**

Extend the same doc, or add a short adjacent subsection, with explicit operational guidance:

```md
## GitHub Rollout

To make this workflow block merges, configure branch protection in GitHub so the single check shown for this workflow on pull requests is required for the protected branch.
```

Spell out these details in prose:

- this is a GitHub repository setting, not something enforced by the workflow file alone;
- the required check name must match the check name GitHub shows on pull requests after the workflow lands;
- in GitHub UI this typically appears as either `pr-merge-gate` or `PR Merge Gate / pr-merge-gate` (workflow name plus job name);
- branch protection should be updated after the workflow lands and appears at least once on a PR so the check appears in the dropdown.

- [ ] **Step 2: Review the updated doc for clarity**

Run: `sed -n '1,320p' docs/LOCAL_DEVELOPMENT.md`
Expected: contributor CI expectations and GitHub rollout guidance are both present and not redundant.

- [ ] **Step 3: Commit**

```bash
git add docs/LOCAL_DEVELOPMENT.md
git commit -m "docs: add GitHub required-check rollout guidance"
```

### Task 5: Verify the full merge-gate contract locally

**Files:**
- Verify: `.github/workflows/pr-merge-gate.yml`
- Verify: `common/scripts/run-rush-project-tests.js`
- Verify: `docs/LOCAL_DEVELOPMENT.md`

- [ ] **Step 1: Run the local merge-gate commands in workflow order**

Run: `node common/scripts/install-run-rush.js update`
Expected: PASS.

Run: `node common/scripts/install-run-rush.js build`
Expected: PASS.

Run: `node common/scripts/run-rush-project-tests.js`
Expected: PASS after running every Rush project with a `test` script.

- [ ] **Step 2: Inspect git diff for the feature scope**

Run: `git status --short && git diff -- .github/workflows/pr-merge-gate.yml common/scripts/run-rush-project-tests.js docs/LOCAL_DEVELOPMENT.md`
Expected: only the workflow, helper script, and documentation changes for this feature are present.

- [ ] **Step 3: Commit the verification-complete state**

```bash
git add .github/workflows/pr-merge-gate.yml common/scripts/run-rush-project-tests.js docs/LOCAL_DEVELOPMENT.md
git commit -m "chore(ci): wire PR merge gate end to end"
```

### Task 6: Validate the GitHub-required-check rollout on a real PR

**Files:**
- Verify externally in GitHub UI after merge or on a test PR

- [ ] **Step 1: Open a pull request containing the workflow**

Expected: GitHub shows one workflow named `PR Merge Gate` with a single job/check named `pr-merge-gate`.

- [ ] **Step 2: Push a follow-up commit while the first run is still executing**

Expected: the older in-progress run is canceled automatically because the workflow concurrency group uses `cancel-in-progress: true`.

- [ ] **Step 3: Configure branch protection to require the check**

In GitHub repository settings, add the single check shown by the workflow on pull requests to the protected branch rule.

Expected: the PR cannot be merged while the check is failing or pending.

- [ ] **Step 4: Record rollout completion in the PR description or release note**

Expected: reviewers have explicit confirmation that the repo-side workflow and the GitHub-side required-check setting are both in place.
