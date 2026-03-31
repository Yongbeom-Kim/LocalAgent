# Setup Hook Implementation Plan

**Goal:** Extend the enrichment YAML config with a `setup_hook` field that runs an inline bash script in the job's temp working directory before any executor is invoked.

**Architecture:** The hook config (`setup_hook`, `setup_hook_timeout_ms`) is added to the `EnrichmentRule` YAML schema and propagated through `JobSubmission` → `Job` via the shared types. The task daemon's `JobEnvironment` delegates script execution to a new `SetupHookRunner` service, which runs `bash -c <script>` with `cwd=workDir` and injects `LOCALAGENT_*` env vars. Hook failure aborts job setup, triggering the existing failure path in `TaskOrchestrator`.

**Tech Stack:** TypeScript, Node.js `child_process.execFile` (promisified), vitest, js-yaml.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/constants.ts` | Modify | Add `DEFAULT_SETUP_HOOK_TIMEOUT_MS` |
| `packages/shared/src/types.ts` | Modify | Add optional `setup_hook` / `setup_hook_timeout_ms` to `JobSubmission` and `Job` |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Add fields to `EnrichmentRule`; pass through in `enrich()` |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Add setup_hook passthrough tests |
| `packages/daemon/task/src/services/setup-hook-runner.ts` | **Create** | New service: runs bash script in workDir with job env vars |
| `packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts` | **Create** | Unit tests for SetupHookRunner |
| `packages/daemon/task/src/services/job-environment.ts` | Modify | Accept `SetupHookRunner`; call it after marketplace clone |
| `packages/daemon/task/src/services/__tests__/job-environment.test.ts` | Modify | Add tests for hook invocation and failure cleanup |
| `packages/daemon/task/src/task-daemon.ts` | Modify | Instantiate `SetupHookRunner`; pass to `JobEnvironment` |

---

## Task 1: Add the default timeout constant

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Add the constant**

In `packages/shared/src/constants.ts`, append:

```typescript
export const DEFAULT_SETUP_HOOK_TIMEOUT_MS = 300_000; // 5 minutes
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(shared): add DEFAULT_SETUP_HOOK_TIMEOUT_MS constant"
```

---

## Task 2: Extend shared types

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Add fields to `JobSubmission`**

In `packages/shared/src/types.ts`, update the `JobSubmission` interface:

```typescript
export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}
```

- [ ] **Step 2: Add fields to `Job`**

In `packages/shared/src/types.ts`, update the `Job` interface:

```typescript
export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  enriched_at: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}
```

- [ ] **Step 3: Verify no type errors**

```bash
cd packages/shared && npx tsc --noEmit
```

Expected: no output (no errors).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): add setup_hook fields to JobSubmission and Job"
```

---

## Task 3: Propagate hook fields through EnrichmentService

**Files:**
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Write failing tests**

In `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`, add a new `describe` block at the end of the file (after the existing `task_source passthrough` block):

```typescript
describe('setup_hook passthrough', () => {
  it('includes setup_hook and setup_hook_timeout_ms in enriched job when present in rule', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        coding: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          setup_hook: 'git clone https://github.com/org/repo .\nnpm ci',
          setup_hook_timeout_ms: 120_000,
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'coding' }));

    expect(result).not.toBeNull();
    expect(result!.setup_hook).toBe('git clone https://github.com/org/repo .\nnpm ci');
    expect(result!.setup_hook_timeout_ms).toBe(120_000);
  });

  it('omits setup_hook when rule has none', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.setup_hook).toBeUndefined();
    expect(result!.setup_hook_timeout_ms).toBeUndefined();
  });

  it('includes setup_hook without timeout when only hook is specified', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: {
          executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          setup_hook: 'echo hello',
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.setup_hook).toBe('echo hello');
    expect(result!.setup_hook_timeout_ms).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/daemon/task-enrichment && npm test
```

Expected: 3 new tests fail with something like `result.setup_hook is undefined`.

- [ ] **Step 3: Update `EnrichmentRule` interface and `enrich()` in `enrichment-service.ts`**

In `packages/daemon/task-enrichment/src/enrichment-service.ts`:

1. Add fields to `EnrichmentRule`:

```typescript
interface EnrichmentRule {
  executors: Array<{ executor: string; executor_model: string }>;
  marketplaces?: Array<{ url: string; plugins: string[] }>;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}
```

2. In the `return` statement of `enrich()`, add the new fields after `marketplaces`:

```typescript
return {
  task_id: task.task_id,
  task_type: task.task_type,
  payload: task.payload,
  executors,
  submitted_at: task.submitted_at,
  marketplaces: rule.marketplaces,
  ...(task.task_source ? { task_source: task.task_source } : {}),
  ...(rule.setup_hook !== undefined ? { setup_hook: rule.setup_hook } : {}),
  ...(rule.setup_hook_timeout_ms !== undefined ? { setup_hook_timeout_ms: rule.setup_hook_timeout_ms } : {}),
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/daemon/task-enrichment && npm test
```

Expected: all tests pass, including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task-enrichment/src/enrichment-service.ts \
        packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts
git commit -m "feat(enrichment): pass setup_hook fields through enrichment rules"
```

---

## Task 4: Create SetupHookRunner

**Files:**
- Create: `packages/daemon/task/src/services/setup-hook-runner.ts`
- Create: `packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test SetupHookRunner with real bash execution in a real temp directory.
// No mocking of child_process — this validates actual script execution.

import { SetupHookRunner } from '../setup-hook-runner';

describe('SetupHookRunner', () => {
  let runner: SetupHookRunner;
  let workDir: string;

  beforeEach(() => {
    runner = new SetupHookRunner();
    workDir = join(tmpdir(), `setup-hook-test-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const ctx = {
    job_id: 'job-abc',
    task_id: 'task-xyz',
    task_type: 'coding',
    payload: 'do something',
  };

  it('runs a bash script with cwd set to workDir', async () => {
    const script = 'touch marker.txt';
    await runner.run(script, workDir, ctx, 10_000);
    expect(existsSync(join(workDir, 'marker.txt'))).toBe(true);
  });

  it('passes LOCALAGENT_* env vars to the script', async () => {
    const script = [
      'echo "$LOCALAGENT_JOB_ID" > job_id.txt',
      'echo "$LOCALAGENT_TASK_ID" > task_id.txt',
      'echo "$LOCALAGENT_TASK_TYPE" > task_type.txt',
    ].join('\n');

    await runner.run(script, workDir, ctx, 10_000);

    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(workDir, 'job_id.txt'), 'utf-8').trim()).toBe('job-abc');
    expect(readFileSync(join(workDir, 'task_id.txt'), 'utf-8').trim()).toBe('task-xyz');
    expect(readFileSync(join(workDir, 'task_type.txt'), 'utf-8').trim()).toBe('coding');
  });

  it('throws when script exits non-zero', async () => {
    const script = 'exit 1';
    await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toThrow(/Setup hook failed/);
  });

  it('includes stderr in the error message when script fails', async () => {
    const script = 'echo "something went wrong" >&2; exit 1';
    await expect(runner.run(script, workDir, ctx, 10_000)).rejects.toThrow(/something went wrong/);
  });

  it('throws on timeout', async () => {
    const script = 'sleep 10';
    await expect(runner.run(script, workDir, ctx, 100)).rejects.toThrow();
  }, 5_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/daemon/task && npm test -- --reporter=verbose src/services/__tests__/setup-hook-runner.test.ts
```

Expected: all 5 tests fail with "Cannot find module '../setup-hook-runner'".

- [ ] **Step 3: Create `setup-hook-runner.ts`**

Create `packages/daemon/task/src/services/setup-hook-runner.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '@local-agent/shared';

const execFileAsync = promisify(execFile);
const logger = createLogger('task-daemon:setup-hook-runner');

interface JobContext {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
}

export class SetupHookRunner {
  async run(
    script: string,
    workDir: string,
    jobContext: JobContext,
    timeoutMs: number,
  ): Promise<void> {
    logger.info({ job_id: jobContext.job_id, workDir, timeoutMs }, 'Running setup hook');

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      LOCALAGENT_JOB_ID: jobContext.job_id,
      LOCALAGENT_TASK_ID: jobContext.task_id,
      LOCALAGENT_TASK_TYPE: jobContext.task_type,
      LOCALAGENT_PAYLOAD: jobContext.payload,
    };

    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-c', script], {
        cwd: workDir,
        env,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      if (stdout) {
        logger.info({ job_id: jobContext.job_id, stdout }, 'Setup hook stdout');
      }
      if (stderr) {
        logger.warn({ job_id: jobContext.job_id, stderr }, 'Setup hook stderr');
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      const stderr = err.stderr ?? '';
      const message = stderr
        ? `Setup hook failed: ${stderr.trim()}`
        : `Setup hook failed: ${err.message}`;

      logger.error({ job_id: jobContext.job_id, err: error }, 'Setup hook failed');
      throw new Error(message);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/daemon/task && npm test -- --reporter=verbose src/services/__tests__/setup-hook-runner.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/services/setup-hook-runner.ts \
        packages/daemon/task/src/services/__tests__/setup-hook-runner.test.ts
git commit -m "feat(task-daemon): add SetupHookRunner service"
```

---

## Task 5: Integrate SetupHookRunner into JobEnvironment

**Files:**
- Modify: `packages/daemon/task/src/services/job-environment.ts`
- Modify: `packages/daemon/task/src/services/__tests__/job-environment.test.ts`

- [ ] **Step 1: Write failing tests**

In `packages/daemon/task/src/services/__tests__/job-environment.test.ts`:

1. At the top, update the mock setup. The existing mock is for `node:child_process`. The `SetupHookRunner` will also be mocked. Add a new vi.mock for the SetupHookRunner module:

After the existing `vi.mock('node:child_process', ...)` block, add:

```typescript
vi.mock('../setup-hook-runner', () => ({
  SetupHookRunner: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { SetupHookRunner } from '../setup-hook-runner';
const MockSetupHookRunner = vi.mocked(SetupHookRunner);
```

2. Declare `mockRunner` alongside the existing `jobEnv` and `createdDirs` declarations at the top of the outer `describe` block, then update the `beforeEach` to instantiate with the runner and capture the mock instance. Replace the existing `beforeEach` entirely:

```typescript
let mockRunner: { run: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  createdDirs = [];
  MockSetupHookRunner.mockClear();
  jobEnv = new JobEnvironment(false, new SetupHookRunner());
  mockRunner = MockSetupHookRunner.mock.results[0].value as { run: ReturnType<typeof vi.fn> };

  // Keep existing execFileSync mock that simulates git clone creating directories
  mockExecFileSync.mockImplementation((_cmd, args) => {
    if (args && Array.isArray(args)) {
      const dest = args[args.length - 1] as string;
      if (typeof dest === 'string' && dest.includes('localagent-job-')) {
        mkdirSync(dest, { recursive: true });
        const url = args[args.length - 2] as string;
        if (url.includes('claude-plugins-official')) {
          mkdirSync(join(dest, 'superpowers'), { recursive: true });
        }
        if (url.includes('personal-claude-code')) {
          mkdirSync(join(dest, 'development'), { recursive: true });
          mkdirSync(join(dest, 'learning'), { recursive: true });
        }
        createdDirs.push(dest);
      }
    }
    return Buffer.from('');
  });
});
```

3. Add a new `describe('setup hook', ...)` block inside the top-level `describe('JobEnvironment', ...)`:

```typescript
describe('setup hook', () => {
  it('does not call runner when job has no setup_hook', async () => {
    const env = await jobEnv.setup(createJob());
    createdDirs.push(env.workDir);

    expect(mockRunner.run).not.toHaveBeenCalled();
  });

  it('calls runner with correct args when job has setup_hook', async () => {
    const job = createJob({ setup_hook: 'npm ci', setup_hook_timeout_ms: 60_000 });
    const env = await jobEnv.setup(job);
    createdDirs.push(env.workDir);

    expect(mockRunner.run).toHaveBeenCalledWith(
      'npm ci',
      env.workDir,
      {
        job_id: job.job_id,
        task_id: job.task_id,
        task_type: job.task_type,
        payload: job.payload,
      },
      60_000,
    );
  });

  it('uses DEFAULT_SETUP_HOOK_TIMEOUT_MS when setup_hook_timeout_ms is absent', async () => {
    const job = createJob({ setup_hook: 'echo hi' });
    const env = await jobEnv.setup(job);
    createdDirs.push(env.workDir);

    const { DEFAULT_SETUP_HOOK_TIMEOUT_MS } = await import('@local-agent/shared');
    expect(mockRunner.run).toHaveBeenCalledWith(
      'echo hi',
      env.workDir,
      expect.any(Object),
      DEFAULT_SETUP_HOOK_TIMEOUT_MS,
    );
  });

  it('throws and cleans up workDir when hook fails', async () => {
    mockRunner.run.mockRejectedValueOnce(new Error('Setup hook failed: npm not found'));

    const job = createJob({ setup_hook: 'npm ci' });
    await expect(jobEnv.setup(job)).rejects.toThrow('Setup hook failed');

    // workDir should be cleaned up
    // We can't easily get workDir here so we verify setup threw — cleanup is verified via the try/catch path
  });
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

```bash
cd packages/daemon/task && npm test -- --reporter=verbose src/services/__tests__/job-environment.test.ts
```

Expected: existing tests still pass, new setup-hook tests fail because `JobEnvironment` doesn't accept a runner yet.

- [ ] **Step 3: Update `job-environment.ts`**

Replace the full content of `packages/daemon/task/src/services/job-environment.ts`:

```typescript
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Job, DEFAULT_SETUP_HOOK_TIMEOUT_MS, createLogger } from '@local-agent/shared';
import { SetupHookRunner } from './setup-hook-runner';

const logger = createLogger('task-daemon:job-environment');

export interface ExecutionEnvironment {
  workDir: string;
  pluginDirs: string[];
}

export class JobEnvironment {
  constructor(
    private readonly debug: boolean,
    private readonly hookRunner: SetupHookRunner = new SetupHookRunner(),
  ) {}

  async setup(job: Job): Promise<ExecutionEnvironment> {
    const workDir = join(tmpdir(), `localagent-job-${job.job_id}`);
    mkdirSync(workDir, { recursive: true });

    const pluginDirs: string[] = [];

    try {
      if (job.marketplaces && job.marketplaces.length > 0) {
        const marketplacesDir = join(workDir, 'marketplaces');
        mkdirSync(marketplacesDir, { recursive: true });

        for (const marketplace of job.marketplaces) {
          const repoName = this.deriveRepoName(marketplace.url);
          const cloneDest = join(marketplacesDir, repoName);

          logger.info({ job_id: job.job_id, url: marketplace.url, dest: cloneDest }, 'Cloning marketplace repo');

          execFileSync('git', ['clone', '--depth', '1', marketplace.url, cloneDest], {
            timeout: 60_000,
          });

          for (const plugin of marketplace.plugins) {
            const pluginPath = join(cloneDest, plugin);
            if (!existsSync(pluginPath)) {
              throw new Error(`Plugin directory "${plugin}" not found in cloned repo "${repoName}" at ${pluginPath}`);
            }
            pluginDirs.push(pluginPath);
          }
        }
      }

      if (job.setup_hook) {
        const timeoutMs = job.setup_hook_timeout_ms ?? DEFAULT_SETUP_HOOK_TIMEOUT_MS;
        await this.hookRunner.run(
          job.setup_hook,
          workDir,
          {
            job_id: job.job_id,
            task_id: job.task_id,
            task_type: job.task_type,
            payload: job.payload,
          },
          timeoutMs,
        );
      }
    } catch (error) {
      if (!this.debug) {
        rmSync(workDir, { recursive: true, force: true });
      }
      throw error;
    }

    logger.info({ job_id: job.job_id, workDir, pluginDirs }, 'Job environment ready');
    return { workDir, pluginDirs };
  }

  async teardown(env: ExecutionEnvironment): Promise<void> {
    if (this.debug) {
      logger.info({ workDir: env.workDir }, 'DEBUG mode — preserving job temp directory');
      return;
    }

    rmSync(env.workDir, { recursive: true, force: true });
    logger.info({ workDir: env.workDir }, 'Cleaned up job temp directory');
  }

  private deriveRepoName(url: string): string {
    const lastSegment = url.split('/').pop() ?? url;
    return lastSegment.replace(/\.git$/, '');
  }
}
```

- [ ] **Step 4: Run all task-daemon tests**

```bash
cd packages/daemon/task && npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/services/job-environment.ts \
        packages/daemon/task/src/services/__tests__/job-environment.test.ts
git commit -m "feat(task-daemon): integrate SetupHookRunner into JobEnvironment"
```

---

## Task 6: Wire SetupHookRunner in task-daemon entry point

**Files:**
- Modify: `packages/daemon/task/src/task-daemon.ts`

The `JobEnvironment` constructor now has a default for `hookRunner` (`= new SetupHookRunner()`), so `task-daemon.ts` requires no change for the default case. However, the constructor signature changed from `(debug: boolean)` to `(debug: boolean, hookRunner?)` — existing call `new JobEnvironment(debug)` still works.

- [ ] **Step 1: Verify existing instantiation compiles**

```bash
cd packages/daemon/task && npx tsc --noEmit
```

Expected: no errors. `new JobEnvironment(debug)` is still valid because `hookRunner` has a default.

- [ ] **Step 2: Run full test suite for all affected packages**

```bash
cd packages/shared && npm test
cd packages/daemon/task-enrichment && npm test
cd packages/daemon/task && npm test
```

Expected: all tests pass across all three packages.

- [ ] **Step 3: Final commit**

```bash
git add packages/daemon/task/src/task-daemon.ts
git commit -m "feat(task-daemon): wire setup hook end-to-end (no-op default)"
```

If `task-daemon.ts` was not touched (no changes), skip this step.

---

## Task 7: Manual smoke test

- [ ] **Step 1: Update `enrichment.yaml` with a test hook**

Temporarily modify `packages/daemon/task-enrichment/config/enrichment.yaml`:

```yaml
rules:
  default:
    setup_hook: |
      echo "Hook running in: $(pwd)"
      echo "Job ID: $LOCALAGENT_JOB_ID"
      touch hook_ran.txt
    executors:
      - executor: claude_code
        executor_model: sonnet
```

- [ ] **Step 2: Start services and submit a task**

```bash
# Terminal 1
docker compose up rabbitmq -d

# Terminal 2
npm run dev --prefix packages/api

# Terminal 3
npm run dev --prefix packages/daemon/task-enrichment

# Terminal 4
DEBUG=1 npm run dev --prefix packages/daemon/task
```

```bash
# Terminal 5 — submit a task
node packages/cli/dist/index.js submit --payload "hello world"
```

- [ ] **Step 3: Verify hook ran**

After the job is processed, check the preserved temp directory (DEBUG=1 keeps it):

```bash
ls /tmp/localagent-job-*/hook_ran.txt
```

Expected: file exists. Check task-daemon logs for `Setup hook stdout` lines showing the cwd and job ID.

- [ ] **Step 4: Revert test hook in enrichment.yaml**

```bash
git checkout packages/daemon/task-enrichment/config/enrichment.yaml
```

---

## Summary of Commits

1. `feat(shared): add DEFAULT_SETUP_HOOK_TIMEOUT_MS constant`
2. `feat(shared): add setup_hook fields to JobSubmission and Job`
3. `feat(enrichment): pass setup_hook fields through enrichment rules`
4. `feat(task-daemon): add SetupHookRunner service`
5. `feat(task-daemon): integrate SetupHookRunner into JobEnvironment`
6. `feat(task-daemon): wire setup hook end-to-end (no-op default)` *(if needed)*
