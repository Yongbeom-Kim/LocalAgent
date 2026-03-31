# Design: Task Type Inheritance from Lark Thread Root

**Date:** 2026-04-01
**Status:** Draft
**Depends on:** Thread Context Enrichment (implemented — `ThreadContextFetcher` already fetches thread messages), Task Source Thread Reply (implemented — `task_source` flows through pipeline)

## Problem

When a user replies in a Lark thread, the lark-listener daemon always assigns `task_type: 'generic'` to the new task. Even if the original (root) message was processed with a specific task type (e.g., `'deploy'`, `'review'`), all reply messages lose that context and fall through to the `'default'` enrichment rule.

This means replies in a thread don't benefit from the specialized enrichment configuration (executor selection, system prompts, setup hooks) that was applied to the root message.

## Goal

Make reply messages in a Lark thread automatically inherit the `task_type` of the root message, so the entire thread uses consistent enrichment rules. The inheritance follows the **oldest ancestor** (root), not the nearest parent.

## Approach

Encode the `task_type` as a visible line in the bot's Lark reply text. When the enrichment daemon processes a reply, it extracts the task_type from the first bot message in the thread that contains a valid tag.

### Why text-based tagging?

- No new infrastructure (database, cache) required
- Leverages the existing thread message fetch in `ThreadContextFetcher`
- Visible to users for transparency
- Simple to implement and debug

## Design

### 1. Tag Format

The bot response includes a `task_type` line as the **first line** of the reply text:

```
task_type: generic
Job abc123 (Task def456) — success
Exit code: 0
Output:
...
```

**Parsing regex:** `^task_type: ([a-zA-Z0-9_-]+)$` (multiline flag)

- Matches the tag anywhere in the message (not just first line), for forward-compatibility
- Captured value is constrained to alphanumeric characters, hyphens, and underscores

### 2. Tag Insertion — lark-result daemon

**File:** `packages/daemon/lark-result/src/adapters/lark-notifier.ts`

The `LarkNotifier.sendNotification()` method prepends the `task_type` line to the reply text.

**Prerequisite:** The `TaskResult` type (and `TaskResultSubmission`) must carry `task_type` so the lark-result daemon knows what type to tag.

#### Type changes

Add `task_type` to `TaskResultSubmission` and `TaskResult`:

```typescript
// packages/shared/src/types.ts

export interface TaskResultSubmission {
  job_id: string;
  task_id: string;
  task_type: string;        // ← NEW
  status: ResultStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  task_source?: TaskSource;
}
```

#### task-poller changes

`task-poller.ts` already attaches `task_source` from the job to the result. It will also attach `task_type`:

```typescript
const resultWithSource: TaskResultSubmission = {
  ...result,
  task_type: job.task_type,     // ← NEW
  ...(job.task_source ? { task_source: job.task_source } : {}),
};
```

#### lark-notifier changes

Prepend the `task_type` line to the reply text:

```typescript
const text = [
  `task_type: ${result.task_type}`,   // ← NEW: first line
  `Job ${result.job_id} (Task ${result.task_id}) — ${result.status}`,
  `Exit code: ${result.exit_code ?? 'N/A'}`,
  snippet ? `Output:\n${snippet}` : 'No output',
].join('\n');
```

### 3. Task Type Extraction — enrichment daemon

**File:** `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`

Add a new method to `ThreadContextFetcher` that extracts the task_type from thread messages:

```typescript
extractTaskTypeFromMessages(messages: LarkMessage[], validTaskTypes: Set<string>): string | null
```

**Algorithm:**
1. Iterate through messages in chronological order (already sorted `ByCreateTimeAsc`)
2. For each message where `sender.sender_type !== 'user'` (bot messages):
   - Parse the message content using `extractLarkMessageContent()`
   - Match against regex `^task_type: ([a-zA-Z0-9_-]+)$` (multiline)
   - If match found, check if the captured value exists in `validTaskTypes`
   - If valid, return it
   - If not valid, continue to next message
3. If no valid task_type found in any bot message, return `null`

**`validTaskTypes`** is the set of keys from the loaded enrichment rules (provided by `EnrichmentService`).

### 4. Integration — enrichment-poller

**File:** `packages/daemon/task-enrichment/src/enrichment-poller.ts`

The thread context fetch and task_type extraction happen together, since both operate on the same thread messages. The flow changes to:

```typescript
if (this.threadContextFetcher && task.task_source?.source === 'lark') {
  const validTaskTypes = this.enrichmentService.getValidTaskTypes();
  const result = await this.threadContextFetcher.fetchThreadContext(task.task_source.message_id, validTaskTypes);

  if (result) {
    // Extract and inherit task_type (only if current is 'generic')
    if (task.task_type === 'generic' && result.inheritedTaskType) {
      task.task_type = result.inheritedTaskType;
      logger.info({ task_id: task.task_id, inherited_task_type: result.inheritedTaskType }, 'Inherited task_type from thread root');
    }

    // Strip task_type lines and prepend thread context to payload
    if (result.threadContext) {
      task.payload = `--- Thread Context ---\n${result.threadContext}\n--- Current Message ---\n${task.payload}`;
    }
  }
}
```

### 5. Return Type Change for `fetchThreadContext`

Currently `fetchThreadContext()` returns `string | null` (the formatted thread context). It needs to return both the context string and the extracted task_type.

**New return type:**

```typescript
interface ThreadContextResult {
  threadContext: string | null;
  inheritedTaskType: string | null;
}
```

`fetchThreadContext()` signature changes to:

```typescript
async fetchThreadContext(
  messageId: string,
  validTaskTypes?: Set<string>,
): Promise<ThreadContextResult | null>
```

- Returns `null` when no thread is found (message is not in a thread) — preserves current behavior
- Returns `ThreadContextResult` when a thread is found (fields may individually be `null`)
- When `validTaskTypes` is provided, extraction is attempted
- When not provided (or empty), `inheritedTaskType` is always `null`

### 6. Stripping task_type Lines from Thread Context

Before formatting thread messages into the context string, strip lines matching `^task_type: ([a-zA-Z0-9_-]+)$` from bot message content. This prevents the executor from seeing the metadata tag in its conversation context.

```typescript
function stripTaskTypeLine(content: string): string {
  return content.replace(/^task_type: [a-zA-Z0-9_-]+\n?/m, '');
}
```

### 7. Results Route: Passing `task_type` Through

**File:** `packages/api/src/routes/results.ts`

The POST `/results` route must extract `task_type` from the request body and include it in the `TaskResult` published to RabbitMQ. Without this, the lark-result daemon will not receive `task_type` and cannot tag its reply.

```typescript
const { job_id, task_id, status, exit_code, stdout, stderr, task_source, task_type } = req.body;

// ... existing validation ...

if (task_type !== undefined && typeof task_type !== 'string') {
  res.status(400).json({ error: 'task_type must be a string if provided' });
  return;
}

const result: TaskResult = {
  result_id: uuidv4(),
  job_id,
  task_id,
  status: status as TaskResult['status'],
  exit_code: typeof exit_code === 'number' ? exit_code : null,
  stdout: typeof stdout === 'string' ? stdout : '',
  stderr: typeof stderr === 'string' ? stderr : '',
  completed_at: new Date().toISOString(),
  ...(task_type ? { task_type } : { task_type: 'generic' }),
  ...(task_source ? { task_source } : {}),
};
```

### 8. EnrichmentService: Exposing Valid Task Types

Add a method to `EnrichmentService` to expose the set of valid rule keys:

```typescript
getValidTaskTypes(): Set<string> {
  return new Set(Object.keys(this.rules));
}
```

This set is passed to `ThreadContextFetcher` for validation.

## Data Flow

```
[User replies in Lark thread]
         │
         v
[lark-listener] → POST /tasks { task_type: 'generic', task_source: { source: 'lark', message_id: 'om_reply' } }
         │
         v
[task-enrichment daemon]
  1. Fetch thread messages via Lark API (existing logic)
  2. Extract task_type from first valid bot message → e.g., 'deploy'
  3. If current task_type is 'generic', override to 'deploy'
  4. Strip task_type lines from thread context
  5. Prepend cleaned context to payload
  6. Enrich using 'deploy' rule (not 'default')
         │
         v
[task-daemon] → executes with 'deploy' enrichment config
         │
         v
[lark-result daemon]
  1. Receives result with task_type: 'deploy'
  2. Replies in Lark: "task_type: deploy\nJob ... — success\n..."
```

## Files Changed

| File | Change |
|------|--------|
| `packages/shared/src/types.ts` | Add `task_type` to `TaskResultSubmission` |
| `packages/daemon/task/src/task-poller.ts` | Attach `task_type` from job to result |
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Prepend `task_type:` line to reply text |
| `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Add `extractTaskTypeFromMessages()`, change return type, strip task_type lines |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Use new return type, apply inherited task_type |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Add `getValidTaskTypes()` method |
| `packages/api/src/routes/results.ts` | Extract `task_type` from request body, validate, and include in published `TaskResult` |

## Test Plan

1. **Unit: `extractTaskTypeFromMessages()`** — verify extraction from bot messages with valid/invalid types, missing tags, multiple bot messages
2. **Unit: `stripTaskTypeLine()`** — verify stripping from message content
3. **Unit: `LarkNotifier`** — verify `task_type:` prefix is included in reply text
4. **Unit: `EnrichmentService.getValidTaskTypes()`** — verify returns rule keys
5. **Unit: `enrichment-poller`** — verify task_type override when 'generic', no override otherwise
6. **Unit: `task-poller`** — verify `task_type` is attached to result

## Edge Cases

- **Thread predates feature:** No bot message has a `task_type:` tag → falls back to `'generic'`, no behavior change
- **Invalid task_type in tag:** Regex matches but value not in enrichment rules → skip to next bot message
- **Non-Lark tasks:** No `task_source` or `source !== 'lark'` → no inheritance attempted
- **Root message (not a reply):** `getThreadId()` returns null → no thread context, no inheritance
- **task_type already set (not 'generic'):** No override — explicit types are preserved
