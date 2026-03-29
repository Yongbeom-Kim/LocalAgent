# Claude Code Environment Setup Design

**Date:** 2026-03-29
**Status:** Draft

## Problem Statement

The task daemon currently spawns Claude Code / TTADK as bare subprocesses with no plugin or marketplace support. Each invocation runs in the container's default environment with no isolation between jobs. There is no mechanism to configure task-type-specific Claude Code plugins, and no way to give different task types different capabilities (e.g., code-review tasks get a linting plugin, development tasks get dev workflow plugins).

Additionally, the task daemon Docker container has no credential files mounted, and Claude Code starts in default mode which auto-discovers hooks, LSP, CLAUDE.md, etc. — behaviors that are unpredictable in a containerized headless environment.

## Goals

1. **Per-job isolated environment:** Every job execution gets a fresh temp directory with its own plugin configuration. Cleaned up after execution (persisted when `DEBUG=1`).
2. **Task-type-specific plugins:** Enrichment YAML rules specify marketplace repos and plugins per task type. The enrichment daemon populates a `marketplaces` field on the `Job` type.
3. **Runtime plugin installation:** Marketplace repos are cloned at job execution time. Plugin directories are passed to Claude via `--plugin-dir` flags.
4. **Credential mounting:** The host's `~/.claude/.credentials.json` is bind-mounted into the task daemon container.
5. **Controlled execution:** All jobs run with `--bare` mode for predictable, fast startup. Only explicitly specified plugins are loaded.

## Non-Goals

- Hot-reloading of enrichment config (restart-on-change is acceptable)
- Plugin caching across jobs (fresh clone every time)
- Default/inherited marketplace sets across task types (each rule is self-contained)
- Constructing custom `settings.json` per job (using `--plugin-dir` + `--bare` instead)
- MCP server configuration per job (out of scope for this iteration)

## Design

### Architecture Overview

```
Enrichment Daemon                      Task Daemon
┌──────────────────────┐    Job     ┌──────────────────────────────────┐
│                      │  (with    │                                  │
│  enrichment.yaml     │  market-  │  TaskOrchestrator                │
│  ┌────────────────┐  │  places)  │    │                             │
│  │ rules:         │  │ ────────► │    ▼                             │
│  │  code-review:  │  │           │  JobEnvironment.setup(job)       │
│  │   executor: .. │  │           │    │  1. Create temp dir         │
│  │   marketplaces:│  │           │    │  2. Clone marketplace repos │
│  │    - url: ...  │  │           │    │  3. Resolve plugin paths    │
│  │      plugins:  │  │           │    │  4. Return ExecutionEnv     │
│  │       - dev    │  │           │    ▼                             │
│  └────────────────┘  │           │  Executor.execute(job, env)      │
│                      │           │    │  claude --bare               │
│  EnrichmentService   │           │    │    --plugin-dir /tmp/...     │
│   .enrich(task)      │           │    │    --plugin-dir /tmp/...     │
│   → JobSubmission    │           │    │    --model sonnet            │
│     (+ marketplaces) │           │    │    -p "payload"              │
└──────────────────────┘           │    ▼                             │
                                   │  JobEnvironment.teardown()       │
                                   │    (unless DEBUG=1)              │
                                   └──────────────────────────────────┘
```

### Enrichment YAML Extension

The existing `enrichment.yaml` format is extended with an optional `marketplaces` array per rule:

```yaml
rules:
  default:
    executor: claude_code
    executor_model: sonnet

  code-review:
    executor: claude_code
    executor_model: sonnet
    marketplaces:
      - url: https://github.com/anthropics/claude-plugins-official.git
        plugins: [superpowers]

  development:
    executor: claude_code
    executor_model: opus
    marketplaces:
      - url: https://github.com/anthropics/claude-plugins-official.git
        plugins: [superpowers]
      - url: https://github.com/Yongbeom-Kim/personal-claude-code.git
        plugins: [development]

  ttadk-task:
    executor: ttadk
    executor_model: glm-5-ttadk
    marketplaces:
      - url: https://github.com/Yongbeom-Kim/personal-claude-code.git
        plugins: [development]
```

Each rule is **self-contained** — no inheritance from `default`. If a task type has no `marketplaces` field, no plugins are loaded (but the temp dir is still created).

### Job Type Extension

The `Job` interface gains an optional `marketplaces` field:

```typescript
export interface MarketplaceConfig {
  url: string;       // Git clone URL
  plugins: string[]; // Plugin directory names within the marketplace repo
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
  marketplaces?: MarketplaceConfig[]; // NEW
}

export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
  marketplaces?: MarketplaceConfig[]; // NEW
}
```

### JobEnvironment Service

A new service in the task-daemon package responsible for creating and managing the isolated execution environment.

**Location:** `packages/task-daemon/src/services/job-environment.ts`

```typescript
export interface ExecutionEnvironment {
  workDir: string;        // Temp directory path
  pluginDirs: string[];   // Resolved --plugin-dir paths
}

export class JobEnvironment {
  constructor(private readonly debug: boolean) {}

  async setup(job: Job): Promise<ExecutionEnvironment>;
  async teardown(env: ExecutionEnvironment): Promise<void>;
}
```

**setup(job) flow:**

1. Create temp directory: `/tmp/localagent-job-<job_id>/`
2. If `job.marketplaces` exists and is non-empty:
   a. For each marketplace entry:
      - Clone the repo to `/tmp/localagent-job-<job_id>/marketplaces/<repo-name>/`
      - Use `git clone --depth 1` for shallow clone (faster, less disk)
      - The `<repo-name>` is derived from the last path segment of the URL, stripped of any `.git` suffix (e.g., `https://github.com/anthropics/claude-plugins-official.git` → `claude-plugins-official`)
   b. For each plugin in each marketplace:
      - Verify the plugin directory exists in the cloned repo
      - Add the absolute path to `pluginDirs`
3. Return `ExecutionEnvironment` with workDir and pluginDirs

**teardown(env) flow:**

1. If `DEBUG=1` (env var), log the temp dir path and skip cleanup
2. Otherwise, recursively delete the temp directory

**Error handling:**
- If any git clone fails or a plugin directory doesn't exist, `setup()` cleans up the partially-created temp directory (unless `DEBUG=1`) and then throws. The orchestrator catches this and returns a failure result for the job.

### Executor Changes

Both `ClaudeCliExecutor` and `TTADKExecutor` are modified to accept an `ExecutionEnvironment` parameter.

**ClaudeCliExecutor changes:**

```typescript
async execute(job: Job, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
  const args = [
    '--bare',
    '--dangerously-skip-permissions',
    '--model', job.executor_model,
    ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
    '-p', job.payload,
  ];

  return new Promise((resolve) => {
    execFile('claude', args, {
      maxBuffer: 50 * 1024 * 1024,
      cwd: env.workDir,
    }, (error, stdout, stderr) => { /* ... existing logic ... */ });
  });
}
```

**TTADKExecutor changes:**

```typescript
async execute(job: Job, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
  const claudeArgs = [
    '--bare',
    '--dangerously-skip-permissions',
    ...env.pluginDirs.flatMap(dir => ['--plugin-dir', dir]),
    '-p', job.payload,
  ].join(' ');

  const args = ['code', '-t', 'claude', '-m', job.executor_model, '-a', claudeArgs];

  return new Promise((resolve) => {
    execFile('ttadk', args, {
      maxBuffer: 50 * 1024 * 1024,
      cwd: env.workDir,
    }, (error, stdout, stderr) => { /* ... existing logic ... */ });
  });
}
```

### TaskExecutor Interface Change

```typescript
export interface TaskExecutor {
  execute(job: Job, env: ExecutionEnvironment): Promise<TaskResultSubmission>;
}
```

### TaskOrchestrator Changes

The orchestrator coordinates environment setup, execution, and teardown:

```typescript
export class TaskOrchestrator {
  constructor(private readonly jobEnv: JobEnvironment) {}

  async handle(job: Job): Promise<TaskResultSubmission> {
    let env: ExecutionEnvironment | undefined;

    try {
      env = await this.jobEnv.setup(job);
    } catch (error) {
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
    } finally {
      if (env) {
        await this.jobEnv.teardown(env);
      }
    }
  }
}
```

### EnrichmentService Changes

The `enrich()` method now also reads `marketplaces` from the YAML rule and passes it through:

```typescript
interface EnrichmentRule {
  executor: string;
  executor_model: string;
  marketplaces?: Array<{ url: string; plugins: string[] }>;
}

enrich(task: Task): JobSubmission | null {
  const rule = this.rules[task.task_type] ?? this.rules['default'];
  // ... existing validation ...

  return {
    task_id: task.task_id,
    task_type: task.task_type,
    payload: task.payload,
    executor: rule.executor as TaskExecutorType,
    executor_model: rule.executor_model,
    submitted_at: task.submitted_at,
    marketplaces: rule.marketplaces, // Pass through (may be undefined)
  };
}
```

### Docker Changes

**task-daemon Dockerfile:**

Add `git` to the production image:

```dockerfile
FROM node:20-alpine
RUN apk add --no-cache git
# ... rest of production stage
```

**docker-compose.yml:**

Add credential bind mount to the task-daemon service:

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

### Temp Directory Structure

For a job with ID `abc123` and two marketplaces:

```
/tmp/localagent-job-abc123/
├── marketplaces/
│   ├── claude-plugins-official/     # Cloned from github.com/anthropics/claude-plugins-official
│   │   ├── superpowers/             # Plugin directory → --plugin-dir
│   │   ├── gopls-lsp/
│   │   └── ...
│   └── personal-claude-code/        # Cloned from github.com/Yongbeom-Kim/personal-claude-code
│       ├── development/             # Plugin directory → --plugin-dir
│       ├── learning/
│       └── ...
```

Only the specified plugin subdirectories are passed as `--plugin-dir` arguments.

### Credential Flow

```
Host:  ~/.claude/.credentials.json
  │
  ▼ (bind mount, read-only)
Container:  /root/.claude/.credentials.json
  │
  ▼ (claude reads from default location)
Claude CLI:  Authenticates using mounted credentials
```

The `--bare` flag disables keychain reads and OAuth, so Claude relies solely on the file-based credentials.

## Changes Summary

| Package | File | Change |
|---------|------|--------|
| shared | `src/types.ts` | Add `MarketplaceConfig` interface, add `marketplaces?` to `Job` and `JobSubmission` |
| task-enrichment-daemon | `config/enrichment.yaml` | Add `marketplaces` entries to rules |
| task-enrichment-daemon | `src/enrichment-service.ts` | Pass through `marketplaces` from rule to `JobSubmission` |
| task-daemon | `src/services/job-environment.ts` | **New** — `JobEnvironment` service |
| task-daemon | `src/ports/task-executor.ts` | Add `ExecutionEnvironment` param to `execute()` |
| task-daemon | `src/adapters/claude-cli-executor.ts` | Add `--bare`, `--plugin-dir` flags, accept `ExecutionEnvironment` |
| task-daemon | `src/adapters/ttadk-executor.ts` | Same changes as ClaudeCliExecutor |
| task-daemon | `src/core/task-orchestrator.ts` | Coordinate `JobEnvironment.setup()` → execute → `teardown()` |
| task-daemon | `src/task-daemon.ts` | Instantiate `JobEnvironment` with `DEBUG` env var |
| task-daemon | `Dockerfile` | Add `git` to production image |
| root | `docker-compose.yml` | Add credential volume mount + `DEBUG` env var to task-daemon service |

## Testing Strategy

1. **JobEnvironment unit tests:** Mock `execFile` for git clone. Test setup creates dirs, resolves paths. Test teardown deletes dirs. Test DEBUG=1 skips cleanup.
2. **Executor unit tests:** Verify correct CLI args including `--bare`, `--plugin-dir` flags.
3. **EnrichmentService tests:** Verify `marketplaces` field is passed through from YAML rules.
4. **Integration test:** Submit a task with marketplace config, verify the full flow produces correct executor args.
5. **Shared types:** Verify `MarketplaceConfig` is exported and used correctly.

## Alternatives Considered

### A: Monolithic Executor Refactor

Each executor handles temp dir, cloning, and cleanup internally. Rejected because it duplicates logic between `ClaudeCliExecutor` and `TTADKExecutor`.

### C: Pipeline/Middleware Pattern

A composable middleware chain where each step is a function. Rejected as over-engineered for the current scope (only setup and teardown steps).

### Plugin mounting via Docker volumes

Mount the host's marketplace directories directly into the container. Rejected because the user wants runtime cloning from VCS URLs specified in enrichment rules, enabling task-type-specific configurations without host dependency.
