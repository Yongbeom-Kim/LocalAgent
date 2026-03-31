# Design: Thread Context Enrichment via Lark API

**Date:** 2026-03-31
**Status:** Draft
**Depends on:** Task Source Thread Reply (implemented — `task_source` already flows through the pipeline)

## Problem

When a user replies in a Lark thread (e.g., a follow-up to a bot response), the lark-listener daemon captures only the latest message. The task executor (Claude Code / TTADK) has no knowledge of the prior conversation — it processes the reply in isolation, losing context about what was discussed or requested earlier.

## Goal

During the enrichment phase, detect when a task originates from a Lark thread reply, fetch the full thread history via the Lark Open API, and prepend it to the task payload. This gives the executor conversational context so it can produce a coherent follow-up response.

## Scenario

1. User sends message to bot → bot processes it, replies in-thread with result
2. User replies in the same thread → lark-listener picks up the new message with `task_source: { source: 'lark', message_id: 'om_new_msg' }`
3. Enrichment daemon receives task, sees `task_source.source === 'lark'`
4. Calls Lark API to check if `om_new_msg` is in a thread (has `root_id`)
5. If yes, fetches all thread messages, formats as chat-like context, prepends to payload
6. Enriched payload flows to executor with full conversation history

## Design

### ThreadContextFetcher

A new class in the task-enrichment daemon, separate from `EnrichmentService`. It encapsulates all Lark API interaction for thread context loading.

```typescript
// packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts

export class ThreadContextFetcher {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  /**
   * Given a Lark message_id, fetches thread context if the message is a thread reply.
   * Returns formatted thread context string, or null if not in a thread or on failure.
   */
  async fetchThreadContext(messageId: string): Promise<string | null>;
}
```

### Lark API Flow

#### Step 1: Get Tenant Access Token

Same pattern used by `LarkReactor` and `LarkNotifier`:

```
POST https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal
Body: { app_id, app_secret }
Response: { tenant_access_token, code }
```

#### Step 2: Check if Message is in a Thread

```
GET https://open.larksuite.com/open-apis/im/v1/messages/{message_id}
Authorization: Bearer {tenant_access_token}
Response: {
  data: {
    items: [{
      message_id: string,
      root_id?: string,       // present if message is in a thread
      parent_id?: string,     // present if message is a reply
      sender: { sender_type: string, ... },
      msg_type: string,
      body: { content: string },
      ...
    }]
  }
}
```

If `root_id` is absent or equals `message_id` (the message is the thread root), return `null` — no thread context to fetch.

#### Step 3: Fetch Thread Messages

```
GET https://open.larksuite.com/open-apis/im/v1/messages?container_id_type=thread&container_id={root_id}&sort_type=ByCreateTimeAsc
Authorization: Bearer {tenant_access_token}
Response: {
  data: {
    items: Array<{
      message_id: string,
      sender: { sender_type: string, ... },
      msg_type: string,
      body: { content: string },
      create_time: string,
    }>,
    page_token?: string,
    has_more?: boolean,
  }
}
```

Pagination: If `has_more` is true, continue fetching with `page_token` until all messages are retrieved. No limit on message count.

#### Step 4: Format Thread Context

Extract a human-readable string from each message based on `msg_type`:

- `text` → extract `.text` from JSON content (same as `MessageHandler.extractText()`)
- `image` → `[Image: {image_key}]`
- `file` → `[File: {file_name}]`
- `audio` → `[Audio message]`
- `post` → concatenate all `text`-tagged elements from the nested `content` array (rich text paragraphs contain arrays of `[{ tag: 'text', text: '...' }, ...]`)
- Other → `[{msg_type} message]`

Note: `MessageHandler.buildPayload()` currently returns JSON objects for non-text types (e.g., `{ type: 'image', key: ... }`). The shared `extractLarkMessageContent` utility produces a **string** representation instead, suitable for chat-like context. After the refactor, `MessageHandler` will call `extractLarkMessageContent` for `text` messages and keep its existing JSON-object behavior for non-text types (its structured payloads are consumed by executors, not used as context).

Label messages by `sender_type`:
- `sender_type === 'user'` → `user: {content}`
- Any other sender_type (e.g., `app`) → `assistant: {content}`

Exclude the current message (the one that triggered this task) from the thread context — it's already the task payload.

### Payload Format

The enriched payload prepends thread context to the original payload:

```
--- Thread Context ---
user: fix the CI pipeline
assistant: Job abc-123 (Task def-456) — success
Exit code: 0
Output:
The CI pipeline issue was in the build step...
--- Current Message ---
now also fix the tests
```

If no thread context is available (not a thread reply, or API failure), the payload is unchanged.

### Integration Point

The `EnrichmentPoller.pollOnce()` method is updated to call `ThreadContextFetcher` between receiving the task and passing it to `EnrichmentService.enrich()`:

```typescript
// In EnrichmentPoller.pollOnce():
const task = (await res.json()) as Task;

// NEW: Enrich payload with thread context if applicable
if (this.threadContextFetcher && task.task_source?.source === 'lark') {
  const threadContext = await this.threadContextFetcher.fetchThreadContext(task.task_source.message_id);
  if (threadContext) {
    task.payload = `--- Thread Context ---\n${threadContext}\n--- Current Message ---\n${task.payload}`;
  }
}

const jobSubmission = this.enrichmentService.enrich(task);
```

The `EnrichmentPoller` constructor accepts an optional `ThreadContextFetcher`:

```typescript
constructor(
  private readonly apiUrl: string,
  private readonly enrichmentService: EnrichmentService,
  private readonly threadContextFetcher?: ThreadContextFetcher,
)
```

### Configuration

Add optional Lark credentials to `EnrichmentDaemonConfig`:

```typescript
export interface EnrichmentDaemonConfig {
  apiUrl: string;
  pollIntervalMs: number;
  logLevel: string;
  enrichmentConfigPath: string;
  larkAppId?: string;       // NEW
  larkAppSecret?: string;   // NEW
}
```

Read from existing env vars (`LARK_APP_ID`, `LARK_APP_SECRET`). If either is missing, `ThreadContextFetcher` is not created and thread context enrichment is disabled (graceful degradation).

### Retry & Error Handling

`ThreadContextFetcher.fetchThreadContext()` retries Lark API calls up to 3 times with exponential backoff (1s, 2s, 4s), matching the existing `TaskSubmitter` retry pattern.

On final failure:
- Log the error at `warn` level
- Return `null` (no thread context)
- Enrichment proceeds normally with the original payload

This is **best-effort** — a failed thread context fetch should never block task processing.

### Content Extraction

Thread messages need a human-readable string representation (as described in Step 4 above). To avoid duplicating the text-extraction logic already in `MessageHandler.extractText()`, a shared utility function will be extracted:

```typescript
// packages/shared/src/lark-content.ts

export function extractLarkMessageContent(msgType: string, content: string): string;
```

This function takes a Lark message type and content JSON string, and returns a human-readable text representation. `ThreadContextFetcher` uses it for all message types. `MessageHandler` uses it only for `text` messages (via `extractText` refactor); non-text messages retain their existing JSON-object format for executor consumption.

## Files Changed

| File | Change |
|------|--------|
| `packages/shared/src/lark-content.ts` | **NEW** — Shared Lark message content extraction utility |
| `packages/shared/src/index.ts` | Export `extractLarkMessageContent` |
| `packages/daemon/task-enrichment/src/adapters/thread-context-fetcher.ts` | **NEW** — `ThreadContextFetcher` class |
| `packages/daemon/task-enrichment/src/enrichment-poller.ts` | Accept optional `ThreadContextFetcher`, call it before enrichment |
| `packages/daemon/task-enrichment/src/config.ts` | Add `larkAppId`, `larkAppSecret` to config |
| `packages/daemon/task-enrichment/src/index.ts` | Create `ThreadContextFetcher` if Lark credentials are available, pass to `EnrichmentPoller` |
| `packages/daemon/lark-listener/src/message-handler.ts` | Refactor `extractText()` to use shared `extractLarkMessageContent` for `text` type; non-text types keep existing JSON-object behavior |

### Test Files

| File | Change |
|------|--------|
| `packages/shared/src/__tests__/lark-content.test.ts` | **NEW** — Tests for content extraction |
| `packages/daemon/task-enrichment/src/__tests__/thread-context-fetcher.test.ts` | **NEW** — Tests for thread context fetching |
| `packages/daemon/task-enrichment/src/__tests__/enrichment-poller.test.ts` | Test thread context integration in `pollOnce()` |
| `packages/daemon/lark-listener/src/__tests__/message-handler.test.ts` | Verify refactored extraction still works |

## Non-Goals

- Caching thread context between requests (each enrichment fetches fresh)
- Downloading image/file/audio content from threads (only references/keys are included)
- Thread context for non-Lark sources (type system supports it, but no implementation)
- Limiting thread message count (fetch all messages)
- Tracking the bot's reply message_id back into the pipeline
