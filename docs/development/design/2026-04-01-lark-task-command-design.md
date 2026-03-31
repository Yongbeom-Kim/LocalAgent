# Design: Lark `/task` Command

**Date:** 2026-04-01
**Status:** Draft

## Problem

All Lark messages to the bot are currently submitted as `task_type: 'generic'`. There is no way for users to specify a task type from Lark, which means enrichment rules (different executors, models, system prompts) cannot be leveraged from the Lark interface.

## Goal

Allow Lark users to submit tasks with specific types via a `/task <type> <payload>` command syntax, enabling routing through type-specific enrichment rules. Unknown types are rejected by the enrichment daemon with a helpful error message routed back to the user via the existing result pipeline.

## Requirements

1. **Command syntax:** `/task <type> <rest of message is payload>` — payload preserves multiline and rich content (images, files, code blocks).
2. **Coexistence:** Plain messages (no `/task` prefix) continue to work as `task_type: 'generic'`.
3. **Type validation:** Only types defined in enrichment YAML config are accepted. Unknown types are rejected with an error listing valid types.
4. **Validation location:** Enrichment daemon validates; lark-listener only parses and forwards.
5. **Error feedback:** Enrichment publishes a failed `TaskResultSubmission` when rejecting an unknown type. `lark-result-daemon` delivers the error message in-thread to the user.
6. **Local edge case:** Bare `/task` (no arguments) is handled locally in lark-listener with a usage hint reply — not submitted to the pipeline.
7. **Emoji reaction:** Same `OnIt` reaction behavior as today for valid commands. No reaction for bare `/task`.
8. **Config:** `generic` must be explicitly defined in enrichment YAML (no implicit default fallback). A comment documents it as the default type for plain messages.

## Design

### Architecture

The change spans three components, following the existing async pipeline:

```
Lark Message
    │
    ▼
┌─────────────────────┐
│   lark-listener      │  Parse /task prefix → extract type + payload
│   MessageHandler     │  Bare /task → reply with usage hint (local)
│                      │  No /task → type='generic', full message as payload
│   TaskSubmitter      │  Accept task_type param (not hardcoded 'generic')
└─────────┬───────────┘
          │ POST /tasks { task_type, payload, task_source }
          ▼
┌─────────────────────┐
│   task-enrichment    │  Look up rule by task_type
│   EnrichmentService  │  No match → publish failed TaskResultSubmission
│   EnrichmentPoller   │     with error message + list of valid types
│                      │  Match → enrich and publish JobSubmission (unchanged)
└─────────┬───────────┘
          │ POST /results (on rejection) or POST /jobs (on success)
          ▼
┌─────────────────────┐
│   lark-result        │  Picks up failed result
│   LarkNotifier       │  Replies in-thread with error message
└─────────────────────┘
```

### Component Changes

#### 1. lark-listener — `MessageHandler`

Add command parsing logic to the `handle` method:

```
handle(event):
  payload = buildPayload(message_type, content)

  if payload starts with "/task":
    rest = payload after "/task "
    if rest is empty:
      reply with "Usage: /task <type> <payload>"
      return  // don't submit, don't react

    taskType = first word of rest
    taskPayload = rest after first word (may be empty string)
    submit(taskType, taskPayload, taskSource)
  else:
    submit('generic', payload, taskSource)  // existing behavior

  react(message_id)
```

The `MessageHandler` needs a new dependency: a `LarkReplier` adapter to send reply messages for the usage hint. This could be a method on the existing `LarkReactor` or a new small adapter.

#### 2. lark-listener — `TaskSubmitter`

Change `submit()` signature to accept `task_type`:

```typescript
async submit(taskType: string, payload: string, taskSource?: TaskSource): Promise<string | null>
```

Instead of hardcoding `task_type: 'generic'`, use the provided `taskType` parameter.

#### 3. task-enrichment — `EnrichmentService`

Current behavior: falls back to `rules['default']` when type is not found.

New behavior:
- Remove the `default` fallback (`?? this.rules['default']`).
- When no matching rule exists, return a rejection object instead of `null`.
- Add a method to list valid task types (rule keys).

```typescript
enrich(task: Task): EnrichmentResult {
  const rule = this.rules[task.task_type];

  if (!rule) {
    return {
      type: 'rejected',
      reason: `Unknown task type "${task.task_type}". Available types: ${this.getValidTypes().join(', ')}`,
    };
  }

  // ... existing enrichment logic, return { type: 'enriched', job: JobSubmission }
}

getValidTypes(): string[] {
  return Object.keys(this.rules);
}
```

#### 4. task-enrichment — `EnrichmentPoller`

When enrichment returns a rejection, publish a failed `TaskResultSubmission` to the results API:

```typescript
if (enrichmentResult.type === 'rejected') {
  await this.publishRejection(task, enrichmentResult.reason);
  await this.ackTask(task.task_id);
  return;
}
```

The `publishRejection` method creates and POSTs a `TaskResultSubmission`:
- `job_id`: use the `task_id` value (no job was created, but `job_id` is required and `task_id` is unique)
- `task_id`: from the task
- `status`: `'failure'`
- `exit_code`: `null`
- `stdout`: the rejection reason message
- `stderr`: `''`
- `task_source`: from the task (so lark-result-daemon can reply in-thread)

#### 5. lark-listener — `LarkReplier` adapter

A new adapter (or extension of `LarkReactor`) that can send a text reply to a message:

```typescript
class LarkReplier {
  async reply(messageId: string, text: string): Promise<void>
}
```

Uses the Lark reply API (`/im/v1/messages/{messageId}/reply`) with `reply_in_thread: true`. The same token-fetching logic as `LarkReactor`.

#### 6. Enrichment YAML config

Replace `default` with explicit `generic` rule:

```yaml
rules:
  # Default type for plain messages (no /task prefix)
  generic:
    executors:
      - executor: claude_code
        executor_model: sonnet
```

### Types

A new discriminated union for enrichment results:

```typescript
type EnrichmentResult =
  | { type: 'enriched'; job: JobSubmission }
  | { type: 'rejected'; reason: string };
```

The `TaskResultSubmission` type already supports the fields needed for rejection results. No changes to shared types are needed. For `job_id` (required, but no job exists), use the `task_id` value — it is unique and avoids introducing a sentinel convention.

### Edge Cases

| Scenario | Behavior |
|---|---|
| `/task` (bare, no args) | Reply with usage hint locally. No task submitted. No emoji. |
| `/task review` (type but no payload) | Submit with `task_type='review'`, `payload=''`. Enrichment decides if this is valid. |
| `/task review fix\nthe bug` (multiline) | `task_type='review'`, `payload='fix\nthe bug'` — multiline preserved. |
| `/task REVIEW fix` (uppercase) | `task_type='REVIEW'` — case-sensitive. Must match YAML key exactly. |
| `/task unknowntype hello` | Submitted, enrichment rejects, error result flows back: "Unknown task type \"unknowntype\". Available types: generic, review, ..." |
| Plain message "hello" | `task_type='generic'`, `payload='hello'` — unchanged behavior. |
| Rich content (image in /task message) | Rich content passed through as structured payload (existing `buildPayload` logic). `/task` prefix detected from text portion. |

### What This Design Does NOT Do

- No changes to the API routes or shared types.
- No task type validation at the API layer.
- No Lark Task (飞书任务) integration — this is purely about routing through the enrichment pipeline.
- No auto-complete or suggestions in Lark (Lark bot API doesn't support slash command registration for custom bots).

## Testing Strategy

1. **Unit tests for command parsing:** Test `MessageHandler` with various `/task` inputs (valid, bare, multiline, no-prefix).
2. **Unit tests for enrichment rejection:** Test `EnrichmentService.enrich()` returns rejection for unknown types and lists valid types.
3. **Integration test for rejection flow:** Verify `EnrichmentPoller` publishes a `TaskResultSubmission` with failure status when type is unknown.
4. **Existing tests:** Verify plain message flow (no `/task` prefix) is unchanged.
