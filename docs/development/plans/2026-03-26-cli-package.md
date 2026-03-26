# CLI Package Implementation Plan

**Goal:** Add a `@local-agent/cli` package that provides a `local-agent submit` command to submit tasks to the queue via the HTTP API.

**Architecture:** A thin Commander.js CLI that sends `POST /tasks` to the existing Express API using Node 20's built-in `fetch`. The `submitTask` function is a pure async function (no side-effects beyond the HTTP call) making it trivially testable with a mocked `global.fetch`.

**Tech Stack:** TypeScript, Commander.js, Node 20 `fetch`, Vitest

---

### Task 1: Scaffold package boilerplate

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/vitest.config.ts`
- Create: `packages/cli/src/` (directory)
- Create: `packages/cli/src/commands/` (directory)
- Modify: `rush.json` (add project entry)

- [ ] **Step 1: Create `packages/cli/package.json`**

```json
{
  "name": "@local-agent/cli",
  "version": "0.0.1",
  "private": true,
  "bin": {
    "local-agent": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "@local-agent/shared": "workspace:*",
    "commander": "^13.0.0"
  },
  "devDependencies": {
    "typescript": "~5.7.0",
    "vitest": "~1.6.0",
    "rimraf": "~5.0.0",
    "ts-node": "~10.9.0"
  }
}
```

- [ ] **Step 2: Create `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/__tests__/**/*"]
}
```

- [ ] **Step 3: Create `packages/cli/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: './src',
  },
});
```

- [ ] **Step 4: Add CLI project to `rush.json`**

Add the following entry to the `projects` array in `rush.json` (after the daemon entry):

```json
{
  "packageName": "@local-agent/cli",
  "projectFolder": "packages/cli"
}
```

The full `projects` array should be:
```json
"projects": [
  { "packageName": "@local-agent/shared", "projectFolder": "packages/shared" },
  { "packageName": "@local-agent/api", "projectFolder": "packages/api" },
  { "packageName": "@local-agent/daemon", "projectFolder": "packages/daemon" },
  { "packageName": "@local-agent/cli", "projectFolder": "packages/cli" }
]
```

- [ ] **Step 5: Run `rush update` to install dependencies**

Run: `node common/scripts/install-run-rush.js update`
Expected: Successful install, `common/config/rush/pnpm-lock.yaml` updated, `node_modules` symlinked for the cli package.

- [ ] **Step 6: Verify TypeScript compiles (empty project)**

Create a placeholder `packages/cli/src/index.ts`:

```typescript
// Placeholder — will be replaced in Task 3
console.log('cli placeholder');
```

Run: `cd packages/cli && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/package.json packages/cli/tsconfig.json packages/cli/vitest.config.ts packages/cli/src/index.ts rush.json
git commit -m "feat(cli): scaffold @local-agent/cli package"
```

---

### Task 2: Implement `submitTask` function (TDD)

**Files:**
- Create: `packages/cli/src/__tests__/submit.test.ts`
- Create: `packages/cli/src/commands/submit.ts`

This task implements the pure `submitTask` function using TDD. The function takes `SubmitOptions`, makes a `POST /tasks` HTTP call, and returns a `SubmitResult`. Tests mock `global.fetch`.

- [ ] **Step 1: Write the test file with all 5 test cases**

Create `packages/cli/src/__tests__/submit.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitTask } from '../commands/submit';

const mockFetch = vi.fn();

describe('submitTask', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success with taskType and submittedAt on 201', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_type: 'generic',
        payload: 'test prompt',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    const result = await submitTask({
      payload: 'test prompt',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: true,
      taskType: 'generic',
      submittedAt: '2026-03-26T10:00:00.000Z',
    });
  });

  it('sends correct request body and headers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        task_type: 'code-review',
        payload: 'review this',
        submitted_at: '2026-03-26T10:00:00.000Z',
      }),
    });

    await submitTask({
      payload: 'review this',
      type: 'code-review',
      apiUrl: 'http://example.com:3000',
    });

    expect(mockFetch).toHaveBeenCalledWith('http://example.com:3000/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_type: 'code-review', payload: 'review this' }),
    });
  });

  it('returns error on HTTP 503', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const result = await submitTask({
      payload: 'test',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: '503 Service Unavailable',
    });
  });

  it('returns error on HTTP 400', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    });

    const result = await submitTask({
      payload: 'test',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: '400 Bad Request',
    });
  });

  it('returns connection error when fetch throws', async () => {
    const cause = { code: 'ECONNREFUSED' };
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed', { cause }));

    const result = await submitTask({
      payload: 'test',
      type: 'generic',
      apiUrl: 'http://localhost:3000',
    });

    expect(result).toEqual({
      success: false,
      error: 'connection refused (http://localhost:3000/tasks)',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && npx vitest run`
Expected: All 5 tests FAIL — `submitTask` does not exist yet.

- [ ] **Step 3: Implement `submitTask` in `packages/cli/src/commands/submit.ts`**

```typescript
import type { TaskSubmission } from '@local-agent/shared';

export interface SubmitOptions {
  payload: string;
  type: string;
  apiUrl: string;
}

export interface SubmitResult {
  success: boolean;
  taskType?: string;
  submittedAt?: string;
  error?: string;
}

export async function submitTask(options: SubmitOptions): Promise<SubmitResult> {
  const url = `${options.apiUrl}/tasks`;
  const body: TaskSubmission = {
    task_type: options.type,
    payload: options.payload,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const cause = (err as TypeError & { cause?: { code?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED') {
      return { success: false, error: `connection refused (${url})` };
    }
    return { success: false, error: `network error (${url})` };
  }

  if (!response.ok) {
    return { success: false, error: `${response.status} ${response.statusText}` };
  }

  const data = await response.json();
  return {
    success: true,
    taskType: data.task_type,
    submittedAt: data.submitted_at,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && npx vitest run`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/submit.ts packages/cli/src/__tests__/submit.test.ts
git commit -m "feat(cli): implement submitTask with tests"
```

---

### Task 3: Wire up Commander CLI entry point

**Files:**
- Modify: `packages/cli/src/commands/submit.ts` (add `registerSubmitCommand`)
- Modify: `packages/cli/src/index.ts` (replace placeholder)

- [ ] **Step 1: Add `registerSubmitCommand` to `packages/cli/src/commands/submit.ts`**

Add the following to the **end** of `packages/cli/src/commands/submit.ts` (after the existing `submitTask` function):

```typescript
import { Command } from 'commander';
import { DEFAULT_API_URL } from '@local-agent/shared';

export function registerSubmitCommand(program: Command): void {
  program
    .command('submit')
    .description('Submit a task to the queue')
    .requiredOption('-p, --payload <string>', 'Task payload')
    .option('-t, --type <string>', 'Task type', 'generic')
    .option('-u, --api-url <string>', 'API base URL')
    .action(async (opts: { payload: string; type: string; apiUrl?: string }) => {
      const apiUrl = opts.apiUrl ?? process.env.API_URL ?? DEFAULT_API_URL;

      const result = await submitTask({ payload: opts.payload, type: opts.type, apiUrl });

      if (result.success) {
        console.log('Task submitted successfully.');
        console.log(`  Type: ${result.taskType}`);
        console.log(`  Submitted at: ${result.submittedAt}`);
      } else {
        console.error(`Error: Failed to submit task — ${result.error}`);
        process.exit(1);
      }
    });
}
```

Note: The `import` for `Command` and `DEFAULT_API_URL` goes at the top of the file with the existing imports. The `import type { TaskSubmission }` already exists.

The final imports block at the top of `submit.ts` should be:

```typescript
import { Command } from 'commander';
import type { TaskSubmission } from '@local-agent/shared';
import { DEFAULT_API_URL } from '@local-agent/shared';
```

- [ ] **Step 2: Replace `packages/cli/src/index.ts` with the CLI entry point**

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { registerSubmitCommand } from './commands/submit';

const program = new Command();

program
  .name('local-agent')
  .description('CLI for the LocalAgent task queue')
  .version('0.0.1');

registerSubmitCommand(program);

program.parse();
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd packages/cli && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Verify tests still pass**

Run: `cd packages/cli && npx vitest run`
Expected: All 5 tests still PASS.

- [ ] **Step 5: Build and verify the bin works**

Run: `cd packages/cli && npx tsc`
Then: `node dist/index.js --help`
Expected: Prints help text showing `local-agent` with the `submit` command.

Then: `node dist/index.js submit --help`
Expected: Prints help showing `--payload`, `--type`, `--api-url` flags.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/commands/submit.ts
git commit -m "feat(cli): wire up Commander entry point with submit command"
```

---

### Task 4: Run `rush update` and full build verification

**Files:**
- Modified by Rush: `common/config/rush/pnpm-lock.yaml` (already updated in Task 1 step 5, but verify)

- [ ] **Step 1: Run rush update**

Run: `node common/scripts/install-run-rush.js update`
Expected: Successful, no errors.

- [ ] **Step 2: Run rush build for the CLI package**

Run: `node common/scripts/install-run-rush.js build --to @local-agent/cli`
Expected: Builds `@local-agent/shared` first (dependency), then `@local-agent/cli`. Both succeed.

- [ ] **Step 3: Run all tests across the monorepo**

Run: `node common/scripts/install-run-rush.js build && cd packages/cli && npx vitest run && cd ../daemon && npx vitest run && cd ../api && npx vitest run && cd ../shared && npx vitest run`
Expected: All tests pass across all packages. No regressions.

- [ ] **Step 4: Commit lock file changes (if any)**

```bash
git add common/config/rush/pnpm-lock.yaml
git commit -m "chore: update pnpm-lock after adding cli package"
```

If there are no lock file changes (already committed in Task 1), skip this step.
