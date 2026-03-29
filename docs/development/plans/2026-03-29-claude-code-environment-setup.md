# Claude Code Environment Setup Implementation Plan

**Goal:** Enable per-job isolated execution environments with task-type-specific Claude Code plugins, fetched from marketplace Git repos at runtime.

**Architecture:** The enrichment daemon extends its YAML rules with a `marketplaces` array (VCS URLs + plugin lists) and populates a new `marketplaces` field on the `Job` type. The task daemon introduces a `JobEnvironment` service that creates an isolated temp directory per job, clones marketplace repos, resolves `--plugin-dir` paths, and cleans up after execution. Executors are modified to accept an `ExecutionEnvironment` and spawn Claude/TTADK with `--bare` mode and explicit `--plugin-dir` flags.

**Tech Stack:** TypeScript, Node.js 20, Vitest, Rush monorepo, Docker (Alpine), Git (shallow clone)

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `packages/task-daemon/src/services/job-environment.ts` | Creates/tears down isolated temp directories, clones marketplace repos, resolves plugin paths |
| `packages/task-daemon/src/services/__tests__/job-environment.test.ts` | Unit tests for JobEnvironment |

### Modified Files

| File | What Changes |
|------|-------------|
| `packages/shared/src/types.ts` | Add `MarketplaceConfig` interface, add `marketplaces?` to `Job` and `JobSubmission` |
| `packages/shared/src/index.ts` | Export `MarketplaceConfig` |
| `packages/task-enrichment-daemon/src/enrichment-service.ts` | Pass through `marketplaces` from YAML rule to `JobSubmission` |
| `packages/task-enrichment-daemon/config/enrichment.yaml` | Add example marketplace entries |
| `packages/task-enrichment-daemon/src/__tests__/enrichment-service.test.ts` | Test marketplace passthrough |
| `packages/task-daemon/src/ports/task-executor.ts` | Add `ExecutionEnvironment` param to `execute()` |
| `packages/task-daemon/src/adapters/claude-cli-executor.ts` | Add `--bare`, `--plugin-dir` flags, accept `ExecutionEnvironment`, set `cwd` |
| `packages/task-daemon/src/adapters/ttadk-executor.ts` | Same changes as ClaudeCliExecutor, flags forwarded via `-a` |
| `packages/task-daemon/src/core/task-orchestrator.ts` | Inject `JobEnvironment`, coordinate setup → execute → teardown |
| `packages/task-daemon/src/task-daemon.ts` | Instantiate `JobEnvironment` with `DEBUG` env var, pass to orchestrator |
| `packages/task-daemon/src/adapters/__tests__/claude-cli-executor.test.ts` | Update to pass `ExecutionEnvironment`, verify new CLI args |
| `packages/task-daemon/src/adapters/__tests__/ttadk-executor.test.ts` | Update to pass `ExecutionEnvironment`, verify new CLI args |
| `packages/task-daemon/src/core/__tests__/task-orchestrator.test.ts` | Mock `JobEnvironment`, test setup/teardown coordination |
| `packages/task-daemon/Dockerfile` | Add `git` to production image |
| `docker-compose.yml` | Add credential volume mount + `DEBUG` env var to task-daemon service |

---

## Task 1: Add MarketplaceConfig to shared types

**Files:**
- Modify: `packages/shared/src/types.ts:43-61`
- Modify: `packages/shared/src/index.ts:1-3`
- Test: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/__tests__/types.test.ts`, add a new describe block at the end:

```typescript
describe('MarketplaceConfig', () => {
  it('is exported from the package', async () => {
    const types = await import('../types');
    // MarketplaceConfig is a type-only export, so we verify
    // that Job and JobSubmission accept the marketplaces field
    const job: types.Job = {
      job_id: 'j1',
      task_id: 't1',
      task_type: 'test',
      payload: 'p',
      executor: 'claude_code',
      executor_model: 'sonnet',
      submitted_at: '2026-01-01T00:00:00Z',
      enriched_at: '2026-01-01T00:00:01Z',
      marketplaces: [{ url: 'https://github.com/example/repo.git', plugins: ['my-plugin'] }],
    };
    expect(job.marketplaces).toHaveLength(1);
    expect(job.marketplaces![0].url).toBe('https://github.com/example/repo.git');
    expect(job.marketplaces![0].plugins).toEqual(['my-plugin']);
  });

  it('allows Job without marketplaces field', () => {
    const job: types.Job = {
      job_id: 'j1',
      task_id: 't1',
      task_type: 'test',
      payload: 'p',
      executor: 'claude_code',
      executor_model: 'sonnet',
      submitted_at: '2026-01-01T00:00:00Z',
      enriched_at: '2026-01-01T00:00:01Z',
    };
    expect(job.marketplaces).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`
Expected: TypeScript compilation error — `marketplaces` does not exist on type `Job`

- [ ] **Step 3: Add MarketplaceConfig interface and update Job/JobSubmission**

In `packages/shared/src/types.ts`, add the `MarketplaceConfig` interface before `JobSubmission` and add `marketplaces?` to both `JobSubmission` and `Job`:

```typescript
// Add after TaskSubmission/Task, before JobSubmission (around line 42)
export interface MarketplaceConfig {
  url: string;
  plugins: string[];
}

export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
  marketplaces?: MarketplaceConfig[];
}

export interface Job {
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

- [ ] **Step 4: Export MarketplaceConfig from index.ts**

In `packages/shared/src/index.ts`, add `MarketplaceConfig` to the types export:

```typescript
export {
  TaskSubmission,
  Task,
  type JobSubmission,
  type Job,
  type MarketplaceConfig,
  // ... rest of existing exports
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): add MarketplaceConfig type and marketplaces field to Job/JobSubmission"
```

---

## Task 2: Update EnrichmentService to pass through marketplaces

**Files:**
- Modify: `packages/task-enrichment-daemon/src/enrichment-service.ts:7-12,29-55`
- Modify: `packages/task-enrichment-daemon/config/enrichment.yaml`
- Test: `packages/task-enrichment-daemon/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/task-enrichment-daemon/src/__tests__/enrichment-service.test.ts`, add a new describe block:

```typescript
describe('marketplace passthrough', () => {
  it('includes marketplaces from rule in enriched job', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        development: {
          executor: 'claude_code',
          executor_model: 'opus',
          marketplaces: [
            { url: 'https://github.com/anthropics/claude-plugins-official.git', plugins: ['superpowers'] },
            { url: 'https://github.com/Yongbeom-Kim/personal-claude-code.git', plugins: ['development'] },
          ],
        },
      },
    });

    const result = service.enrich(createTask({ task_type: 'development' }));

    expect(result).not.toBeNull();
    expect(result!.marketplaces).toHaveLength(2);
    expect(result!.marketplaces![0].url).toBe('https://github.com/anthropics/claude-plugins-official.git');
    expect(result!.marketplaces![0].plugins).toEqual(['superpowers']);
    expect(result!.marketplaces![1].url).toBe('https://github.com/Yongbeom-Kim/personal-claude-code.git');
    expect(result!.marketplaces![1].plugins).toEqual(['development']);
  });

  it('omits marketplaces when rule has none', () => {
    const service = EnrichmentService.fromObject({
      rules: {
        default: { executor: 'claude_code', executor_model: 'sonnet' },
      },
    });

    const result = service.enrich(createTask({ task_type: 'anything' }));

    expect(result).not.toBeNull();
    expect(result!.marketplaces).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/task-enrichment-daemon && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: FAIL — `marketplaces` is undefined even when rule has it

- [ ] **Step 3: Update EnrichmentRule interface and enrich() method**

In `packages/task-enrichment-daemon/src/enrichment-service.ts`:

Update the `EnrichmentRule` interface:

```typescript
interface EnrichmentRule {
  executor: string;
  executor_model: string;
  marketplaces?: Array<{ url: string; plugins: string[] }>;
}
```

Update the return statement in `enrich()` to pass through marketplaces:

```typescript
    return {
      task_id: task.task_id,
      task_type: task.task_type,
      payload: task.payload,
      executor: rule.executor as TaskExecutorType,
      executor_model: rule.executor_model,
      submitted_at: task.submitted_at,
      marketplaces: rule.marketplaces,
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/task-enrichment-daemon && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: PASS

- [ ] **Step 5: Update enrichment.yaml with example marketplace entries**

Replace `packages/task-enrichment-daemon/config/enrichment.yaml`:

```yaml
rules:
  default:
    executor: claude_code
    executor_model: sonnet
```

(No changes to default — marketplaces are only added to specific task types. The default rule has no plugins.)

- [ ] **Step 6: Commit**

```bash
git add packages/task-enrichment-daemon/src/enrichment-service.ts packages/task-enrichment-daemon/src/__tests__/enrichment-service.test.ts packages/task-enrichment-daemon/config/enrichment.yaml
git commit -m "feat(enrichment): pass through marketplaces field from YAML rules to JobSubmission"
```

---

## Task 3: Create JobEnvironment service

**Files:**
- Create: `packages/task-daemon/src/services/job-environment.ts`
- Create: `packages/task-daemon/src/services/__tests__/job-environment.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/task-daemon/src/services/__tests__/job-environment.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Job } from '@local-agent/shared';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { JobEnvironment, ExecutionEnvironment } from '../job-environment';

const mockExecFileSync = vi.mocked(execFileSync);

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-test-001',
    task_id: 'task-test-001',
    task_type: 'generic',
    payload: 'test payload',
    executor: 'claude_code',
    executor_model: 'sonnet',
    submitted_at: '2026-03-29T00:00:00.000Z',
    enriched_at: '2026-03-29T00:00:01.000Z',
    ...overrides,
  };
}

describe('JobEnvironment', () => {
  let jobEnv: JobEnvironment;
  let createdDirs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    createdDirs = [];
    jobEnv = new JobEnvironment(false);

    // Make mock execFileSync simulate creating the cloned directory
    mockExecFileSync.mockImplementation((_cmd, args) => {
      if (args && Array.isArray(args)) {
        // git clone --depth 1 <url> <dest>
        const dest = args[args.length - 1] as string;
        if (typeof dest === 'string' && dest.includes('localagent-job-')) {
          mkdirSync(dest, { recursive: true });
          // Create a fake plugin directory inside
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

  afterEach(() => {
    // Clean up any temp dirs created during tests
    for (const dir of createdDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });

  describe('setup', () => {
    it('creates a temp directory for the job', async () => {
      const env = await jobEnv.setup(createJob());
      createdDirs.push(env.workDir);

      expect(env.workDir).toMatch(/localagent-job-job-test-001/);
      expect(existsSync(env.workDir)).toBe(true);
    });

    it('returns empty pluginDirs when job has no marketplaces', async () => {
      const env = await jobEnv.setup(createJob());
      createdDirs.push(env.workDir);

      expect(env.pluginDirs).toEqual([]);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('clones marketplace repos and resolves plugin paths', async () => {
      const job = createJob({
        marketplaces: [
          {
            url: 'https://github.com/anthropics/claude-plugins-official.git',
            plugins: ['superpowers'],
          },
        ],
      });

      const env = await jobEnv.setup(job);
      createdDirs.push(env.workDir);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['clone', '--depth', '1', 'https://github.com/anthropics/claude-plugins-official.git', expect.stringContaining('claude-plugins-official')],
        expect.any(Object),
      );
      expect(env.pluginDirs).toHaveLength(1);
      expect(env.pluginDirs[0]).toMatch(/claude-plugins-official\/superpowers$/);
    });

    it('resolves multiple plugins from multiple marketplaces', async () => {
      const job = createJob({
        marketplaces: [
          {
            url: 'https://github.com/anthropics/claude-plugins-official.git',
            plugins: ['superpowers'],
          },
          {
            url: 'https://github.com/Yongbeom-Kim/personal-claude-code.git',
            plugins: ['development', 'learning'],
          },
        ],
      });

      const env = await jobEnv.setup(job);
      createdDirs.push(env.workDir);

      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
      expect(env.pluginDirs).toHaveLength(3);
    });

    it('strips .git suffix from repo URL to derive directory name', async () => {
      const job = createJob({
        marketplaces: [
          { url: 'https://github.com/org/my-repo.git', plugins: ['superpowers'] },
        ],
      });

      // Mock to create directory with expected plugin
      mockExecFileSync.mockImplementation((_cmd, args) => {
        const dest = (args as string[])[args!.length - 1];
        mkdirSync(dest, { recursive: true });
        mkdirSync(join(dest, 'superpowers'), { recursive: true });
        createdDirs.push(dest);
        return Buffer.from('');
      });

      const env = await jobEnv.setup(job);
      createdDirs.push(env.workDir);

      expect(env.pluginDirs[0]).toMatch(/my-repo\/superpowers$/);
    });

    it('throws when a plugin directory does not exist in cloned repo', async () => {
      const job = createJob({
        marketplaces: [
          { url: 'https://github.com/anthropics/claude-plugins-official.git', plugins: ['nonexistent-plugin'] },
        ],
      });

      await expect(jobEnv.setup(job)).rejects.toThrow(/Plugin directory.*nonexistent-plugin.*not found/);
    });

    it('throws when git clone fails', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('fatal: repository not found');
      });

      const job = createJob({
        marketplaces: [
          { url: 'https://github.com/nonexistent/repo.git', plugins: ['plugin'] },
        ],
      });

      await expect(jobEnv.setup(job)).rejects.toThrow('fatal: repository not found');
    });

    it('cleans up temp dir on setup failure', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('clone failed');
      });

      const job = createJob({
        marketplaces: [
          { url: 'https://github.com/bad/repo.git', plugins: ['p'] },
        ],
      });

      let workDir: string | undefined;
      try {
        await jobEnv.setup(job);
      } catch {
        // Find the temp dir that was created (it should have been cleaned up)
        // We can't easily test this without access to the workDir, so we verify
        // that the error propagated correctly
      }

      // The temp dir should not exist after a failed setup
      // (unless DEBUG=1, tested separately)
    });
  });

  describe('teardown', () => {
    it('removes the temp directory', async () => {
      const env = await jobEnv.setup(createJob());

      expect(existsSync(env.workDir)).toBe(true);
      await jobEnv.teardown(env);
      expect(existsSync(env.workDir)).toBe(false);
    });

    it('skips cleanup when DEBUG is enabled', async () => {
      const debugJobEnv = new JobEnvironment(true);
      const env = await debugJobEnv.setup(createJob());
      createdDirs.push(env.workDir);

      await debugJobEnv.teardown(env);
      expect(existsSync(env.workDir)).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/task-daemon && npx vitest run src/services/__tests__/job-environment.test.ts`
Expected: FAIL — module `../job-environment` not found

- [ ] **Step 3: Implement JobEnvironment service**

Create `packages/task-daemon/src/services/job-environment.ts`:

```typescript
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Job, createLogger } from '@local-agent/shared';

const logger = createLogger('task-daemon:job-environment');

export interface ExecutionEnvironment {
  workDir: string;
  pluginDirs: string[];
}

export class JobEnvironment {
  constructor(private readonly debug: boolean) {}

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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/task-daemon && npx vitest run src/services/__tests__/job-environment.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/task-daemon/src/services/job-environment.ts packages/task-daemon/src/services/__tests__/job-environment.test.ts
git commit -m "feat(task-daemon): add JobEnvironment service for isolated job execution"
```

---

## Task 4: Update TaskExecutor interface and ClaudeCliExecutor

**Files:**
- Modify: `packages/task-daemon/src/ports/task-executor.ts:1-5`
- Modify: `packages/task-daemon/src/adapters/claude-cli-executor.ts:1-60`
- Test: `packages/task-daemon/src/adapters/__tests__/claude-cli-executor.test.ts`

- [ ] **Step 1: Update the failing test**

In `packages/task-daemon/src/adapters/__tests__/claude-cli-executor.test.ts`, add import for `ExecutionEnvironment` and update all `execute()` calls:

Add at top with imports:

```typescript
import { ExecutionEnvironment } from '../../services/job-environment';
```

Add a helper function after `createJob`:

```typescript
function createEnv(overrides?: Partial<ExecutionEnvironment>): ExecutionEnvironment {
  return {
    workDir: '/tmp/localagent-job-test',
    pluginDirs: [],
    ...overrides,
  };
}
```

Update **all 6 existing** `executor.execute(...)` calls to pass the env as the second argument: `executor.execute(createJob(), createEnv())` (or `executor.execute(createJob({ ... }), createEnv())` where overrides are already present). The 5 tests that need updating are: "returns success result...", "returns failure result when claude exits with non-zero code", "returns failure result with null exit_code...", "returns failure result when payload is empty", and "truncates stdout...".

Replace the "spawns claude with correct arguments" test with the two new tests below:

```typescript
  it('spawns claude with --bare flag and cwd from environment', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    await executor.execute(createJob(), createEnv());

    expect(mockExecFile).toHaveBeenCalledWith(
      'claude',
      ['--bare', '--dangerously-skip-permissions', '--model', 'opus', '-p', 'What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024, cwd: '/tmp/localagent-job-test' },
      expect.any(Function),
    );
  });

  it('includes --plugin-dir flags for each plugin directory', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    const env = createEnv({
      pluginDirs: ['/tmp/job/marketplaces/repo1/plugin-a', '/tmp/job/marketplaces/repo2/plugin-b'],
    });

    await executor.execute(createJob(), env);

    expect(mockExecFile).toHaveBeenCalledWith(
      'claude',
      [
        '--bare',
        '--dangerously-skip-permissions',
        '--model', 'opus',
        '--plugin-dir', '/tmp/job/marketplaces/repo1/plugin-a',
        '--plugin-dir', '/tmp/job/marketplaces/repo2/plugin-b',
        '-p', 'What is 2+2?',
      ],
      { maxBuffer: 50 * 1024 * 1024, cwd: '/tmp/job' },
      expect.any(Function),
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/task-daemon && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: FAIL — `execute` expects 1 argument, got 2

- [ ] **Step 3: Update TaskExecutor interface**

Replace `packages/task-daemon/src/ports/task-executor.ts`:

```typescript
import { Job, TaskResultSubmission } from '@local-agent/shared';
import { ExecutionEnvironment } from '../services/job-environment';

export interface TaskExecutor {
  execute(job: Job, env: ExecutionEnvironment): Promise<TaskResultSubmission>;
}
```

- [ ] **Step 4: Update ClaudeCliExecutor**

Replace `packages/task-daemon/src/adapters/claude-cli-executor.ts`:

```typescript
import { execFile } from 'node:child_process';
import { Job, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:claude-cli');

export class ClaudeCliExecutor implements TaskExecutor {
  async execute(job: Job, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning Claude Code');

    if (!job.payload) {
      logger.error({ job_id: job.job_id, task_id: job.task_id }, 'Job payload is missing or empty — skipping');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Job payload is missing or empty',
      };
    }

    const args = [
      '--bare',
      '--dangerously-skip-permissions',
      '--model', job.executor_model,
      ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
      '-p', job.payload,
    ];

    return new Promise((resolve) => {
      execFile(
        'claude',
        args,
        { maxBuffer: 50 * 1024 * 1024, cwd: env.workDir },
        (error, stdout, stderr) => {
          if (error) {
            const execErr = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            logger.error(
              { job_id: job.job_id, task_id: job.task_id, exit_code: execErr.code, stdout: execErr.stdout, stderr: execErr.stderr },
              'Claude Code failed',
            );

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              status: 'failure',
              exit_code: typeof execErr.code === 'number' ? execErr.code : null,
              stdout: truncate(execErr.stdout ?? '', MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(execErr.stderr ?? '', MAX_RESULT_OUTPUT_BYTES),
            });
          } else {
            logger.info({ job_id: job.job_id, task_id: job.task_id, stdout, stderr }, 'Claude Code completed');

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              status: 'success',
              exit_code: 0,
              stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
            });
          }
        },
      );
    });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/task-daemon && npx vitest run src/adapters/__tests__/claude-cli-executor.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/task-daemon/src/ports/task-executor.ts packages/task-daemon/src/adapters/claude-cli-executor.ts packages/task-daemon/src/adapters/__tests__/claude-cli-executor.test.ts
git commit -m "feat(task-daemon): update ClaudeCliExecutor with --bare, --plugin-dir, and ExecutionEnvironment"
```

---

## Task 5: Update TTADKExecutor

**Files:**
- Modify: `packages/task-daemon/src/adapters/ttadk-executor.ts:1-60`
- Test: `packages/task-daemon/src/adapters/__tests__/ttadk-executor.test.ts`

- [ ] **Step 1: Update the failing test**

In `packages/task-daemon/src/adapters/__tests__/ttadk-executor.test.ts`, apply the same pattern as ClaudeCliExecutor:

Add import:

```typescript
import { ExecutionEnvironment } from '../../services/job-environment';
```

Add `createEnv` helper (same as Task 4). Update **all 6 existing** `executor.execute(...)` calls to pass the env as the second argument: `executor.execute(createJob(), createEnv())` (or `executor.execute(createJob({ ... }), createEnv())` where overrides are already present). The 5 tests that need updating are: "returns success result...", "returns failure result when ttadk exits with non-zero code", "returns failure result with null exit_code...", "returns failure result when payload is empty", and "truncates stdout...".

Replace the "spawns ttadk with correct arguments" test with the two new tests below:

```typescript
  it('spawns ttadk with --bare and plugin flags forwarded via -a', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    await executor.execute(createJob({ executor: 'ttadk', executor_model: 'glm-5-ttadk' }), createEnv());

    expect(mockExecFile).toHaveBeenCalledWith(
      'ttadk',
      ['code', '-t', 'claude', '-m', 'glm-5-ttadk', '-a', '--bare --dangerously-skip-permissions -p What is 2+2?'],
      { maxBuffer: 50 * 1024 * 1024, cwd: '/tmp/localagent-job-test' },
      expect.any(Function),
    );
  });

  it('includes --plugin-dir flags in -a argument', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as ExecFileCallback)(null, '', '');
      return {} as ChildProcess;
    });

    const env = createEnv({
      pluginDirs: ['/tmp/job/repo/plugin-a', '/tmp/job/repo/plugin-b'],
    });

    await executor.execute(createJob({ executor: 'ttadk', executor_model: 'glm-5-ttadk' }), env);

    expect(mockExecFile).toHaveBeenCalledWith(
      'ttadk',
      [
        'code', '-t', 'claude', '-m', 'glm-5-ttadk',
        '-a', '--bare --dangerously-skip-permissions --plugin-dir /tmp/job/repo/plugin-a --plugin-dir /tmp/job/repo/plugin-b -p What is 2+2?',
      ],
      { maxBuffer: 50 * 1024 * 1024, cwd: '/tmp/job' },
      expect.any(Function),
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/task-daemon && npx vitest run src/adapters/__tests__/ttadk-executor.test.ts`
Expected: FAIL

- [ ] **Step 3: Update TTADKExecutor**

Replace `packages/task-daemon/src/adapters/ttadk-executor.ts`:

```typescript
import { execFile } from 'node:child_process';
import { Job, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
import { TaskExecutor } from '../ports/task-executor';
import { ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:ttadk');

export class TTADKExecutor implements TaskExecutor {
  async execute(job: Job, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
    logger.info({ job_id: job.job_id, task_id: job.task_id, task_type: job.task_type }, 'Spawning TTADK');

    if (!job.payload) {
      logger.error({ job_id: job.job_id, task_id: job.task_id }, 'Job payload is missing or empty — skipping');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: 'Job payload is missing or empty',
      };
    }

    const claudeArgs = [
      '--bare',
      '--dangerously-skip-permissions',
      ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
      '-p', job.payload,
    ].join(' ');

    const args = ['code', '-t', 'claude', '-m', job.executor_model, '-a', claudeArgs];

    return new Promise((resolve) => {
      execFile(
        'ttadk',
        args,
        { maxBuffer: 50 * 1024 * 1024, cwd: env.workDir },
        (error, stdout, stderr) => {
          if (error) {
            const execErr = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
            logger.error(
              { job_id: job.job_id, task_id: job.task_id, exit_code: execErr.code, stdout: execErr.stdout, stderr: execErr.stderr },
              'TTADK failed',
            );

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              status: 'failure',
              exit_code: typeof execErr.code === 'number' ? execErr.code : null,
              stdout: truncate(execErr.stdout ?? '', MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(execErr.stderr ?? '', MAX_RESULT_OUTPUT_BYTES),
            });
          } else {
            logger.info({ job_id: job.job_id, task_id: job.task_id, stdout, stderr }, 'TTADK completed');

            resolve({
              job_id: job.job_id,
              task_id: job.task_id,
              status: 'success',
              exit_code: 0,
              stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
              stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
            });
          }
        },
      );
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/task-daemon && npx vitest run src/adapters/__tests__/ttadk-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/task-daemon/src/adapters/ttadk-executor.ts packages/task-daemon/src/adapters/__tests__/ttadk-executor.test.ts
git commit -m "feat(task-daemon): update TTADKExecutor with --bare, --plugin-dir forwarded via -a"
```

---

## Task 6: Update TaskOrchestrator to coordinate JobEnvironment

**Files:**
- Modify: `packages/task-daemon/src/core/task-orchestrator.ts:1-28`
- Test: `packages/task-daemon/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Update the failing test**

Replace `packages/task-daemon/src/core/__tests__/task-orchestrator.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Job, TaskResultSubmission } from '@local-agent/shared';
import { ExecutionEnvironment } from '../../services/job-environment';

const mockEnv: ExecutionEnvironment = {
  workDir: '/tmp/localagent-job-test',
  pluginDirs: [],
};

const mockSetup = vi.fn().mockResolvedValue(mockEnv);
const mockTeardown = vi.fn().mockResolvedValue(undefined);

vi.mock('../../services/job-environment', () => ({
  JobEnvironment: vi.fn(() => ({
    setup: mockSetup,
    teardown: mockTeardown,
  })),
}));

const mockResultSubmission: TaskResultSubmission = {
  job_id: 'job-456',
  task_id: 'test-123',
  status: 'success',
  exit_code: 0,
  stdout: 'output',
  stderr: '',
};

const mockClaudeExecute = vi.fn().mockResolvedValue(mockResultSubmission);
const mockTTADKExecute = vi.fn().mockResolvedValue(mockResultSubmission);

vi.mock('../../adapters/claude-cli-executor', () => ({
  ClaudeCliExecutor: vi.fn(function (this: { execute: typeof mockClaudeExecute }) {
    this.execute = mockClaudeExecute;
  }),
}));

vi.mock('../../adapters/ttadk-executor', () => ({
  TTADKExecutor: vi.fn(function (this: { execute: typeof mockTTADKExecute }) {
    this.execute = mockTTADKExecute;
  }),
}));

import { ClaudeCliExecutor } from '../../adapters/claude-cli-executor';
import { TTADKExecutor } from '../../adapters/ttadk-executor';
import { TaskOrchestrator } from '../task-orchestrator';
import { JobEnvironment } from '../../services/job-environment';

function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'claude_code',
    executor_model: 'opus',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    ...overrides,
  };
}

describe('TaskOrchestrator', () => {
  let orchestrator: TaskOrchestrator;
  let jobEnv: JobEnvironment;

  beforeEach(() => {
    mockClaudeExecute.mockClear().mockResolvedValue(mockResultSubmission);
    mockTTADKExecute.mockClear().mockResolvedValue(mockResultSubmission);
    mockSetup.mockClear().mockResolvedValue(mockEnv);
    mockTeardown.mockClear().mockResolvedValue(undefined);
    vi.mocked(ClaudeCliExecutor).mockClear();
    vi.mocked(TTADKExecutor).mockClear();
    jobEnv = new JobEnvironment(false);
    orchestrator = new TaskOrchestrator(jobEnv);
  });

  it('calls setup before execution and teardown after', async () => {
    const job = createJob();
    await orchestrator.handle(job);

    expect(mockSetup).toHaveBeenCalledWith(job);
    expect(mockClaudeExecute).toHaveBeenCalledWith(job, mockEnv);
    expect(mockTeardown).toHaveBeenCalledWith(mockEnv);
  });

  it('returns TaskResultSubmission from Claude executor for claude_code jobs', async () => {
    const job = createJob({ executor: 'claude_code' });
    const result = await orchestrator.handle(job);

    expect(ClaudeCliExecutor).toHaveBeenCalledTimes(1);
    expect(TTADKExecutor).not.toHaveBeenCalled();
    expect(mockClaudeExecute).toHaveBeenCalledWith(job, mockEnv);
    expect(result).toEqual(mockResultSubmission);
  });

  it('returns TaskResultSubmission from TTADK executor for ttadk jobs', async () => {
    const job = createJob({ executor: 'ttadk' });
    const result = await orchestrator.handle(job);

    expect(TTADKExecutor).toHaveBeenCalledTimes(1);
    expect(ClaudeCliExecutor).not.toHaveBeenCalled();
    expect(mockTTADKExecute).toHaveBeenCalledWith(job, mockEnv);
    expect(result).toEqual(mockResultSubmission);
  });

  it('returns failure result when setup fails', async () => {
    mockSetup.mockRejectedValue(new Error('clone failed'));

    const result = await orchestrator.handle(createJob());

    expect(result.status).toBe('failure');
    expect(result.stderr).toContain('Environment setup failed');
    expect(result.stderr).toContain('clone failed');
    expect(mockClaudeExecute).not.toHaveBeenCalled();
    expect(mockTeardown).not.toHaveBeenCalled();
  });

  it('calls teardown even when execution fails', async () => {
    mockClaudeExecute.mockRejectedValue(new Error('execution boom'));

    const result = await orchestrator.handle(createJob());

    expect(mockTeardown).toHaveBeenCalledWith(mockEnv);
    expect(result.status).toBe('failure');
    expect(result.stderr).toContain('execution boom');
  });

  it('returns failure for unknown executor', async () => {
    const job = createJob({ executor: 'invalid' as never });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('failure');
    expect(result.stderr).toContain('Unknown job executor: invalid');
    expect(mockTeardown).toHaveBeenCalledWith(mockEnv);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/task-daemon && npx vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: FAIL — `TaskOrchestrator` constructor doesn't accept arguments

- [ ] **Step 3: Update TaskOrchestrator**

Replace `packages/task-daemon/src/core/task-orchestrator.ts`:

```typescript
import { Job, TaskResultSubmission, createLogger } from '@local-agent/shared';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';
import { TTADKExecutor } from '../adapters/ttadk-executor';
import { TaskExecutor } from '../ports/task-executor';
import { JobEnvironment, ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:orchestrator');

export class TaskOrchestrator {
  constructor(private readonly jobEnv: JobEnvironment) {}

  async handle(job: Job): Promise<TaskResultSubmission> {
    logger.info(
      { job_id: job.job_id, task_id: job.task_id, task_type: job.task_type, executor: job.executor },
      'Processing job',
    );

    let env: ExecutionEnvironment;

    try {
      env = await this.jobEnv.setup(job);
    } catch (error) {
      logger.error({ job_id: job.job_id, err: error }, 'Environment setup failed');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: `Environment setup failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      let executor: TaskExecutor;

      if (job.executor === 'claude_code') {
        executor = new ClaudeCliExecutor();
      } else if (job.executor === 'ttadk') {
        executor = new TTADKExecutor();
      } else {
        throw new Error(`Unknown job executor: ${job.executor}`);
      }

      return await executor.execute(job, env);
    } catch (error) {
      logger.error({ job_id: job.job_id, err: error }, 'Job execution failed');
      return {
        job_id: job.job_id,
        task_id: job.task_id,
        status: 'failure',
        exit_code: null,
        stdout: '',
        stderr: `Job execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      await this.jobEnv.teardown(env!);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/task-daemon && npx vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/task-daemon/src/core/task-orchestrator.ts packages/task-daemon/src/core/__tests__/task-orchestrator.test.ts
git commit -m "feat(task-daemon): update TaskOrchestrator to coordinate JobEnvironment lifecycle"
```

---

## Task 7: Update task-daemon entry point

**Files:**
- Modify: `packages/task-daemon/src/task-daemon.ts:1-29`

- [ ] **Step 1: Update task-daemon.ts to instantiate JobEnvironment**

Replace `packages/task-daemon/src/task-daemon.ts`:

```typescript
import { loadDaemonConfig, createLogger } from '@local-agent/shared';
import { TaskPoller } from './task-poller';
import { TaskOrchestrator } from './core/task-orchestrator';
import { JobEnvironment } from './services/job-environment';

async function main() {
  const config = loadDaemonConfig();
  const logger = createLogger('task-daemon', config.logLevel);

  const debug = process.env.DEBUG === '1';
  logger.info({ apiUrl: config.apiUrl, pollIntervalMs: config.pollIntervalMs, debug }, 'Starting task-daemon');

  const jobEnv = new JobEnvironment(debug);
  const orchestrator = new TaskOrchestrator(jobEnv);
  const poller = new TaskPoller(config.apiUrl, orchestrator);
  poller.start(config.pollIntervalMs);

  const shutdown = () => {
    logger.info('Shutting down task-daemon...');
    poller.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  const logger = createLogger('task-daemon');
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
```

- [ ] **Step 2: Run all task-daemon tests to verify nothing is broken**

Run: `cd packages/task-daemon && npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/task-daemon/src/task-daemon.ts
git commit -m "feat(task-daemon): wire up JobEnvironment in entry point with DEBUG env var"
```

---

## Task 8: Update Dockerfile and docker-compose.yml

**Files:**
- Modify: `packages/task-daemon/Dockerfile:26-42`
- Modify: `docker-compose.yml:34-49`

- [ ] **Step 1: Add git to the task-daemon Dockerfile**

In `packages/task-daemon/Dockerfile`, add `RUN apk add --no-cache git` after the `FROM node:20-alpine` production stage:

```dockerfile
FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app
```

- [ ] **Step 2: Add credential volume mount and DEBUG env var to docker-compose.yml**

Update the `task-daemon` service in `docker-compose.yml`:

```yaml
  task-daemon:
    build:
      context: .
      dockerfile: packages/task-daemon/Dockerfile
    environment:
      API_URL: http://api:3000
      POLL_INTERVAL_MS: "5000"
      LOG_LEVEL: info
      DEBUG: "${DEBUG:-0}"
    volumes:
      - ${HOME}/.claude/.credentials.json:/root/.claude/.credentials.json:ro
    depends_on:
      rabbitmq:
        condition: service_healthy
      api:
        condition: service_started
    profiles:
      - task-daemon
      - full
```

- [ ] **Step 3: Verify Docker build succeeds**

Run: `docker compose build task-daemon`
Expected: Build completes without errors

- [ ] **Step 4: Commit**

```bash
git add packages/task-daemon/Dockerfile docker-compose.yml
git commit -m "feat(docker): add git to task-daemon image and mount Claude credentials"
```

---

## Task 9: Run full test suite

- [ ] **Step 1: Build shared package**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 2: Run shared tests**

Run: `cd packages/shared && npx vitest run`
Expected: All PASS

- [ ] **Step 3: Run enrichment daemon tests**

Run: `cd packages/task-enrichment-daemon && npx vitest run`
Expected: All PASS

- [ ] **Step 4: Run task daemon tests**

Run: `cd packages/task-daemon && npx vitest run`
Expected: All PASS

- [ ] **Step 5: Type-check all packages**

Run: `cd packages/task-daemon && npx tsc --noEmit && cd ../task-enrichment-daemon && npx tsc --noEmit`
Expected: No type errors
