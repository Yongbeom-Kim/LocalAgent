# Executor Preference Array Implementation Plan

**Goal:** Replace scalar `executor`/`executor_model` fields with an ordered `executors` preference array across enrichment, API, and task-daemon — enabling automatic fallback on failure.

**Architecture:** The enrichment YAML defines an ordered array of `{executor, executor_model}` pairs per rule. `EnrichmentService` validates all pairs and emits a `JobSubmission` with the `executors` array. The API and RabbitMQ pass it through. `TaskOrchestrator` iterates the array, trying each with a fresh execution environment, returning the first success or last failure.

**Tech Stack:** TypeScript, Vitest, Express, RabbitMQ, js-yaml

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/types.ts` | Modify | Add `ExecutorPreference`, `JobAttempt`; add `isValidExecutorPreferences()`; update `JobSubmission`/`Job` to use `executors` array |
| `packages/shared/src/index.ts` | Modify | Re-export new types and functions |
| `packages/shared/src/__tests__/types.test.ts` | Modify | Add tests for `isValidExecutorPreferences()` |
| `packages/daemon/task-enrichment/config/enrichment.yaml` | Modify | Update to `executors` array format |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Modify | Update `EnrichmentRule` and `enrich()` for array-based rules |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Modify | Update all rules and assertions for array format |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Modify | Update `createJobSubmission()` fixture |
| `packages/api/src/routes/jobs.ts` | Modify | Replace scalar validation with `isValidExecutorPreferences()` |
| `packages/api/src/__tests__/services/rabbitmq.test.ts` | Modify | Update Job/JobSubmission fixtures |
| `packages/daemon/task/src/ports/task-executor.ts` | Modify | Change parameter type from `Job` to `JobAttempt` |
| `packages/daemon/task/src/adapters/claude-cli-executor.ts` | Modify | Update import and signature to `JobAttempt` |
| `packages/daemon/task/src/adapters/ttadk-executor.ts` | Modify | Update import and signature to `JobAttempt` |
| `packages/daemon/task/src/core/task-orchestrator.ts` | Modify | Add fallback loop, `resolveExecutor()`, `JobAttempt` construction |
| `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts` | Modify | Update fixtures; add fallback tests |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Modify | Update `createJob()` fixture |
| `packages/daemon/task/src/services/__tests__/job-environment.test.ts` | Modify | Update `createJob()` fixture |
| `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts` | Modify | Update fixtures from `Job` to `JobAttempt` |
| `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts` | Modify | Update fixtures from `Job` to `JobAttempt` |

---

### Task 1: Shared types — `ExecutorPreference`, `JobAttempt`, `isValidExecutorPreferences`

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/__tests__/types.test.ts`

- [ ] **Step 1: Write failing tests for `isValidExecutorPreferences`**

Add to `packages/shared/src/__tests__/types.test.ts`:

```ts
import {
  isValidExecutorPreferences,
} from '../types';

describe('isValidExecutorPreferences', () => {
  it('returns true for valid non-empty array', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude_code', executor_model: 'sonnet' },
      { executor: 'ttadk', executor_model: 'gpt-5.4' },
    ])).toBe(true);
  });

  it('returns true for single-element array', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude_code', executor_model: 'opus' },
    ])).toBe(true);
  });

  it('returns false for empty array', () => {
    expect(isValidExecutorPreferences([])).toBe(false);
  });

  it('returns false for non-array', () => {
    expect(isValidExecutorPreferences('claude_code')).toBe(false);
    expect(isValidExecutorPreferences(null)).toBe(false);
    expect(isValidExecutorPreferences(undefined)).toBe(false);
  });

  it('returns false when any pair has invalid executor', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude_code', executor_model: 'sonnet' },
      { executor: 'nonexistent', executor_model: 'opus' },
    ])).toBe(false);
  });

  it('returns false when any pair has invalid model for its executor', () => {
    expect(isValidExecutorPreferences([
      { executor: 'claude_code', executor_model: 'gpt-5.4' },
    ])).toBe(false);
  });

  it('returns false for array with non-object elements', () => {
    expect(isValidExecutorPreferences(['claude_code'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`
Expected: FAIL — `isValidExecutorPreferences` is not exported

- [ ] **Step 3: Add `ExecutorPreference`, `JobAttempt`, and `isValidExecutorPreferences` to types.ts**

In `packages/shared/src/types.ts`, add after the `getExecutorModelOptions` function (line 29):

```ts
export interface ExecutorPreference {
  executor: TaskExecutorType;
  executor_model: string;
}

export function isValidExecutorPreferences(
  executors: unknown,
): executors is ExecutorPreference[] {
  if (!Array.isArray(executors) || executors.length === 0) return false;
  return executors.every(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      isTaskExecutorType((e as Record<string, unknown>).executor) &&
      isValidExecutorModel(
        (e as Record<string, unknown>).executor as TaskExecutorType,
        (e as Record<string, unknown>).executor_model,
      ),
  );
}
```

- [ ] **Step 4: Update `JobSubmission` and `Job` interfaces**

Replace the scalar `executor`/`executor_model` fields in `JobSubmission` and `Job` with `executors` array:

```ts
export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  marketplaces?: MarketplaceConfig[];
}

export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  enriched_at: string;
  marketplaces?: MarketplaceConfig[];
}
```

- [ ] **Step 5: Add `JobAttempt` interface**

After the `Job` interface:

```ts
export interface JobAttempt {
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

- [ ] **Step 6: Update `packages/shared/src/index.ts`**

Add to the re-exports:

```ts
export {
  // ... existing exports ...
  type ExecutorPreference,
  type JobAttempt,
  isValidExecutorPreferences,
} from './types';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/shared && npx vitest run src/__tests__/types.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/src/__tests__/types.test.ts
git commit -m "feat(shared): add ExecutorPreference, JobAttempt, isValidExecutorPreferences; update Job/JobSubmission to executors array"
```

---

### Task 2: Enrichment YAML and service — array-based rules

**Files:**
- Modify: `packages/daemon/task-enrichment/config/enrichment.yaml`
- Modify: `packages/daemon/task-enrichment/src/enrichment-service.ts`
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`

- [ ] **Step 1: Update enrichment-service.test.ts for array format**

Replace the entire test file `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { Task } from '@local-agent/shared';
import { EnrichmentService } from '../enrichment-service';

function createTask(overrides?: Partial<Task>): Task {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this code',
    submitted_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('EnrichmentService', () => {
  describe('with rules including default', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          code_review: {
            executors: [
              { executor: 'claude_code', executor_model: 'opus' },
              { executor: 'claude_code', executor_model: 'sonnet' },
            ],
          },
          quick_question: {
            executors: [
              { executor: 'claude_code', executor_model: 'haiku' },
            ],
          },
          default: {
            executors: [
              { executor: 'claude_code', executor_model: 'sonnet' },
              { executor: 'ttadk', executor_model: 'gpt-5.4' },
            ],
          },
        },
      });
    });

    it('enriches a task with a matching rule', () => {
      const result = service.enrich(createTask({ task_type: 'code_review' }));

      expect(result).not.toBeNull();
      expect(result!.task_id).toBe('task-123');
      expect(result!.task_type).toBe('code_review');
      expect(result!.payload).toBe('Review this code');
      expect(result!.executors).toEqual([
        { executor: 'claude_code', executor_model: 'opus' },
        { executor: 'claude_code', executor_model: 'sonnet' },
      ]);
      expect(result!.submitted_at).toBe('2026-03-29T00:00:00.000Z');
    });

    it('falls back to default for unknown task_type', () => {
      const result = service.enrich(createTask({ task_type: 'unknown_type' }));

      expect(result).not.toBeNull();
      expect(result!.executors).toEqual([
        { executor: 'claude_code', executor_model: 'sonnet' },
        { executor: 'ttadk', executor_model: 'gpt-5.4' },
      ]);
    });

    it('returns all required JobSubmission fields', () => {
      const result = service.enrich(createTask());

      expect(result).toHaveProperty('task_id');
      expect(result).toHaveProperty('task_type');
      expect(result).toHaveProperty('payload');
      expect(result).toHaveProperty('executors');
      expect(result).toHaveProperty('submitted_at');
    });

    it('preserves executor preference order from rule', () => {
      const result = service.enrich(createTask({ task_type: 'code_review' }));

      expect(result!.executors[0]).toEqual({ executor: 'claude_code', executor_model: 'opus' });
      expect(result!.executors[1]).toEqual({ executor: 'claude_code', executor_model: 'sonnet' });
    });
  });

  describe('with no default rule', () => {
    let service: EnrichmentService;

    beforeEach(() => {
      service = EnrichmentService.fromObject({
        rules: {
          code_review: {
            executors: [{ executor: 'claude_code', executor_model: 'opus' }],
          },
        },
      });
    });

    it('returns null for unknown task_type when no default exists', () => {
      const result = service.enrich(createTask({ task_type: 'unknown_type' }));
      expect(result).toBeNull();
    });

    it('still enriches known task_types', () => {
      const result = service.enrich(createTask({ task_type: 'code_review' }));
      expect(result).not.toBeNull();
      expect(result!.executors).toHaveLength(1);
    });
  });

  describe('validation', () => {
    it('returns null when any executor in array is invalid', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          bad_rule: {
            executors: [
              { executor: 'claude_code', executor_model: 'opus' },
              { executor: 'nonexistent', executor_model: 'opus' },
            ],
          },
        },
      });

      const result = service.enrich(createTask({ task_type: 'bad_rule' }));
      expect(result).toBeNull();
    });

    it('returns null when any executor_model in array is invalid', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          bad_model: {
            executors: [
              { executor: 'claude_code', executor_model: 'nonexistent' },
            ],
          },
        },
      });

      const result = service.enrich(createTask({ task_type: 'bad_model' }));
      expect(result).toBeNull();
    });

    it('returns null when executors array is empty', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          empty: { executors: [] },
        },
      });

      const result = service.enrich(createTask({ task_type: 'empty' }));
      expect(result).toBeNull();
    });
  });

  describe('fromFile', () => {
    it('loads config from a YAML file', () => {
      const configPath = new URL('../../config/enrichment.yaml', import.meta.url).pathname;
      const service = EnrichmentService.fromFile(configPath);
      const result = service.enrich(createTask({ task_type: 'anything' }));

      expect(result).not.toBeNull();
      expect(result!.executors).toEqual([
        { executor: 'claude_code', executor_model: 'sonnet' },
      ]);
    });
  });

  describe('marketplace passthrough', () => {
    it('includes marketplaces from rule in enriched job', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          development: {
            executors: [
              { executor: 'claude_code', executor_model: 'opus' },
              { executor: 'claude_code', executor_model: 'sonnet' },
            ],
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
    });

    it('omits marketplaces when rule has none', () => {
      const service = EnrichmentService.fromObject({
        rules: {
          default: {
            executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
          },
        },
      });

      const result = service.enrich(createTask({ task_type: 'anything' }));

      expect(result).not.toBeNull();
      expect(result!.marketplaces).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: FAIL — enrichment-service still expects scalar fields

- [ ] **Step 3: Update `EnrichmentRule` and `enrich()` in enrichment-service.ts**

Replace `packages/daemon/task-enrichment/src/enrichment-service.ts`:

```ts
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { Task, JobSubmission, isTaskExecutorType, isValidExecutorModel, TaskExecutorType, ExecutorPreference, createLogger } from '@local-agent/shared';

const logger = createLogger('enrichment-daemon:service');

interface EnrichmentRule {
  executors: Array<{ executor: string; executor_model: string }>;
  marketplaces?: Array<{ url: string; plugins: string[] }>;
}

interface EnrichmentConfig {
  rules: Record<string, EnrichmentRule>;
}

export class EnrichmentService {
  private constructor(private readonly rules: Record<string, EnrichmentRule>) {}

  static fromFile(filePath: string): EnrichmentService {
    const content = readFileSync(filePath, 'utf-8');
    const config = yaml.load(content) as EnrichmentConfig;
    return new EnrichmentService(config.rules);
  }

  static fromObject(config: EnrichmentConfig): EnrichmentService {
    return new EnrichmentService(config.rules);
  }

  enrich(task: Task): JobSubmission | null {
    const rule = this.rules[task.task_type] ?? this.rules['default'];

    if (!rule) {
      logger.error({ task_id: task.task_id, task_type: task.task_type }, 'No enrichment rule found and no default — rejecting task');
      return null;
    }

    if (!rule.executors || rule.executors.length === 0) {
      logger.error({ task_id: task.task_id, task_type: task.task_type }, 'Enrichment rule has empty executors array — rejecting task');
      return null;
    }

    const executors: ExecutorPreference[] = [];
    for (const entry of rule.executors) {
      if (!isTaskExecutorType(entry.executor)) {
        logger.error({ task_id: task.task_id, executor: entry.executor }, 'Invalid executor in enrichment rule — rejecting task');
        return null;
      }
      if (!isValidExecutorModel(entry.executor as TaskExecutorType, entry.executor_model)) {
        logger.error({ task_id: task.task_id, executor: entry.executor, model: entry.executor_model }, 'Invalid executor_model in enrichment rule — rejecting task');
        return null;
      }
      executors.push({ executor: entry.executor as TaskExecutorType, executor_model: entry.executor_model });
    }

    return {
      task_id: task.task_id,
      task_type: task.task_type,
      payload: task.payload,
      executors,
      submitted_at: task.submitted_at,
      marketplaces: rule.marketplaces,
    };
  }
}
```

- [ ] **Step 4: Update enrichment.yaml**

Replace `packages/daemon/task-enrichment/config/enrichment.yaml`:

```yaml
rules:
  default:
    executors:
      - executor: claude_code
        executor_model: sonnet
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-service.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task-enrichment/
git commit -m "feat(enrichment): update enrichment rules and service to executors array format"
```

---

### Task 3: Update enrichment-poller test fixtures

**Files:**
- Modify: `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`

- [ ] **Step 1: Update `createJobSubmission()` fixture**

In `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts`, replace the `createJobSubmission` function (lines 26-36):

```ts
function createJobSubmission(overrides?: Partial<JobSubmission>): JobSubmission {
  return {
    task_id: 'task-123',
    task_type: 'code_review',
    payload: 'Review this',
    executors: [
      { executor: 'claude_code', executor_model: 'opus' },
    ],
    submitted_at: '2026-03-29T00:00:00.000Z',
    ...overrides,
  };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd packages/daemon/task-enrichment && npx vitest run src/__tests__/enrichment-poller.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts
git commit -m "test(enrichment): update enrichment-poller fixtures for executors array"
```

---

### Task 4: API jobs route — array validation

**Files:**
- Modify: `packages/api/src/routes/jobs.ts`

- [ ] **Step 1: Update `POST /jobs` validation**

In `packages/api/src/routes/jobs.ts`, update the import (line 3):

```ts
import { Job, isValidExecutorPreferences, ExecutorPreference } from '@local-agent/shared';
```

Replace the body destructuring and validation in the POST handler (lines 11-34). Replace:

```ts
      const { task_id, task_type, payload, executor, executor_model, submitted_at, marketplaces } = req.body;

      if (typeof task_id !== 'string' || !task_id) {
        res.status(400).json({ error: 'task_id is required and must be a string' });
        return;
      }
      if (typeof task_type !== 'string' || !task_type) {
        res.status(400).json({ error: 'task_type is required and must be a string' });
        return;
      }
      if (typeof payload !== 'string') {
        res.status(400).json({ error: 'payload is required and must be a string' });
        return;
      }
      if (typeof executor !== 'string' || !isTaskExecutorType(executor)) {
        res.status(400).json({ error: `executor is required and must be one of: ${TASK_EXECUTOR_OPTIONS}` });
        return;
      }
      if (!isValidExecutorModel(executor, executor_model)) {
        res.status(400).json({
          error: `executor_model must be one of: ${getExecutorModelOptions(executor)}`,
        });
        return;
      }
      if (typeof submitted_at !== 'string' || !submitted_at) {
        res.status(400).json({ error: 'submitted_at is required and must be a string' });
        return;
      }
```

With:

```ts
      const { task_id, task_type, payload, executors, submitted_at, marketplaces } = req.body;

      if (typeof task_id !== 'string' || !task_id) {
        res.status(400).json({ error: 'task_id is required and must be a string' });
        return;
      }
      if (typeof task_type !== 'string' || !task_type) {
        res.status(400).json({ error: 'task_type is required and must be a string' });
        return;
      }
      if (typeof payload !== 'string') {
        res.status(400).json({ error: 'payload is required and must be a string' });
        return;
      }
      if (!isValidExecutorPreferences(executors)) {
        res.status(400).json({
          error: 'executors must be a non-empty array of valid {executor, executor_model} pairs',
        });
        return;
      }
      if (typeof submitted_at !== 'string' || !submitted_at) {
        res.status(400).json({ error: 'submitted_at is required and must be a string' });
        return;
      }
```

Replace the `Job` construction (lines 40-50):

```ts
      const job: Job = {
        job_id: uuidv4(),
        task_id,
        task_type,
        payload,
        executors,
        submitted_at,
        enriched_at: new Date().toISOString(),
        ...(marketplaces ? { marketplaces } : {}),
      };
```

- [ ] **Step 2: Run API tests to verify**

Run: `cd packages/api && npx vitest run`
Expected: Some tests may fail due to fixture changes — those are handled in Task 5.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/routes/jobs.ts
git commit -m "feat(api): update POST /jobs to validate executors array instead of scalar fields"
```

---

### Task 5: Update API test fixtures

**Files:**
- Modify: `packages/api/src/__tests__/services/rabbitmq.test.ts`

- [ ] **Step 1: Update RabbitMQ test fixtures**

In `packages/api/src/__tests__/services/rabbitmq.test.ts`, update all Job/message fixtures that contain scalar `executor`/`executor_model` to use `executors` array.

Replace the `getNext` test message content (lines 83-90):

```ts
      const content = JSON.stringify({
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'hello',
        executors: [{ executor: 'ttadk', executor_model: 'gpt-5.4' }],
        submitted_at: '2026-03-26T00:00:00.000Z',
      });
```

And the corresponding assertion (lines 97-104):

```ts
      expect(result).toEqual({
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'hello',
        executors: [{ executor: 'ttadk', executor_model: 'gpt-5.4' }],
        submitted_at: '2026-03-26T00:00:00.000Z',
      });
```

Update the `ack` test message (lines 111-118):

```ts
      const content = JSON.stringify({
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'hello',
        executors: [{ executor: 'claude_code', executor_model: 'opus' }],
        submitted_at: '2026-03-26T00:00:00.000Z',
      });
```

Update the duplicate task first message (lines 132-138):

```ts
          task_id: 'duplicate-id',
          task_type: 'generic',
          payload: 'first',
          executors: [{ executor: 'claude_code', executor_model: 'opus' }],
          submitted_at: '2026-03-26T00:00:00.000Z',
```

Update the duplicate task second message (lines 144-150):

```ts
          task_id: 'duplicate-id',
          task_type: 'generic',
          payload: 'second',
          executors: [{ executor: 'ttadk', executor_model: 'gpt-5.4' }],
          submitted_at: '2026-03-26T00:00:01.000Z',
```

Update the duplicate task assertion (lines 160-167):

```ts
      expect(firstTask).toEqual({
        task_id: 'duplicate-id',
        task_type: 'generic',
        payload: 'first',
        executors: [{ executor: 'claude_code', executor_model: 'opus' }],
        submitted_at: '2026-03-26T00:00:00.000Z',
      });
```

- [ ] **Step 2: Run all API tests**

Run: `cd packages/api && npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/__tests__/services/rabbitmq.test.ts
git commit -m "test(api): update RabbitMQ test fixtures for executors array"
```

---

### Task 6: TaskExecutor port and adapter signatures — `Job` to `JobAttempt`

**Files:**
- Modify: `packages/daemon/task/src/ports/task-executor.ts`
- Modify: `packages/daemon/task/src/adapters/claude-cli-executor.ts`
- Modify: `packages/daemon/task/src/adapters/ttadk-executor.ts`

- [ ] **Step 1: Update TaskExecutor port**

Replace `packages/daemon/task/src/ports/task-executor.ts`:

```ts
import { JobAttempt, TaskResultSubmission } from '@local-agent/shared';
import { ExecutionEnvironment } from '../services/job-environment';

export interface TaskExecutor {
  execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission>;
}
```

- [ ] **Step 2: Update ClaudeCliExecutor signature**

In `packages/daemon/task/src/adapters/claude-cli-executor.ts`, update the import (line 2):

```ts
import { JobAttempt, TaskResultSubmission, MAX_RESULT_OUTPUT_BYTES, createLogger, truncate } from '@local-agent/shared';
```

Update the `execute` method signature (line 9):

```ts
  async execute(job: JobAttempt, env: ExecutionEnvironment): Promise<TaskResultSubmission> {
```

- [ ] **Step 3: Update TTADKExecutor signature**

In `packages/daemon/task/src/adapters/ttadk-executor.ts`, apply the same import and signature changes:

Update import to use `JobAttempt` instead of `Job`.
Update `execute` method signature to `execute(job: JobAttempt, ...)`.

- [ ] **Step 4: Verify compilation**

Run: `cd packages/daemon/task && npx tsc --noEmit`
Expected: May have errors in orchestrator (fixed in Task 7) and tests (fixed in Task 8)

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/ports/task-executor.ts packages/daemon/task/src/adapters/claude-cli-executor.ts packages/daemon/task/src/adapters/ttadk-executor.ts
git commit -m "refactor(task-daemon): update TaskExecutor port and adapters from Job to JobAttempt"
```

---

### Task 7: TaskOrchestrator — fallback loop

**Files:**
- Modify: `packages/daemon/task/src/core/task-orchestrator.ts`
- Modify: `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`

- [ ] **Step 1: Write failing tests for fallback behavior**

Add new tests to `packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts`.

First, update the `createJob` fixture to use `executors` array:

```ts
function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executors: [{ executor: 'claude_code', executor_model: 'opus' }],
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    ...overrides,
  };
}
```

Update the import to include `JobAttempt`:

```ts
import { Job, JobAttempt, TaskResultSubmission } from '@local-agent/shared';
```

Update existing test assertions that reference `job` passed to `mockClaudeExecute` — they should now expect a `JobAttempt`:

```ts
const expectedAttempt: JobAttempt = {
  job_id: 'job-456',
  task_id: 'test-123',
  task_type: 'generic',
  payload: 'What is 2+2?',
  executor: 'claude_code',
  executor_model: 'opus',
  submitted_at: '2026-03-26T00:00:00.000Z',
  enriched_at: '2026-03-26T00:00:01.000Z',
};
```

Then add new tests:

```ts
  it('falls back to second executor when first fails', async () => {
    const failResult: TaskResultSubmission = {
      job_id: 'job-456',
      task_id: 'test-123',
      status: 'failure',
      exit_code: 1,
      stdout: '',
      stderr: 'model unavailable',
    };
    const successResult: TaskResultSubmission = {
      job_id: 'job-456',
      task_id: 'test-123',
      status: 'success',
      exit_code: 0,
      stdout: 'fallback output',
      stderr: '',
    };

    mockClaudeExecute.mockResolvedValueOnce(failResult);
    mockTTADKExecute.mockResolvedValueOnce(successResult);

    const job = createJob({
      executors: [
        { executor: 'claude_code', executor_model: 'opus' },
        { executor: 'ttadk', executor_model: 'gpt-5.4' },
      ],
    });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('success');
    expect(result.stdout).toBe('fallback output');
    expect(mockClaudeExecute).toHaveBeenCalledTimes(1);
    expect(mockTTADKExecute).toHaveBeenCalledTimes(1);
    expect(mockSetup).toHaveBeenCalledTimes(2);
    expect(mockTeardown).toHaveBeenCalledTimes(2);
  });

  it('returns last failure when all executors fail', async () => {
    const failResult1: TaskResultSubmission = {
      job_id: 'job-456',
      task_id: 'test-123',
      status: 'failure',
      exit_code: 1,
      stdout: '',
      stderr: 'first failure',
    };
    const failResult2: TaskResultSubmission = {
      job_id: 'job-456',
      task_id: 'test-123',
      status: 'failure',
      exit_code: 1,
      stdout: '',
      stderr: 'second failure',
    };

    mockClaudeExecute.mockResolvedValueOnce(failResult1);
    mockTTADKExecute.mockResolvedValueOnce(failResult2);

    const job = createJob({
      executors: [
        { executor: 'claude_code', executor_model: 'opus' },
        { executor: 'ttadk', executor_model: 'gpt-5.4' },
      ],
    });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('failure');
    expect(result.stderr).toBe('second failure');
  });

  it('returns success immediately without trying remaining executors', async () => {
    const job = createJob({
      executors: [
        { executor: 'claude_code', executor_model: 'opus' },
        { executor: 'ttadk', executor_model: 'gpt-5.4' },
      ],
    });
    const result = await orchestrator.handle(job);

    expect(result.status).toBe('success');
    expect(mockClaudeExecute).toHaveBeenCalledTimes(1);
    expect(mockTTADKExecute).not.toHaveBeenCalled();
    expect(mockSetup).toHaveBeenCalledTimes(1);
    expect(mockTeardown).toHaveBeenCalledTimes(1);
  });

  it('constructs correct JobAttempt for each executor preference', async () => {
    const failResult: TaskResultSubmission = {
      job_id: 'job-456',
      task_id: 'test-123',
      status: 'failure',
      exit_code: 1,
      stdout: '',
      stderr: 'fail',
    };
    mockClaudeExecute.mockResolvedValueOnce(failResult);

    const job = createJob({
      executors: [
        { executor: 'claude_code', executor_model: 'opus' },
        { executor: 'ttadk', executor_model: 'gpt-5.4' },
      ],
    });
    await orchestrator.handle(job);

    expect(mockClaudeExecute).toHaveBeenCalledWith(
      expect.objectContaining({ executor: 'claude_code', executor_model: 'opus' }),
      mockEnv,
    );
    expect(mockTTADKExecute).toHaveBeenCalledWith(
      expect.objectContaining({ executor: 'ttadk', executor_model: 'gpt-5.4' }),
      mockEnv,
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: FAIL — orchestrator doesn't have fallback loop yet

- [ ] **Step 3: Implement fallback loop in TaskOrchestrator**

Replace `packages/daemon/task/src/core/task-orchestrator.ts`:

```ts
import { Job, JobAttempt, TaskResultSubmission, TaskExecutorType, createLogger } from '@local-agent/shared';
import { ClaudeCliExecutor } from '../adapters/claude-cli-executor';
import { TTADKExecutor } from '../adapters/ttadk-executor';
import { TaskExecutor } from '../ports/task-executor';
import { JobEnvironment, ExecutionEnvironment } from '../services/job-environment';

const logger = createLogger('task-daemon:orchestrator');

export class TaskOrchestrator {
  constructor(private readonly jobEnv: JobEnvironment) {}

  async handle(job: Job): Promise<TaskResultSubmission> {
    logger.info(
      { job_id: job.job_id, task_id: job.task_id, task_type: job.task_type, executors: job.executors },
      'Processing job',
    );

    let lastResult: TaskResultSubmission | null = null;

    for (let i = 0; i < job.executors.length; i++) {
      const pref = job.executors[i];
      const isLast = i === job.executors.length - 1;

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
        const executor = this.resolveExecutor(pref.executor);
        const attempt: JobAttempt = {
          job_id: job.job_id,
          task_id: job.task_id,
          task_type: job.task_type,
          payload: job.payload,
          executor: pref.executor,
          executor_model: pref.executor_model,
          submitted_at: job.submitted_at,
          enriched_at: job.enriched_at,
          marketplaces: job.marketplaces,
        };

        lastResult = await executor.execute(attempt, env);

        if (lastResult.status === 'success') {
          return lastResult;
        }

        if (!isLast) {
          logger.warn(
            { job_id: job.job_id, executor: pref.executor, model: pref.executor_model, attempt: i + 1 },
            'Executor failed, trying next preference',
          );
        }
      } catch (error) {
        logger.error({ job_id: job.job_id, err: error }, 'Job execution failed');
        lastResult = {
          job_id: job.job_id,
          task_id: job.task_id,
          status: 'failure',
          exit_code: null,
          stdout: '',
          stderr: `Job execution failed: ${error instanceof Error ? error.message : String(error)}`,
        };

        if (!isLast) {
          logger.warn(
            { job_id: job.job_id, executor: pref.executor, model: pref.executor_model, attempt: i + 1 },
            'Executor threw, trying next preference',
          );
        }
      } finally {
        await this.jobEnv.teardown(env!);
      }
    }

    logger.error({ job_id: job.job_id }, 'All executor preferences exhausted');
    return lastResult!;
  }

  private resolveExecutor(executor: TaskExecutorType): TaskExecutor {
    if (executor === 'claude_code') return new ClaudeCliExecutor();
    if (executor === 'ttadk') return new TTADKExecutor();
    throw new Error(`Unknown executor: ${executor}`);
  }
}
```

- [ ] **Step 4: Run orchestrator tests**

Run: `cd packages/daemon/task && npx vitest run src/core/__tests__/task-orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/core/task-orchestrator.ts packages/daemon/task/src/core/__tests__/task-orchestrator.test.ts
git commit -m "feat(task-daemon): add executor fallback loop in TaskOrchestrator"
```

---

### Task 8: Update remaining task-daemon test fixtures

**Files:**
- Modify: `packages/daemon/task/src/__tests__/task-poller.test.ts`
- Modify: `packages/daemon/task/src/services/__tests__/job-environment.test.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts`
- Modify: `packages/daemon/task/src/adapters/__tests__/ttadk-executor.test.ts`

- [ ] **Step 1: Update task-poller.test.ts `createJob` fixture**

In `packages/daemon/task/src/__tests__/task-poller.test.ts`, replace the `createJob` function (lines 44-56):

```ts
function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-456',
    task_id: 'abc-123',
    task_type: 'generic',
    payload: 'hello',
    executors: [{ executor: 'claude_code', executor_model: 'opus' }],
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    ...overrides,
  };
}
```

- [ ] **Step 2: Update job-environment.test.ts `createJob` fixture**

In `packages/daemon/task/src/services/__tests__/job-environment.test.ts`, replace the `createJob` function (lines 15-27):

```ts
function createJob(overrides?: Partial<Job>): Job {
  return {
    job_id: 'job-test-001',
    task_id: 'task-test-001',
    task_type: 'generic',
    payload: 'test payload',
    executors: [{ executor: 'claude_code', executor_model: 'sonnet' }],
    submitted_at: '2026-03-29T00:00:00.000Z',
    enriched_at: '2026-03-29T00:00:01.000Z',
    ...overrides,
  };
}
```

- [ ] **Step 3: Update claude-cli-executor.test.ts fixture**

In `packages/daemon/task/src/adapters/__tests__/claude-cli-executor.test.ts`, change the import from `Job` to `JobAttempt` and update `createJob` to `createJobAttempt` using `JobAttempt` type. The fixture should have scalar `executor`/`executor_model` fields (since executors receive `JobAttempt`, not `Job`):

```ts
import { JobAttempt, TaskResultSubmission } from '@local-agent/shared';

function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
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
```

Update all references from `createJob()` to `createJobAttempt()` in the test.

- [ ] **Step 4: Update ttadk-executor.test.ts fixture**

Same pattern as Step 3, but with `executor: 'ttadk'` and `executor_model: 'gpt-5.4'`:

```ts
import { JobAttempt, TaskResultSubmission } from '@local-agent/shared';

function createJobAttempt(overrides?: Partial<JobAttempt>): JobAttempt {
  return {
    job_id: 'job-456',
    task_id: 'test-123',
    task_type: 'generic',
    payload: 'What is 2+2?',
    executor: 'ttadk',
    executor_model: 'gpt-5.4',
    submitted_at: '2026-03-26T00:00:00.000Z',
    enriched_at: '2026-03-26T00:00:01.000Z',
    ...overrides,
  };
}
```

Update all references from `createJob()` to `createJobAttempt()`.

- [ ] **Step 5: Run all task-daemon tests**

Run: `cd packages/daemon/task && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task/src/__tests__/ packages/daemon/task/src/services/__tests__/ packages/daemon/task/src/adapters/__tests__/
git commit -m "test(task-daemon): update all test fixtures for executors array and JobAttempt"
```

---

### Task 9: Full integration verification

- [ ] **Step 1: Run all tests across all packages**

Run: `npx rush test` (or `cd packages/shared && npx vitest run && cd ../api && npx vitest run && cd ../daemon/task-enrichment && npx vitest run && cd ../task && npx vitest run`)
Expected: All PASS

- [ ] **Step 2: Type-check all packages**

Run: `npx rush build` (or run `npx tsc --noEmit` in each package)
Expected: No type errors

- [ ] **Step 3: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: resolve any remaining type/test issues from executor preference array migration"
```
