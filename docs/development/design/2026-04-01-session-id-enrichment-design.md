# Design: Session ID for Enriched Jobs

**Date:** 2026-04-01
**Status:** Draft
**Depends on:** Thread Context Enrichment (implemented), Task Type Thread Inheritance (implemented)

## Problem

Tasks processed by the LocalAgent pipeline have no session-level identity. Each task is independent — there is no way to group related tasks (e.g., follow-up messages in the same Lark thread) or to support future execution continuity (resuming state from a prior task in the same session).

## Goal

Add a `session_id` (UUID v7) to the enriched job that flows through the full pipeline (`Job` → `TaskResult`). When a task originates from a Lark thread that already has a session, it inherits that session_id. Otherwise, a new session_id is generated. This supports both **grouping/traceability** and future **execution continuity**.

## Approach

Mirror the existing `task_type` inheritance pattern:

1. **Generate**: Create a UUID v7 `session_id` in the enrichment poller for every task.
2. **Inherit**: If the task is from a Lark thread, extract `session_id` from bot reply text (same pattern as `task_type`). If found, use it instead of generating a new one.
3. **Propagate**: Carry `session_id` through the full pipeline: `JobSubmission` → `Job` → `JobAttempt` → `TaskResultSubmission` → `TaskResult`.
4. **Tag**: Include `session_id: <value>` in Lark bot reply text so future tasks in the thread can inherit it.
5. **Strip**: Remove `session_id` lines from thread context before prepending to payload.

### Why mirror task_type?

- Proven pattern, already implemented and tested
- No new infrastructure required (no database, no cache)
- Visible in bot replies for transparency and debugging
- Consistent mental model for developers

## Design

### 1. UUID v7 Generation

Add the `uuidv7` npm package as a dependency of `@local-agent/shared`.

```bash
cd packages/shared && npm install uuidv7
```

Export a `generateSessionId()` utility from the shared package:

```typescript
// packages/shared/src/session.ts
import { uuidv7 } from 'uuidv7';

export function generateSessionId(): string {
  return uuidv7();
}
```

Re-export from `packages/shared/src/index.ts`.

### 2. Type Changes

Add `session_id` to all pipeline types in `packages/shared/src/types.ts`:

```typescript
export interface JobSubmission {
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  session_id: string;            // NEW
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}

export interface Job {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executors: ExecutorPreference[];
  submitted_at: string;
  enriched_at: string;
  session_id: string;            // NEW
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
  task_source?: TaskSource;
  setup_hook?: string;
  setup_hook_timeout_ms?: number;
}

export interface JobAttempt {
  job_id: string;
  task_id: string;
  task_type: string;
  payload: string;
  executor: TaskExecutorType;
  executor_model: string;
  submitted_at: string;
  enriched_at: string;
  session_id: string;            // NEW
  system_prompt?: string;
  marketplaces?: MarketplaceConfig[];
}

export interface TaskResultSubmission {
  job_id: string;
  task_id: string;
  task_type: string;
  session_id?: string;           // NEW (optional — rejection results have no session)
  status: ResultStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  task_source?: TaskSource;
}

export interface TaskResult extends TaskResultSubmission {
  result_id: string;
  completed_at: string;
}
```

`session_id` is **required** (not optional) on `JobSubmission`, `Job`, and `JobAttempt` — every enriched job always has a session_id.

On `TaskResultSubmission` and `TaskResult`, `session_id` is **optional** (`session_id?: string`). This is because the enrichment poller's `publishRejection()` path creates a `TaskResultSubmission` directly (without going through enrichment), so it has no session_id. Downstream consumers (e.g., `LarkNotifier`) must handle a missing `session_id` by omitting the tag line from the bot reply.

### 3. Tag Format in Bot Replies

**File:** `packages/daemon/lark-result/src/adapters/lark-notifier.ts`

Add `session_id: <value>` as a line in the bot reply text, alongside the existing `task_type` line. Only include the line when `session_id` is present (rejection results may lack one):

```typescript
const lines = [
  `Task ID: ${result.task_id}`,
  `Job ID: ${result.job_id}`,
  `task_type: ${result.task_type}`,
  ...(result.session_id ? [`session_id: ${result.session_id}`] : []),  // NEW
  `status: ${result.status}`,
  `Exit code: ${result.exit_code ?? 'N/A'}`,
  result.stdout ? `Output:\n${result.stdout}` : 'No output',
];
const text = lines.join('\n');
```

**Parsing regex:** `^session_id: ([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$` (multiline)

This regex validates UUID v7 format specifically (version nibble = 7, variant bits = 8/9/a/b).

**Stripping regex:** `^session_id: [0-9a-f-]+\n?` (multiline, applied per-message in thread context)

### 4. Session ID Extraction — ThreadContextFetcher

**File:** `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts`

Add `inheritedSessionId` to `ThreadContextResult`:

```typescript
export interface ThreadContextResult {
  threadContext: string | null;
  inheritedTaskType: string | null;
  inheritedSessionId: string | null;   // NEW
}
```

**Extraction logic** (in `doFetch()`, after existing task_type extraction):

```typescript
// Extract session_id from first bot message that has one
let inheritedSessionId: string | null = null;
for (const m of messages) {
  if (m.sender.sender_type === 'user') continue;
  const content = extractLarkMessageContent(m.msg_type, m.body.content);
  const match = content.match(SESSION_ID_REGEX);
  if (match) {
    inheritedSessionId = match[1];
    break;
  }
}
```

No validation against a "valid set" is needed (unlike task_type) — any well-formed UUID v7 is valid.

**Stripping:** Add `SESSION_ID_LINE_REGEX` alongside `TASK_TYPE_LINE_REGEX` and apply it when formatting thread context:

```typescript
const SESSION_ID_REGEX = /^session_id: ([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/m;
const SESSION_ID_LINE_REGEX = /^session_id: [0-9a-f-]+\n?/m;
```

### 5. Session ID Assignment — EnrichmentPoller

**File:** `packages/daemon/task-enrichment/src/enrichment-poller.ts`

After thread context fetching and before enrichment, assign session_id:

```typescript
import { generateSessionId } from '@local-agent/shared';

// ... inside pollOnce(), after thread context block ...

// Determine session_id: inherit from thread or generate new
let sessionId: string;
if (threadResult?.inheritedSessionId) {
  sessionId = threadResult.inheritedSessionId;
  logger.info({ task_id: task.task_id, inherited_session_id: sessionId }, 'Inherited session_id from thread');
} else {
  sessionId = generateSessionId();
  logger.info({ task_id: task.task_id, new_session_id: sessionId }, 'Generated new session_id');
}

// Then pass sessionId to enrich():
const enrichmentResult = this.enrichmentService.enrich(task, sessionId);
```

Note: Unlike `task_type` inheritance (which only overrides when task_type is `'generic'`), `session_id` **always** inherits from thread when available — there is no "explicit session_id" concept at task submission time.

### 6. EnrichmentService Changes

**File:** `packages/daemon/task-enrichment/src/enrichment-service.ts`

The `enrich()` method needs to accept `session_id` and include it in the `JobSubmission`. Two options:

**Option chosen:** Pass `session_id` as a second parameter to `enrich()`:

```typescript
enrich(task: Task, sessionId: string): EnrichmentResult {
  // ... existing logic ...
  return {
    type: 'enriched',
    job: {
      // ... existing fields ...
      session_id: sessionId,     // NEW
    },
  };
}
```

This keeps `session_id` out of the `Task` type (since it's generated during enrichment, not at submission).

### 7. Task Poller — Propagation to Results

**File:** `packages/daemon/task/src/task-poller.ts`

The task poller already attaches `task_type` and `task_source` from the job to the result. Add `session_id`:

```typescript
const resultWithSource: TaskResultSubmission = {
  ...result,
  task_type: job.task_type,
  session_id: job.session_id,     // NEW
  ...(job.task_source ? { task_source: job.task_source } : {}),
};
```

### 8. API Routes — Passthrough

**File:** `packages/api/src/routes/results.ts`

The POST `/results` route must extract `session_id` from the request body and include it in the published `TaskResult`. `session_id` is **optional** on results (rejection results from the enrichment poller have no session):

```typescript
const { job_id, task_id, status, exit_code, stdout, stderr, task_source, task_type, session_id } = req.body;

// ... existing validation ...

if (session_id !== undefined && typeof session_id !== 'string') {
  res.status(400).json({ error: 'session_id must be a string if provided' });
  return;
}

const result: TaskResult = {
  // ... existing fields ...
  ...(typeof session_id === 'string' ? { session_id } : {}),  // NEW
};
```

**File:** `packages/api/src/routes/jobs.ts`

The POST `/jobs` route must extract `session_id` from the request body, validate it as a required string, and include it in the published `Job`:

```typescript
const { task_id, task_type, payload, executors, submitted_at, system_prompt, marketplaces, task_source, setup_hook, setup_hook_timeout_ms, session_id } = req.body;

// ... existing validation ...

if (typeof session_id !== 'string' || !session_id) {
  res.status(400).json({ error: 'session_id is required and must be a string' });
  return;
}

const job: Job = {
  // ... existing fields ...
  session_id,          // NEW
};
```

## Data Flow

```
[User sends message in Lark thread]
         |
         v
[lark-listener] --> POST /tasks { task_type: 'generic', task_source: { source: 'lark', message_id: 'om_reply' } }
         |
         v
[enrichment-poller]
  1. Fetch thread messages via Lark API
  2. Extract task_type from first valid bot message (existing)
  3. Extract session_id from first bot message with session_id tag --> e.g., '019..."
  4. If session_id found, inherit it; otherwise generate new UUID v7
  5. Strip session_id lines from thread context
  6. Prepend cleaned context to payload
  7. Call enrich(task, sessionId) --> JobSubmission includes session_id
         |
         v
[task-daemon]
  1. Receives Job with session_id
  2. Executes task
  3. Attaches session_id to TaskResultSubmission
         |
         v
[lark-result daemon]
  1. Receives TaskResult with session_id
  2. Replies in Lark: "task_type: deploy\nsession_id: 019...\nJob ... -- success\n..."
```

### Standalone (non-thread) task:
```
[User sends standalone Lark message]
         |
         v
[enrichment-poller]
  1. No thread found (getThreadId returns null)
  2. No inherited session_id
  3. Generate new UUID v7
  4. Call enrich(task, sessionId)
```

## Files Changed

| File | Change |
|------|--------|
| `packages/shared/package.json` | Add `uuidv7` dependency |
| `packages/shared/src/session.ts` | New file: `generateSessionId()` utility |
| `packages/shared/src/index.ts` | Re-export `generateSessionId` |
| `packages/shared/src/types.ts` | Add `session_id: string` to `JobSubmission`, `Job`, `JobAttempt`; add `session_id?: string` to `TaskResultSubmission` |
| `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | Add `inheritedSessionId` to `ThreadContextResult`, add extraction regex, strip session_id lines |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Assign session_id (inherit or generate), pass to `enrich()` |
| `packages/daemon/task-enrichment/src/enrichment-service.ts` | Add `sessionId` parameter to `enrich()`, include in `JobSubmission` |
| `packages/daemon/task/src/task-poller.ts` | Attach `session_id` from job to result |
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Add `session_id:` line to bot reply text |
| `packages/api/src/routes/results.ts` | Extract and validate `session_id` from request body |
| `packages/api/src/routes/jobs.ts` | Pass `session_id` through when creating job |

## Test Plan

1. **Unit: `generateSessionId()`** — verify returns valid UUID v7 format
2. **Unit: `ThreadContextFetcher` session_id extraction** — verify extraction from bot messages, missing tags, malformed UUIDs
3. **Unit: `ThreadContextFetcher` session_id stripping** — verify session_id lines are removed from thread context
4. **Unit: `EnrichmentService.enrich()` with session_id** — verify session_id is included in JobSubmission
5. **Unit: `EnrichmentPoller` session_id assignment** — verify inheritance when available, generation when not
6. **Unit: `TaskPoller`** — verify session_id is attached to result
7. **Unit: `LarkNotifier`** — verify `session_id:` line is included in reply text

## Edge Cases

- **Thread predates feature:** No bot message has a `session_id:` tag -> generate new session_id (thread gets a fresh session starting from this task)
- **Malformed session_id in tag:** Regex doesn't match -> skip, generate new session_id
- **Non-Lark tasks (CLI):** No `task_source` -> no thread lookup, always generate new session_id
- **Root message (not a reply):** `getThreadId()` returns null -> no inheritance, generate new
- **Thread context fetch fails (retries exhausted):** Generate new session_id anyway (every task must have one)
- **Multiple bot messages with different session_ids:** First one wins (chronological order, consistent with task_type behavior)
