# CLI Package — Design Specification

**Date:** 2026-03-26
**Status:** Draft

## 1. Overview

A new `@local-agent/cli` package that provides a command-line interface for submitting tasks to the LocalAgent task queue via the existing HTTP API.

### 1.1 Goals

- Submit tasks to the queue from the command line (`local-agent submit --payload "..."`)
- Communicate exclusively via the HTTP API (`POST /tasks`)
- Installable as a global command via npm (`local-agent`)
- Follow existing monorepo conventions (Rush 5, TypeScript, Vitest)
- Reuse shared types from `@local-agent/shared`

### 1.2 Non-Goals

- Task consumption, acknowledgment, or monitoring
- Direct RabbitMQ communication
- Interactive/REPL mode
- Configuration file support (e.g., `.local-agentrc`)

## 2. Architecture

```
┌─────────────────┐     HTTP POST /tasks     ┌─────────────┐
│  local-agent     │ ──────────────────────> │   API        │
│  CLI (Host OS)   │ <────────────────────── │  (Express)   │
│                  │     201 / 4xx / 5xx      └─────────────┘
└─────────────────┘
```

The CLI is a thin HTTP client. It parses command-line arguments, constructs a `TaskSubmission` payload, sends it to the API, and prints the result.

### 2.1 Package Structure

```
packages/cli/
├── src/
│   ├── index.ts              # Entry point: #!/usr/bin/env node, Commander program setup
│   ├── commands/
│   │   └── submit.ts         # Submit command: argument parsing, HTTP call, output
│   └── __tests__/
│       └── submit.test.ts    # Unit tests with mocked fetch
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### 2.2 Dependencies

| Dependency | Type | Purpose |
|-----------|------|---------|
| `commander` | runtime | CLI argument parsing, help generation |
| `@local-agent/shared` | runtime (workspace) | `TaskSubmission` type, `DEFAULT_API_URL` constant |
| `typescript` | dev | Compilation |
| `vitest` | dev | Testing |
| `rimraf` | dev | Clean script |

No HTTP client library — uses Node 20's built-in `fetch`.

## 3. CLI Interface

### 3.1 Command: `local-agent submit`

```
local-agent submit --payload <string> [--type <string>] [--api-url <string>]
```

**Flags:**

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--payload`, `-p` | Yes | — | The task payload string |
| `--type`, `-t` | No | `"generic"` | The task type |
| `--api-url`, `-u` | No | `API_URL` env var, then `http://localhost:3000` | API base URL |

**Examples:**

```bash
# Basic usage
local-agent submit --payload "Refactor the auth module"

# With explicit type
local-agent submit --type code-review --payload "Review PR #42"

# With custom API URL
local-agent submit --api-url http://prod:3000 --payload "Deploy v2"

# Using environment variable
export API_URL=http://prod:3000
local-agent submit --payload "Deploy v2"
```

### 3.2 Output

**Success (exit code 0):**
```
Task submitted successfully.
  Type: generic
  Submitted at: 2026-03-26T10:30:00.000Z
```

**Error (exit code 1):**
```
Error: Failed to submit task — connection refused (http://localhost:3000/tasks)
```
```
Error: Failed to submit task — 503 Service Unavailable
```

### 3.3 API URL Resolution Order

1. `--api-url` flag (highest priority)
2. `API_URL` environment variable (consistent with daemon's `loadDaemonConfig`)
3. `DEFAULT_API_URL` from `@local-agent/shared/constants` (`http://localhost:3000`)

## 4. Module Design

### 4.1 `src/index.ts` — Entry Point

- Shebang line: `#!/usr/bin/env node`
- Creates Commander `program` with name, version, description
- Registers the `submit` command
- Calls `program.parse()`

### 4.2 `src/commands/submit.ts` — Submit Command

Exports two things:

1. **`registerSubmitCommand(program: Command): void`** — Registers the `submit` command with Commander, defining flags and the action handler.

2. **`submitTask(options: SubmitOptions): Promise<SubmitResult>`** — Pure function that performs the HTTP call. This is the unit under test.

```typescript
interface SubmitOptions {
  payload: string;
  type: string;
  apiUrl: string;
}

interface SubmitResult {
  success: boolean;
  taskType?: string;
  submittedAt?: string;
  error?: string;
}
```

The action handler resolves the API URL (flag > env > default), calls `submitTask`, formats the output, and sets the exit code.

### 4.3 HTTP Behavior

- `POST` to `${apiUrl}/tasks` with `Content-Type: application/json`
- Body: `{ task_type, payload }` (matching `TaskSubmission` interface)
- On 201: parse response JSON, extract `task_type` and `submitted_at`
- On non-201: extract error message from response body if possible, otherwise use status text
- On network error (fetch throws): catch and produce a human-readable connection error

## 5. Error Handling

| Scenario | Message | Exit Code |
|----------|---------|-----------|
| Missing `--payload` | Commander's built-in required option error | 1 |
| Network error (ECONNREFUSED) | `Error: Failed to submit task — connection refused (<url>)` | 1 |
| HTTP 4xx | `Error: Failed to submit task — <status> <statusText>` | 1 |
| HTTP 5xx | `Error: Failed to submit task — <status> <statusText>` | 1 |
| Success | Confirmation message | 0 |

All errors are written to stderr. Success output goes to stdout.

## 6. Monorepo Integration

### 6.1 Rush Configuration

Add to `rush.json` projects array:
```json
{
  "packageName": "@local-agent/cli",
  "projectFolder": "packages/cli"
}
```

### 6.2 package.json

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

### 6.3 tsconfig.json

Extends `../../tsconfig.base.json`, matching existing packages. Sets `rootDir: ./src`, `outDir: ./dist`, excludes test files from build.

## 7. Testing Strategy

Unit tests only, using Vitest with mocked `global.fetch`.

### 7.1 Test Cases for `submitTask`

| Test | Setup | Assertion |
|------|-------|-----------|
| Successful submission | Mock fetch returns 201 with `{task_type, payload, submitted_at}` | Returns `{success: true, taskType, submittedAt}` |
| Network error | Mock fetch throws `TypeError` with `cause.code = 'ECONNREFUSED'` | Returns `{success: false, error: "connection refused..."}` |
| Server error (503) | Mock fetch returns 503 | Returns `{success: false, error: "503 Service Unavailable"}` |
| Validation error (400) | Mock fetch returns 400 | Returns `{success: false, error: "400 Bad Request"}` |
| Sends correct request body | Mock fetch, capture request | Body matches `{task_type, payload}`, Content-Type is `application/json` |

### 7.2 Test Pattern

```typescript
// Mock global fetch before each test
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Test
mockFetch.mockResolvedValueOnce({
  ok: true,
  status: 201,
  json: async () => ({ task_type: 'generic', payload: 'test', submitted_at: '2026-03-26T00:00:00Z' }),
});

const result = await submitTask({ payload: 'test', type: 'generic', apiUrl: 'http://localhost:3000' });
expect(result.success).toBe(true);
```
