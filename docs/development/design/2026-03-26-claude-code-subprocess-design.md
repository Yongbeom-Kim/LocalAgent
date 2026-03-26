# Design: Claude Code Subprocess Spawning in Daemon Handler

**Date:** 2026-03-26
**Status:** Draft
**Scope:** `packages/daemon/src/handler.ts` and its tests

## 1. Overview

When the daemon consumes a task from the queue, it should spawn a Claude Code CLI instance as a subprocess, passing the task's `payload` as the prompt, then capture and log the result.

## 2. Requirements

1. **Spawn Claude Code:** For each consumed task, run `claude -p '<payload>'` as a child process.
2. **Capture output:** Collect stdout and stderr after the process completes.
3. **Log result:** Log stdout, stderr, and exit code via the existing Pino structured logger.
4. **Error handling:** On failure (non-zero exit, crash), log at error level but do not throw — the poller should still ACK the task.
5. **No timeout:** Let the process run to completion without a time limit.
6. **Sequential processing:** One task at a time (the existing poller architecture already enforces this by awaiting the handler).
7. **No additional CLI flags:** Only use `-p` flag. No `--model`, `--allowedTools`, etc.
8. **Working directory:** Use the daemon's own cwd (no special directory configuration).
9. **task_type field:** Ignored — all tasks spawn Claude Code regardless of `task_type`.

## 3. Non-Requirements (explicitly excluded)

- Concurrency / parallel task processing
- Timeouts or resource limits
- Streaming output in real-time
- Sending results back to the API
- Writing results to files
- Per-task working directory
- task_type-based routing

## 4. Technical Design

### 4.1 Module: `packages/daemon/src/handler.ts`

Replace the current placeholder implementation with subprocess spawning logic.

**Dependencies:**
- `node:child_process` — built-in Node.js module, `execFile` promisified via `node:util`
- No new npm packages required

**Implementation:**

```typescript
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Task, createLogger } from '@local-agent/shared';

const logger = createLogger('daemon:handler');
const execFileAsync = promisify(execFile);

export async function handleTask(task: Task): Promise<void> {
  logger.info({ task_id: task.task_id, task_type: task.task_type }, 'Spawning Claude Code');

  try {
    const { stdout, stderr } = await execFileAsync('claude', ['-p', task.payload], {
      maxBuffer: 50 * 1024 * 1024, // 50 MB — Claude Code responses can be large
    });

    logger.info(
      { task_id: task.task_id, stdout, stderr },
      'Claude Code completed',
    );
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    logger.error(
      {
        task_id: task.task_id,
        exit_code: execErr.code,
        stdout: execErr.stdout,
        stderr: execErr.stderr,
      },
      'Claude Code failed',
    );
  }
}
```

**Key decisions:**

1. **`execFile` over `spawn`:** Since we capture output after completion (not streaming), `execFile` is simpler — it buffers stdout/stderr internally and resolves with both.

2. **`execFile` over `exec`:** `execFile` does not use a shell, which avoids shell injection risks from untrusted payloads. The prompt is passed as an argument array element, not interpolated into a shell command.

3. **Error swallowing:** The try/catch ensures the handler never throws. `execFile` rejects on non-zero exit codes, putting stdout/stderr on the error object. We log these and return normally.

4. **No payload escaping needed:** Because `execFile` passes arguments directly to the process (no shell), special characters in the payload are safe.

5. **Increased `maxBuffer`:** Node.js `execFile` defaults to a 1 MB buffer for stdout/stderr. Claude Code responses can exceed this, which would cause `execFile` to kill the child process with an `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` error — contradicting the "no timeout, run to completion" requirement. A 50 MB limit provides ample headroom.

### 4.2 Integration with Poller

No changes to `poller.ts`. The existing flow already works:

```
pollOnce() → fetch task → await handler(task) → ack task
```

The handler is awaited, so sequential processing is maintained. If the handler takes a long time (Claude Code running), the poller simply waits before polling again.

### 4.3 Integration with Shared Package

No changes to the shared package. The existing `Task` interface and `createLogger` function are sufficient.

### 4.4 Configuration

No new configuration. The `claude` binary must be on the system PATH where the daemon runs.

## 5. Testing Strategy

### 5.1 Unit Tests

Update `packages/daemon/src/__tests__/handler.test.ts`:

1. **Success case:** Mock `execFile` to resolve with `{ stdout: '...', stderr: '' }`. Verify handler resolves without error.
2. **Failure case:** Mock `execFile` to reject with an error containing `{ stdout, stderr, code }`. Verify handler resolves without error (doesn't throw).
3. **Logging verification:** Optionally verify logger calls contain expected fields.

**Mocking approach:** Use `vi.mock('node:child_process')` to mock `execFile`.

### 5.2 Manual E2E Verification

1. Start RabbitMQ and API via `docker-compose up`
2. Start the daemon
3. Submit a task: `curl -X POST http://localhost:3000/tasks -H 'Content-Type: application/json' -d '{"task_type":"generic","payload":"What is 2+2?"}'`
4. Observe daemon logs — should show Claude Code spawning and its response

## 6. Security Considerations

- **No shell injection:** `execFile` does not invoke a shell, so payload contents cannot execute arbitrary commands.
- **Resource usage:** No timeout means a malicious or pathological prompt could cause Claude Code to run indefinitely. This is accepted per requirements but should be revisited if the system processes untrusted input.

## 7. Files Changed

| File | Change |
|------|--------|
| `packages/daemon/src/handler.ts` | Replace placeholder with `execFile` subprocess logic |
| `packages/daemon/src/__tests__/handler.test.ts` | Update tests for subprocess behavior |
