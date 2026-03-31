# Design: Task Source Tracking & Lark Thread Reply

**Date:** 2026-03-31
**Status:** Draft

## Problem

When a Lark message triggers a task through the lark-listener daemon, the result is sent as a new DM to a fixed recipient. The user has no way to see the result in-context — it doesn't appear as a thread reply under the original message. The original Lark `message_id` is used only for dedup and emoji reactions, then discarded.

## Goal

Thread the originating source context (Lark `message_id`) through the entire pipeline so the lark-result daemon can reply in-thread to the original message. If source context is not available, fall back to the existing DM behavior.

## Design

### TaskSource Type

Define a discriminated union in `packages/shared/src/types.ts`:

```typescript
export interface LarkTaskSource {
  source: 'lark';
  message_id: string;
}

// Extend with other sources in the future:
// export interface TelegramTaskSource { source: 'telegram'; chat_id: string; message_id: number; }

export type TaskSource = LarkTaskSource;

export function isValidTaskSource(value: unknown): value is TaskSource {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.source === 'lark') {
    return typeof obj.message_id === 'string' && obj.message_id.length > 0;
  }
  return false;
}
```

### Pipeline Field Addition

Add `task_source?: TaskSource` as an optional field to every type in the pipeline chain:

| Type | Package | Current Fields | Addition |
|------|---------|----------------|----------|
| `TaskSubmission` | shared | `task_type, payload` | `+ task_source?: TaskSource` |
| `Task` | shared | `task_id, task_type, payload, submitted_at` | `+ task_source?: TaskSource` |
| `JobSubmission` | shared | `task_id, task_type, payload, executors, submitted_at, marketplaces?` | `+ task_source?: TaskSource` |
| `Job` | shared | `job_id, task_id, task_type, payload, executors, submitted_at, enriched_at, marketplaces?` | `+ task_source?: TaskSource` |
| `TaskResultSubmission` | shared | `job_id, task_id, status, exit_code, stdout, stderr` | `+ task_source?: TaskSource` |
| `TaskResult` | shared | extends TaskResultSubmission + `result_id, completed_at` | (inherits from TaskResultSubmission) |

This follows the same pattern as `marketplaces?` — optional, passed through at each layer.

### Layer-by-Layer Changes

#### 1. lark-listener: MessageHandler

The `MessageHandler.handle()` method currently calls `this.submitter.submit(payload)`. It will be updated to also pass `task_source`:

```typescript
const taskSource: TaskSource = { source: 'lark', message_id: message.message_id };
const taskId = await this.submitter.submit(payload, taskSource);
```

#### 2. lark-listener: TaskSubmitter

The `submit()` method currently builds `{ task_type: 'generic', payload }`. It will accept an optional `taskSource` parameter and include it in the submission:

```typescript
async submit(payload: string, taskSource?: TaskSource): Promise<string | null> {
  const body: TaskSubmission = { task_type: 'generic', payload, ...(taskSource ? { task_source: taskSource } : {}) };
  // ... rest unchanged
}
```

#### 3. API: POST /tasks

The tasks route currently extracts `{ task_type, payload }` from `req.body`. It will additionally extract `task_source` and validate it if present:

```typescript
const { task_type, payload, task_source } = req.body;
// ... existing validation ...
if (task_source !== undefined && !isValidTaskSource(task_source)) {
  res.status(400).json({ error: 'task_source must be a valid source object' });
  return;
}
const task: Task = {
  task_id: uuidv4(), task_type, payload, submitted_at: new Date().toISOString(),
  ...(task_source ? { task_source } : {}),
};
```

#### 4. task-enrichment: EnrichmentService

The `enrich()` method currently copies `task_id, task_type, payload, submitted_at, marketplaces` from Task to JobSubmission. It will also pass through `task_source`:

```typescript
return {
  task_id: task.task_id,
  task_type: task.task_type,
  payload: task.payload,
  executors,
  submitted_at: task.submitted_at,
  marketplaces: rule.marketplaces,
  ...(task.task_source ? { task_source: task.task_source } : {}),
};
```

#### 5. API: POST /jobs

Same pattern as POST /tasks — extract, validate if present, include in Job object.

#### 6. task daemon: TaskPoller

The `pollOnce()` method receives a `TaskResultSubmission` from `orchestrator.handle(job)`. Before POSTing to `/results`, it attaches `task_source` from the job (the orchestrator and executors are unaware of `task_source`):

```typescript
// After orchestrator.handle(job) returns result:
const resultWithSource: TaskResultSubmission = {
  ...result,
  ...(job.task_source ? { task_source: job.task_source } : {}),
};
```

#### 7. API: POST /results

Same pattern — extract, validate if present, include in TaskResult object.

#### 8. lark-result: LarkNotifier

The `notify()` method receives a `TaskResult`. It will check for `task_source`:

- If `result.task_source?.source === 'lark'`: use the Lark reply API (`POST /im/v1/messages/:message_id/reply`) with `reply_in_thread=true` to reply in-thread to the original message.
- Otherwise: use the existing DM send behavior (unchanged).

The reply-in-thread API call:

```
POST https://open.larksuite.com/open-apis/im/v1/messages/{message_id}/reply
Authorization: Bearer {tenant_access_token}
Content-Type: application/json

{
  "msg_type": "text",
  "content": "{\"text\":\"...\"}",
  "reply_in_thread": true
}
```

A new private method `replyInThread(messageId, text, token)` will be added to `LarkNotifier`. The existing `sendNotification()` becomes the fallback path.

### Reply Format

Plain text, same format as the current DM notification:

```
Job {job_id} (Task {task_id}) — {status}
Exit code: {exit_code}
Output:
{stdout snippet, max 2000 chars}
```

### Fallback Behavior

If `task_source` is not present on the result (e.g., task was submitted from a non-Lark source, or from an older version of lark-listener), the lark-result daemon falls back to the existing DM behavior — sending to the fixed `recipientId`.

### Validation Strategy

API routes validate `task_source` shape at boundaries using `isValidTaskSource()`. The validator checks:
- `source === 'lark'` → `message_id` must be a non-empty string
- Unknown source values → rejected with 400

This ensures malformed source data is caught early rather than silently propagated.

## Files Changed

| File | Change |
|------|--------|
| `packages/shared/src/types.ts` | Add `TaskSource` types, `isValidTaskSource`, add field to all pipeline interfaces |
| `packages/daemon/lark-listener/src/message-handler.ts` | Build and pass `task_source` to submitter |
| `packages/daemon/lark-listener/src/adapters/task-submitter.ts` | Accept and forward `task_source` |
| `packages/api/src/routes/tasks.ts` | Extract, validate, include `task_source` |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Pass through `task_source` |
| `packages/api/src/routes/jobs.ts` | Extract, validate, include `task_source` |
| `packages/daemon/task/src/task-poller.ts` | Forward `task_source` from job to result |
| `packages/api/src/routes/results.ts` | Extract, validate, include `task_source` |
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Add `replyInThread()`, branch on `task_source` |

### Test Files

| File | Change |
|------|--------|
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Verify `task_source` is passed to submitter |
| `packages/daemon/lark-listener/src/__tests__/task-submitter.test.ts` | Verify `task_source` included in POST body |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-service.test.ts` | Verify pass-through |
| `packages/api/src/__tests__/routes/tasks.test.ts` | Validate acceptance/rejection of task_source |
| `packages/api/src/__tests__/routes/jobs.test.ts` | Validate acceptance/rejection of task_source |
| `packages/daemon/task/src/__tests__/task-poller.test.ts` | Verify `task_source` forwarded from job to result submission |
| `packages/api/src/__tests__/routes/results.test.ts` | Validate acceptance/rejection of task_source |
| `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts` | Test thread reply vs DM fallback |

## Non-Goals

- Changing the reply message format (stays plain text)
- Adding chat_id tracking (message_id is sufficient for thread replies)
- Adding source-based enrichment rules
- Supporting non-Lark sources in this iteration (type system supports it, but no implementation)
