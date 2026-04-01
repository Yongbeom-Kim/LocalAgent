# `/new` Command — New Instance in Same Session — Design Specification

**Date:** 2026-04-01
**Status:** Draft

## 1. Overview

Add a `/new` command that creates a fresh Claude Code instance within the same Lark thread and session. The command clears conversational context (thread history) while preserving the session workspace on disk. This allows users to start a clean coding tool instance without losing their workspace files.

### 1.1 Goals

- Users can type `/new` in a Lark thread to reset the Claude Code conversation context
- Same session_id and workspace directory are preserved
- Thread history is truncated at the `/new` boundary (context fence)
- The command goes through the full task pipeline (submit → enrich → execute → result)
- The bot reply contains standard `session_id:` and `task_type:` markers for thread inheritance
- Subsequent messages after `/new` resume `--continue` behavior against the new Claude Code session

### 1.2 Non-Goals

- Creating a new session_id or workspace
- Accepting a payload (e.g., `/new do something`) — bare `/new` only
- Resetting the thread's inherited task_type — it persists across `/new`
- Canceling in-flight jobs — they complete normally

## 2. Architecture

### 2.1 Command Flow

```
User types "/new" in a Lark thread
        │
        ▼
┌─────────────────────┐
│  lark-listener       │
│  MessageHandler      │
│  parseCommand()      │ → task_type: 'new_instance', payload: ''
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  API POST /tasks     │
│  TaskSubmission      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  enrichment-daemon   │
│  EnrichmentPoller    │
│                      │
│  1. Fetch thread ctx │ → Extract inheritedSessionId, inheritedTaskType
│  2. Validate:        │ → Require existing session (reject if none)
│     - Must be in     │ → Require thread context
│       a thread       │
│  3. Enrich via YAML  │ → new_instance rule: claude_code executor
│  4. Set skipContinue │ → true on JobSubmission
│  5. No thread history│ → history field omitted
│  6. Minimal payload  │ → "Respond with: New session instance started."
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  task-daemon         │
│  TaskOrchestrator    │
│                      │
│  1. Setup workspace  │ → Reuses existing workspace (isExistingWorkspace: true)
│  2. Check skipCont.  │ → Skip --continue, spawn fresh Claude Code
│  3. Execute          │ → Claude outputs "New session instance started."
│  4. Post result      │ → Standard result with session_id marker
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  lark-result-daemon  │
│  Bot replies with:   │
│  "New session        │
│   instance started." │
│  session_id: <value> │
│  task_type: <value>  │
└─────────────────────┘
```

### 2.2 Context Fence Mechanism

After `/new`, the `ThreadContextFetcher` truncates thread history at the last `/new` boundary:

```
Thread messages (chronological):
  [user msg 1]           ─┐
  [bot reply 1]           │  EXCLUDED (before fence)
  [user msg 2]            │
  [bot reply 2]           │
  [user: /new]            │
  [bot: New instance...] ─┘  ← Fence point (last /new bot-reply)
  [user msg 3]           ─┐
  [bot reply 3]           │  INCLUDED (after fence)
  [user msg 4] (current)  │
```

The fence detection works by:
1. Fetching all thread messages (existing behavior)
2. Scanning for the last `/new` user command message
3. Finding the bot reply immediately after it
4. Truncating: only messages at and after the bot reply position are included as thread context
5. The `/new` bot-reply itself IS included (gives Claude awareness that a reset occurred)

### 2.3 `--continue` Behavior

The existing `--continue` mechanism in `ClaudeCliExecutor` and `TTADKExecutor`:

```
Normal message in existing workspace:
  1. Try --continue (resume existing Claude Code session)
  2. If --continue fails → fall back to fresh session with thread history

/new execution:
  1. Skip --continue entirely (skipContinue: true on Job)
  2. Spawn fresh Claude Code instance
  3. This naturally rotates the Claude Code session file

First message AFTER /new:
  1. Try --continue → attaches to the NEW session created by /new
  2. If --continue fails → fresh session (normal fallback)
```

## 3. Detailed Design

### 3.1 Command Parsing — `MessageHandler`

Add `/new` as a reserved command in `parseCommand()`, alongside `/gc` and `/end`:

```typescript
// In parseCommand():
if (payload === '/new') {
  return { taskType: 'new_instance', taskPayload: '', isCommand: true };
}

// Reject /new with trailing content
if (payload.startsWith('/new ') || payload.startsWith('/new\n')) {
  return { taskType: null, taskPayload: '', isCommand: true };
}
```

When `/new` has trailing content, it returns `{ taskType: null, isCommand: true }` which triggers the existing usage hint reply.

### 3.2 Shared Types — `skipContinue` Field

Add an optional `skipContinue` field to `JobSubmission` and `Job`:

```typescript
export interface JobSubmission {
  // ... existing fields ...
  skipContinue?: boolean;
}

export interface Job {
  // ... existing fields ...
  skipContinue?: boolean;
}
```

The field propagates through the pipeline: `JobSubmission` → API → RabbitMQ → `Job` → `TaskOrchestrator` → `JobAttempt` → Executor.

`JobAttempt` also needs the field:

```typescript
export interface JobAttempt {
  // ... existing fields ...
  skipContinue?: boolean;
}
```

### 3.3 YAML Configuration

Add a `new_instance` rule to the enrichment YAML config:

```yaml
# Appended to config/builtin.yaml alongside the existing cleanup rule
rules:
  cleanup:
    executors:
      - executor: builtin
        executor_model: none
  new_instance:
    executors:
      - executor: claude_code
        executor_model: sonnet
```

The `new_instance` type uses `claude_code` as executor with `sonnet` model. No system_prompt, no marketplaces, no setup_hook — minimal execution.

### 3.4 Enrichment Poller — `new_instance` Handling

Add handling for `new_instance` in `EnrichmentPoller.pollOnce()`, similar to `cleanup`:

```
Validation:
  1. Must have lark task_source (same as cleanup)
  2. Must be in a thread (threadResult must exist)
  3. Must have inheritedSessionId (reject if no existing session)

Enrichment:
  1. Inherit session_id from thread
  2. Inherit task_type from thread (task_type lock persists)
  3. Override `task.payload` with the minimal prompt BEFORE calling `enrichmentService.enrich()`
     (EnrichmentService copies `task.payload` into the JobSubmission)
  4. Call `enrichmentService.enrich(task, sessionId)` with NO history argument
     (uses the `new_instance` YAML rule → claude_code/sonnet executor, no system_prompt overrides)
  5. After enrichment returns, set `skipContinue: true` on the resulting JobSubmission

Note: `new_instance` must be excluded from the task_type mismatch check in the
poller, alongside `cleanup` and `gc`. Otherwise the poller rejects it because
`task_type: 'new_instance'` does not match the thread's inherited task_type.
```

Constants to add:
```typescript
const NEW_INSTANCE_TASK_TYPE = 'new_instance';
const NEW_INSTANCE_PROMPT = 'Respond with: New session instance started.';
const NEW_INSTANCE_MISSING_SOURCE_REASON = 'The /new command requires a Lark task source.';
const NEW_INSTANCE_MISSING_THREAD_REASON = 'The /new command can only be used inside a thread.';
const NEW_INSTANCE_MISSING_SESSION_REASON = 'No active session in this thread to reset.';
```

### 3.5 Thread Context Fetcher — Fence Logic

Modify `ThreadContextFetcher.doFetch()` to detect `/new` fence boundaries:

```
After fetching all messages and extracting inheritedTaskType/inheritedSessionId:

1. Scan messages for the last /new user command:
   - Iterate messages in reverse
   - Find last user message where `extractLarkMessageContent(msg_type, body.content)` equals exactly `"/new"`

2. If found, locate the bot reply immediately after it:
   - Find the next message in chronological order where sender_type !== 'user'
   - This is the fence point

3. Truncate: filter messages to only include those at/after the fence bot-reply position

4. Continue with normal formatting (role: content pairs, strip markers)
```

The fence detection uses the `/new` user message to find the boundary, and the bot-reply position as the actual truncation point. The bot-reply is included in the context so Claude is aware a reset occurred.

### 3.6 Executor Changes — `skipContinue` Support

Modify `ClaudeCliExecutor.execute()` and `TTADKExecutor.execute()`:

```typescript
// Current logic:
if (env.isExistingWorkspace) {
  const continueResult = await this.spawnClaude(job, env, { mode: 'continue', input: job.payload });
  if (continueResult.status === 'success') return continueResult;
  // fall back to fresh...
}

// New logic:
if (env.isExistingWorkspace && !job.skipContinue) {
  const continueResult = await this.spawnClaude(job, env, { mode: 'continue', input: job.payload });
  if (continueResult.status === 'success') return continueResult;
  // fall back to fresh...
}
```

Single-line change: add `&& !job.skipContinue` to the existing conditional.

### 3.7 Task Orchestrator — `skipContinue` Propagation

When building `JobAttempt` from `Job` in `TaskOrchestrator.handle()`, propagate `skipContinue`:

```typescript
const attempt: JobAttempt = {
  // ... existing fields ...
  skipContinue: job.skipContinue,
};
```

## 4. Edge Cases

### 4.1 `/new` in Thread Without Existing Session

**Behavior:** Rejected with error message: "No active session in this thread to reset."
**Reason:** `/new` is only meaningful when there's an existing session to create a new instance within.

### 4.2 Multiple `/new` Commands in Same Thread

**Behavior:** Each `/new` creates a new fence. Only messages after the **last** `/new` bot-reply are included as thread context for subsequent messages.
**Reason:** Each `/new` represents a fresh context boundary. The most recent one takes precedence.

### 4.3 `/new` With Trailing Content

**Behavior:** Rejected locally by lark-listener with usage hint, same as bare `/task`.
**Reason:** `/new` does not accept a payload. Users send their first message separately after `/new`.

### 4.4 `/new` While Job Is In-Flight

**Behavior:** The in-flight job completes normally. `/new` is queued and processed sequentially.
**Reason:** The task queue is sequential — jobs are processed one at a time.

### 4.5 Out-of-Order Bot Replies

**Scenario:** An in-flight job's bot reply lands AFTER the `/new` bot reply due to timing.
**Behavior:** Accepted as a rare edge case. The fence is based on the `/new` bot-reply's position in the thread. If an old reply appears after the fence, it will be included in context. User can send `/new` again to reset.
**Mitigation:** Document as known limitation.

### 4.6 `/new` Execution Failure

**Behavior:** Follows standard executor failure handling (single attempt via the configured executor preference). If execution fails, an error result is posted to the thread. No fence is created since there's no successful bot-reply.

### 4.7 `/new` as Base Message (Not in Thread)

**Behavior:** Rejected with error: "The /new command can only be used inside a thread."
**Reason:** `/new` requires an existing thread with a session to reset context for.

## 5. API Changes

No new API endpoints. The existing `POST /tasks`, `POST /jobs`, and `POST /results` endpoints handle the `new_instance` task type through normal pipeline flow.

The `POST /jobs` endpoint must accept the new optional `skipContinue` boolean field on `JobSubmission`.

## 6. Data Model Changes

### 6.1 Shared Types (`packages/shared/src/types.ts`)

| Interface | Field | Type | Description |
|-----------|-------|------|-------------|
| `JobSubmission` | `skipContinue` | `boolean?` | When true, executor skips `--continue` |
| `Job` | `skipContinue` | `boolean?` | Propagated from JobSubmission |
| `JobAttempt` | `skipContinue` | `boolean?` | Propagated from Job |

### 6.2 Enrichment Config

New YAML rule for `new_instance` task type with `claude_code` executor and `sonnet` model.

## 7. Testing Strategy

Follow existing test patterns (Vitest, `src/__tests__/*.test.ts`, comprehensive mocking).

### 7.1 Unit Tests

| Component | Test Cases |
|-----------|------------|
| `MessageHandler.parseCommand()` | `/new` → `{ taskType: 'new_instance', taskPayload: '', isCommand: true }`; `/new foo` → rejected; `/newfoo` → not a command |
| `EnrichmentPoller` | `new_instance` with valid thread/session → enriched job with `skipContinue: true`; missing thread → rejected; missing session → rejected; missing lark source → rejected |
| `EnrichmentService` | `new_instance` YAML rule loads correctly; enriches with correct executor |
| `ThreadContextFetcher` | Fence detection with single `/new`; multiple `/new` (last wins); no `/new` (no truncation); `/new` bot-reply included in context |
| `ClaudeCliExecutor` | `skipContinue: true` → skips `--continue` attempt; `skipContinue: false/undefined` → existing behavior preserved |
| `TTADKExecutor` | Same as ClaudeCliExecutor tests |
| `EnrichmentPoller` (task_type) | `new_instance` excluded from task_type mismatch check (not rejected when thread has different inherited task_type) |
| `TaskOrchestrator` | `skipContinue` propagation to `JobAttempt` |

### 7.2 Manual Testing

- Send `/new` in a Lark thread with an active session → verify bot reply with markers
- Send a follow-up message after `/new` → verify context only includes post-fence messages
- Send `/new` as a base message → verify rejection
- Send `/new` in thread without session → verify rejection
- Send multiple `/new` commands → verify only last fence applies
