# Setup Hook Strict Shell Implementation Plan

**Goal:** Enforce `bash -euo pipefail` for every setup hook execution and repair the repository-owned LocalAgent setup hook so it runs correctly under the stricter contract.

**Architecture:** Keep the change isolated to the existing setup-hook execution path. `SetupHookRunner` will switch from permissive `bash -c` execution to strict invocation-level bash flags, while `JobEnvironment` and the enrichment schema remain unchanged. Existing tests will be updated only where the stricter shell contract changes behavior, and the checked-in `local-agent.yaml` hook will be repaired as part of rollout.

**Tech Stack:** TypeScript, Vitest, bash, YAML

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/daemon/task/src/services/setup-hook-runner.ts` | Modify | Enforce strict bash invocation for setup hooks |
| `packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts` | Modify | Verify runner behavior still works under strict shell execution |
| `packages/daemon/task-enrichment/config/local-agent.yaml` | Modify | Repair the repository-owned hook so it no longer attempts to execute `./LocalAgent` as a command |
| `packages/daemon/task/src/services/__tests__/job-environment.test.ts` | Modify only if needed | Adjust fixture/expectation fallout if stricter execution changes observable behavior |

---

### Task 1: Switch `SetupHookRunner` to strict bash invocation

**Files:**
- Modify: `packages/daemon/task/src/services/setup-hook-runner.ts`
- Modify: `packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts`

- [ ] **Step 1: Add failing strict-mode regression tests (and fix test context)**

In `packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts`:

- Update the shared `ctx` fixture to include `session_id` (so `LOCALAGENT_SESSION_ID` is never accidentally set to `undefined`).
- Extend the existing env-var test to also validate `LOCALAGENT_SESSION_ID` and `LOCALAGENT_PAYLOAD` are passed through.
- Add small, direct regression tests for each strict-mode requirement using scripts that would have succeeded previously but must now fail.

Examples:

```ts
it('enforces -e (exits on a non-zero command even if a later command succeeds)', async () => {
  const script = 'false; true';
  await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toThrow(/Setup hook failed/);
});

it('enforces -u (fails on unset variable expansion)', async () => {
  const script = 'echo "$THIS_VAR_IS_NOT_SET"';
  await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toThrow(/Setup hook failed/);
});

it('enforces pipefail (fails when a pipeline command before the final command fails)', async () => {
  const script = 'false | true';
  await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toThrow(/Setup hook failed/);
});
```

This keeps coverage focused while preventing partial implementations (for example, adding `pipefail` but forgetting `-u`).

- [ ] **Step 2: Run the focused runner test file and confirm the new test fails first**

Run: `cd packages/daemon/task && npx vitest run src/services/__tests__/setup-hook-runner.test.ts`
Expected: FAIL because the runner still uses permissive `bash -c`.

- [ ] **Step 3: Update the runner invocation to strict bash mode**

In `packages/daemon/task/src/services/setup-hook-runner.ts`, change:

```ts
await execFileAsync('bash', ['-c', script], {
```

to:

```ts
await execFileAsync('bash', ['-e', '-u', '-o', 'pipefail', '-c', script], {
```

Keep the rest of the method unchanged:

- same environment variable injection
- same timeout and maxBuffer
- same stdout/stderr logging
- same `Setup hook failed: ...` error formatting

- [ ] **Step 4: Re-run the focused runner test file**

Run: `cd packages/daemon/task && npx vitest run src/services/__tests__/setup-hook-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the runner change**

Note: This repo does not require splitting changes into multiple commits. If you prefer a single atomic commit for the behavior change + config repair + tests, do that instead and skip Task 2/3 commit steps.

```bash
git add packages/daemon/task/src/services/setup-hook-runner.ts \
        packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts
git commit -m "feat(task-daemon): enforce strict shell mode for setup hooks"
```

---

### Task 2: Repair the checked-in LocalAgent setup hook

**Files:**
- Modify: `packages/daemon/task-enrichment/config/local-agent.yaml`

- [ ] **Step 1: Fix the broken repo-navigation line in the checked-in hook**

In `packages/daemon/task-enrichment/config/local-agent.yaml`, replace:

```yaml
./LocalAgent && git config --local user.name "Kim Yongbeom" && git config --local user.email "dernbu@gmail.com"
```

with `cd ./LocalAgent` as the chosen repair:

```yaml
cd ./LocalAgent && git config --local user.name "Kim Yongbeom" && git config --local user.email "dernbu@gmail.com"
```

Recommended final content:

```yaml
setup_hook: |
  git clone --depth 1 git@github.com:Yongbeom-Kim/LocalAgent.git ./LocalAgent
  cd ./LocalAgent
  git config --local user.name "Kim Yongbeom"
  git config --local user.email "dernbu@gmail.com"
  nohup git fetch --unshallow --tags </dev/null &>/dev/null &
```

Splitting the two `git config` calls across lines makes failures easier to localize under `-e`.

- [ ] **Step 2: Sanity-check the YAML formatting**

Run: `sed -n '1,40p' packages/daemon/task-enrichment/config/local-agent.yaml`
Expected: the block scalar remains valid YAML and the hook lines are indented consistently.

- [ ] **Step 3: Commit the config repair**

```bash
git add packages/daemon/task-enrichment/config/local-agent.yaml
git commit -m "fix(config): repair localagent setup hook"
```

---

### Task 3: Run affected task-daemon verification and handle fallout

**Files:**
- Test: `packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts`
- Test: `packages/daemon/task/src/services/__tests__/job-environment.test.ts`
- Modify only if needed: `packages/daemon/task/src/services/__tests__/job-environment.test.ts`

- [ ] **Step 1: Run the setup-hook and job-environment test files together**

Run: `cd packages/daemon/task && npx vitest run src/services/__tests__/setup-hook-runner.test.ts src/services/__tests__/job-environment.test.ts`
Expected: PASS.

- [ ] **Step 2: Fix any test fallout caused by strict shell execution**

Only if the command above fails, adjust `packages/daemon/task/src/services/__tests__/job-environment.test.ts` expectations or fixtures so they match the unchanged external contract:

- setup still fails when the hook fails
- cleanup behavior remains the same
- no new logging or schema assumptions are introduced

- [ ] **Step 3: Re-run the affected tests after any fixes**

Run: `cd packages/daemon/task && npx vitest run src/services/__tests__/setup-hook-runner.test.ts src/services/__tests__/job-environment.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit any verification fallout fix if needed**

```bash
git add packages/daemon/task/src/services/__tests__/job-environment.test.ts
git commit -m "test(task-daemon): align setup hook tests with strict shell contract"
```

Skip this commit if no fallout fix was required.
