# Result Reporting and Lark Notification Design

**Date:** 2026-03-27
**Type:** Feature addition
**Packages:** `@local-agent/shared`, `@local-agent/api`, `@local-agent/daemon`

## 1. Context

After a task executor (Claude Code or TTADK) finishes, the result is only logged by the daemon — there is no way to report it back to the user or route it to downstream consumers. The daemon currently has a single role: poll for tasks, execute them, and ACK.

Current state:

- `packages/daemon/src/poller.ts` polls `GET /tasks/next`, calls `orchestrator.handle(task)`, then ACKs via `POST /tasks/:id/ack`.
- Executors (`ClaudeCliExecutor`, `TTADKExecutor`) log stdout/stderr/exit_code but do not return or store results.
- `packages/api/src/services/rabbitmq.ts` uses a single `tasks` queue with `sendToQueue` (no exchanges).
- No result persistence, no result queue, no notification integration exists.

The requested feature introduces a two-exchange architecture: results are published to a `results` fanout exchange after task completion, and a new lark-daemon consumes from a `lark-messages` queue bound to that exchange to send Lark Bot API notifications.

## 2. Goal

Enable task result reporting by:
1. Capturing executor output (stdout, stderr, exit code) and publishing it as a result message to a `results` fanout exchange via the API.
2. Creating a lark-daemon that polls for result messages from a `lark-messages` queue and sends notifications to a hardcoded Lark user via the Lark Bot API.
3. Renaming the current daemon entry point to "task-daemon" for clarity.

## 3. Non-goals

- No result persistence/storage beyond the RabbitMQ queue.
- No UI or API to query historical results.
- No retry queue or dead-letter queue for failed Lark notifications (just retry in-process up to 3 times, then ACK and log).
- No support for multiple Lark recipients (single hardcoded user).
- No changes to task submission, validation, or executor routing.
- No changes to the CLI package.

## 4. User Decisions Captured

- **Result data:** Full stdout + stderr + exit code captured from executors, truncated to 100KB max.
- **Result message content:** Minimal — `task_id` + result data (status, stdout, stderr, exit_code). No full task context.
- **Queue topology:** A `results` fanout exchange with a `lark-messages` queue bound to it. API sets up all topology on startup.
- **Result publishing:** Task-daemon POSTs result to a new `POST /results` API endpoint. API publishes to the `results` fanout exchange.
- **Result consumption:** Lark-daemon polls `GET /results/next/:queueName` from the API. ACKs via `POST /results/:queueName/:id/ack`.
- **Lark API:** Lark Bot API (app_id + app_secret) to send direct messages to a specific user.
- **Lark credentials:** `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_RECIPIENT_ID` env vars.
- **Lark notification content:** Task ID + status + first 2000 chars of output.
- **Lark failure handling:** Retry up to 3 times in-process, then ACK and log the failure. Best-effort notification.
- **Daemon packaging:** Lark-daemon lives in the same `@local-agent/daemon` package as a separate entry point.
- **Daemon renaming:** Rename everything — entry points, scripts, Docker references, file names — from "daemon" to "task-daemon". Add "lark-daemon" as a new entry point.

## 5. Approaches Considered

### Approach A — Result via separate API endpoint (recommended)

Task-daemon captures executor output, POSTs to `POST /results`. API publishes to `results` fanout exchange. Lark-daemon polls `GET /results/next/:queueName` and ACKs via `POST /results/:queueName/:id/ack`.

**Pros**
- Consistent with existing architecture (all RabbitMQ access through API).
- API is single source of truth for RabbitMQ topology.
- Fanout exchange enables future consumers with zero changes to publishing side.
- Clean separation: task-daemon produces results, lark-daemon consumes them.

**Cons**
- Two HTTP round-trips per task (ACK + result POST).
- API becomes a thicker layer.

### Approach B — Piggyback results on existing ACK flow

Extend `POST /tasks/:id/ack` to accept result data in the body. API publishes result to exchange during ACK.

**Pros**
- One fewer HTTP call per task.
- Result and ACK are atomic.

**Cons**
- Muddies ACK endpoint responsibility.
- If result publishing fails, unclear whether task should still be ACKed.
- Harder to reason about failure modes.

### Approach C — Daemon-to-RabbitMQ direct publishing

Task-daemon gets its own RabbitMQ connection and publishes results directly to the exchange. Lark-daemon also connects directly.

**Pros**
- No API involvement for results. Lower latency.

**Cons**
- Breaks the established pattern where only the API touches RabbitMQ.
- Topology management spread across services.
- Each daemon needs RabbitMQ connection config.

## 6. Recommended Design

Adopt **Approach A**.

### 6.1 New types in `@local-agent/shared`

Add a `TaskResultSubmission` interface (what executors produce and the daemon POSTs to the API) and a `TaskResult` interface (what the API returns after adding generated fields):

```ts
export interface TaskResultSubmission {
  task_id: string;          // References the original task
  status: 'success' | 'failure';
  exit_code: number | null; // null if process couldn't start
  stdout: string;           // Truncated to MAX_RESULT_OUTPUT_BYTES
  stderr: string;           // Truncated to MAX_RESULT_OUTPUT_BYTES
}

export interface TaskResult extends TaskResultSubmission {
  result_id: string;        // UUID — generated by API
  completed_at: string;     // ISO timestamp — generated by API
}
```

This mirrors the existing `TaskSubmission` / `Task` pattern.

Add a constant:

```ts
export const MAX_RESULT_OUTPUT_BYTES = 100 * 1024; // 100KB
```

### 6.2 Executor changes — return results

Update the `TaskExecutor` port interface to return a `TaskResultSubmission`:

```ts
export interface TaskExecutor {
  execute(task: Task): Promise<TaskResultSubmission>;
}
```

Both `ClaudeCliExecutor` and `TTADKExecutor` change from logging-and-returning-void to constructing and returning a `TaskResultSubmission`. They still log, but the result data is now captured. Note: executors populate all fields except `result_id` and `completed_at`, which the API generates (see Section 6.4).

On empty payload (early return path — currently returns void):
```ts
return {
  task_id: task.task_id,
  status: 'failure',
  exit_code: null,
  stdout: '',
  stderr: 'Task payload is missing or empty',
};
```

On success:
```ts
// ClaudeCliExecutor.execute(task) — simplified
return {
  task_id: task.task_id,
  status: 'success',
  exit_code: 0,
  stdout: truncate(stdout, MAX_RESULT_OUTPUT_BYTES),
  stderr: truncate(stderr, MAX_RESULT_OUTPUT_BYTES),
};
```

On error:
```ts
return {
  task_id: task.task_id,
  status: 'failure',
  exit_code: typeof execErr.code === 'number' ? execErr.code : null,
  stdout: truncate(execErr.stdout ?? '', MAX_RESULT_OUTPUT_BYTES),
  stderr: truncate(execErr.stderr ?? '', MAX_RESULT_OUTPUT_BYTES),
};
```

A `truncate(str: string, maxBytes: number): string` utility will be added to `@local-agent/shared`.

### 6.3 RabbitMQ topology changes

The `RabbitMQService` constructor currently takes `(url, queueName)`. The constructor signature does not change — the tasks queue name remains configurable. The results exchange and lark-messages queue names are imported from shared constants (`DEFAULT_RESULTS_EXCHANGE_NAME`, `DEFAULT_LARK_QUEUE_NAME`) and asserted alongside the existing tasks queue during `connect()`. This keeps the topology centralized in one place.

Changes:

1. **On `connect()`:** After the existing `assertQueue(this.queueName)`, also assert the `results` fanout exchange and the `lark-messages` queue, then bind the queue to the exchange.

```ts
await ch.assertExchange('results', 'fanout', { durable: true });
await ch.assertQueue('lark-messages', { durable: true });
await ch.bindQueue('lark-messages', 'results', '');
```

2. **New method `publishToExchange(exchange: string, message: TaskResult): boolean`:**

```ts
publishToExchange(exchange: string, message: TaskResult): boolean {
  if (!this.channel) throw new Error('Not connected');
  const buffer = Buffer.from(JSON.stringify(message));
  return this.channel.publish(exchange, '', buffer, { persistent: true });
}
```

3. **New method `getNextFromQueue(queueName: string): Promise<TaskResult | null>`:**

Same logic as `getNext()` but parameterized by queue name. Uses `result_id` as the delivery map key. Requires a separate delivery map (e.g., `resultDeliveryMap`) or a map-of-maps keyed by queue name.

4. **New method `ackFromQueue(queueName: string, resultId: string): boolean`:**

Same pattern as `ack()` but using the queue-specific delivery map.

### 6.4 API route changes

Add a new `results` router (`packages/api/src/routes/results.ts`):

**`POST /results`** — Accepts a `TaskResultSubmission` body, validates required fields, generates `result_id` and `completed_at`, publishes the full `TaskResult` to the `results` exchange.

```
Request:  { task_id, status, exit_code, stdout, stderr }
Response: 201 { result_id, task_id, status, exit_code, stdout, stderr, completed_at }
          400 if validation fails
          503 if backpressured
```

The API generates `result_id` and `completed_at` (similar to how `POST /tasks` generates `task_id` and `submitted_at`).

**`GET /results/next/:queueName`** — Reads next message from the specified queue.

```
Response: 200 { TaskResult }
          204 if empty
```

**`POST /results/:queueName/:id/ack`** — Acknowledges a result message.

```
Response: 200 { acknowledged: true }
          404 if not found
```

### 6.5 Task-daemon (renamed poller)

The current `Poller` class adds a result-publishing step after execution:

```ts
// After orchestrator.handle(task) returns TaskResultSubmission:
const result = await this.orchestrator.handle(task);

// Publish result to API
try {
  const resultRes = await fetch(`${this.apiUrl}/results`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  });
  if (resultRes.status !== 201) {
    logger.warn({ task_id: task.task_id, status: resultRes.status }, 'Result publish failed');
  }
} catch (resultErr) {
  logger.error({ task_id: task.task_id, err: resultErr }, 'Result publish request failed');
}

// Then ACK the task (existing logic)
```

`TaskOrchestrator.handle()` changes return type from `Promise<void>` to `Promise<TaskResultSubmission>`.

### 6.6 Lark-daemon — new entry point

New file: `packages/daemon/src/lark-daemon.ts` (entry point).
New file: `packages/daemon/src/lark-poller.ts` (polling loop for results).
New file: `packages/daemon/src/adapters/lark-notifier.ts` (Lark Bot API client).

**Lark Poller:** Same pattern as the task Poller but polls `GET /results/next/lark-messages`, processes the result, and ACKs via `POST /results/lark-messages/:id/ack`.

**Lark Notifier:** Sends a message to the configured Lark user via the Lark Bot API:

1. Get tenant access token: `POST https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal` with `app_id` and `app_secret`.
2. Send message: `POST https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id` with the recipient ID and message content.

Message content is a text card with:
- Task ID
- Status (success/failure)
- First 2000 chars of stdout

**Retry logic:** On Lark API failure, retry up to 3 times with a brief delay. After 3 failures, log the error and proceed (ACK the result anyway).

**Config:** New `LarkDaemonConfig` in shared:

```ts
export interface LarkDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  larkAppId: string;
  larkAppSecret: string;
  larkRecipientId: string;
}
```

Loaded from env vars: `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_RECIPIENT_ID`.

### 6.7 Daemon renaming

| Current | Renamed |
|---------|---------|
| `packages/daemon/src/index.ts` | `packages/daemon/src/task-daemon.ts` |
| `packages/daemon/src/poller.ts` | `packages/daemon/src/task-poller.ts` |
| Logger name `daemon:poller` | `task-daemon:poller` |
| Logger name `daemon:orchestrator` | `task-daemon:orchestrator` |
| Logger name `daemon:claude-cli` | `task-daemon:claude-cli` |
| Logger name `daemon:ttadk` | `task-daemon:ttadk` |
| `package.json` `"main"` / `"start"` script | Points to `task-daemon.ts` |
| Docker references | Updated to new entry point |

New entry point `packages/daemon/src/lark-daemon.ts` added with its own start script.

## 7. File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/types.ts` | Modify | Add `TaskResultSubmission` and `TaskResult` interfaces, `MAX_RESULT_OUTPUT_BYTES` constant |
| `packages/shared/src/index.ts` | Modify | Re-export new types |
| `packages/shared/src/config.ts` | Modify | Add `LarkDaemonConfig` interface and `loadLarkDaemonConfig()` |
| `packages/shared/src/constants.ts` | Modify | Add `DEFAULT_RESULTS_EXCHANGE_NAME`, `DEFAULT_LARK_QUEUE_NAME`, `DEFAULT_LARK_MAX_RETRIES` |
| `packages/shared/src/truncate.ts` | Create | `truncate(str, maxBytes)` utility |
| `packages/api/src/services/rabbitmq.ts` | Modify | Add exchange assertion, `publishToExchange()`, `getNextFromQueue()`, `ackFromQueue()` |
| `packages/api/src/routes/results.ts` | Create | `POST /results`, `GET /results/next/:queueName`, `POST /results/:queueName/:id/ack` |
| `packages/api/src/app.ts` | Modify | Mount results router |
| `packages/daemon/src/ports/task-executor.ts` | Modify | Change return type to `Promise<TaskResultSubmission>` |
| `packages/daemon/src/adapters/claude-cli-executor.ts` | Modify | Return `TaskResultSubmission` instead of void |
| `packages/daemon/src/adapters/ttadk-executor.ts` | Modify | Return `TaskResultSubmission` instead of void |
| `packages/daemon/src/core/task-orchestrator.ts` | Modify | Return `TaskResultSubmission` from `handle()` |
| `packages/daemon/src/poller.ts` → `task-poller.ts` | Rename + Modify | Rename file, add result POST step after execution |
| `packages/daemon/src/index.ts` → `task-daemon.ts` | Rename + Modify | Rename entry point |
| `packages/daemon/src/lark-daemon.ts` | Create | Lark daemon entry point |
| `packages/daemon/src/lark-poller.ts` | Create | Polling loop for result queue |
| `packages/daemon/src/adapters/lark-notifier.ts` | Create | Lark Bot API client with retry logic |
| `packages/daemon/package.json` | Modify | Update scripts, add lark-daemon entry |
| Tests (multiple files) | Modify/Create | See section 8 |

## 8. Test Strategy

### Shared
- `TaskResultSubmission` and `TaskResult` types validate expected shapes.
- `truncate()` correctly truncates strings exceeding maxBytes; leaves shorter strings unchanged; handles empty strings.
- `loadLarkDaemonConfig()` loads from env vars with defaults.

### API — Results routes
- `POST /results` with valid body returns 201 with generated `result_id` and `completed_at`.
- `POST /results` with missing `task_id` returns 400.
- `POST /results` with missing `status` returns 400.
- `POST /results` returns 503 when exchange publish returns false (backpressure).
- `GET /results/next/lark-messages` returns 200 with result when available, 204 when empty.
- `POST /results/lark-messages/:id/ack` returns 200 on success, 404 when not found.

### API — RabbitMQ service
- `connect()` asserts `results` fanout exchange and `lark-messages` queue with binding.
- `publishToExchange()` publishes persistent message to named exchange.
- `getNextFromQueue()` reads from specified queue and tracks delivery.
- `ackFromQueue()` acknowledges by result_id for specified queue.

### Daemon — Executors
- `ClaudeCliExecutor.execute()` returns `TaskResultSubmission` with `status: 'success'` on success.
- `ClaudeCliExecutor.execute()` returns `TaskResultSubmission` with `status: 'failure'` on subprocess error.
- `TTADKExecutor.execute()` same pattern.
- Both executors truncate stdout/stderr to `MAX_RESULT_OUTPUT_BYTES`.
- Empty payload returns `TaskResultSubmission` with `status: 'failure'` and stderr indicating missing payload.

### Daemon — Task-poller
- After `orchestrator.handle()`, POSTs result to `/results`.
- On result POST failure, logs warning and proceeds to ACK.
- ACK still happens even if result POST fails.

### Daemon — Lark-poller
- Polls `GET /results/next/lark-messages` and processes results.
- ACKs via `POST /results/lark-messages/:id/ack` after notification.
- Continues polling on empty queue (204).

### Daemon — Lark notifier
- Sends message to Lark Bot API with correct format.
- Retries up to 3 times on API failure.
- After 3 failures, resolves without throwing (best-effort).
- Message content includes task_id, status, and first 2000 chars of stdout.

## 9. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Result POST fails and result is lost | Best-effort: result is still in daemon logs. Result publishing failure doesn't block task ACK. |
| Lark access token expires mid-operation | Token is fetched per notification (or cached with short TTL). Retry logic handles transient auth failures. |
| Large stdout truncation loses important info | 100KB captured in result message; full output in daemon logs. 2000 chars in Lark notification is sufficient for a status overview. |
| Fanout exchange with single consumer is over-engineered | Marginal cost now, significant benefit when adding future consumers (e.g., Slack, email, webhook). |
| Daemon rename breaks existing deployments | Coordinate rename with deployment config updates. Old entry point removed, not aliased. |
| Duplicate result on task redelivery | If result POST succeeds but task ACK fails, RabbitMQ redelivers the task, causing a duplicate result and notification. Acceptable for best-effort notifications — Lark messages are idempotent from the user's perspective (receiving a duplicate notification is harmless). |
| RabbitMQ topology changes on API restart | `assertExchange` and `assertQueue` are idempotent — safe to call on every startup. |

## 10. Acceptance Criteria

1. `TaskResultSubmission` and `TaskResult` types defined in `@local-agent/shared`. `TaskResult` extends `TaskResultSubmission` with API-generated `result_id` and `completed_at`.
2. Executors return `TaskResultSubmission` with stdout/stderr truncated to 100KB.
3. `POST /results` endpoint publishes to `results` fanout exchange.
4. `GET /results/next/:queueName` and `POST /results/:queueName/:id/ack` endpoints work for any queue bound to the exchange.
5. API sets up `results` exchange, `lark-messages` queue, and binding on startup.
6. Task-daemon (renamed from daemon) POSTs result to API after each task execution.
7. Lark-daemon polls `lark-messages` queue and sends Lark Bot API notifications.
8. Lark notification includes task_id, status, first 2000 chars of output.
9. Lark notifier retries up to 3 times, then ACKs and logs on failure.
10. All daemon files, scripts, and logger names renamed from "daemon" to "task-daemon".
11. Tests cover all new and modified functionality.
