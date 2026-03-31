# Design: Lark Reaction Cleanup on Task Completion

**Date:** 2026-03-31
**Status:** Draft

## Problem

When the lark-listener daemon receives a Lark message and submits a task, it adds an "OnIt" emoji reaction to the original message. When the task completes and the lark-result daemon sends a thread reply with the result, the "OnIt" reaction is never removed. This leaves a stale visual indicator on messages whose tasks have already completed.

As more reaction types may be added in the future (e.g. progress indicators), the cleanup mechanism should be generic — removing all bot reactions rather than targeting a specific emoji.

## Goal

After the lark-result daemon successfully replies in-thread to the original Lark message, remove all reactions that the bot has placed on that message. The cleanup should be:

1. **Generic** — remove all reactions on the message, not just "OnIt"
2. **Best-effort** — failures are logged and swallowed; leftover reactions are cosmetic
3. **Only for Lark-sourced tasks** — cleanup only applies when `task_source.source === 'lark'`

## Design

### Approach: Private method on LarkNotifier

Add a `removeAllReactions(messageId: string, token: string)` private method to the existing `LarkNotifier` class. This method is called after the thread reply succeeds, using the same tenant access token already fetched for the notification.

### Lark API Endpoints

**List reactions on a message:**
```
GET https://open.larksuite.com/open-apis/im/v1/messages/{message_id}/reactions?user_id_type=open_id
Authorization: Bearer {tenant_access_token}
```

Response shape (relevant fields only):
```json
{
  "code": 0,
  "data": {
    "items": [
      { "reaction_id": "...", "reaction_type": { "emoji_type": "OnIt" } }
    ]
  }
}
```

**Delete a reaction:**
```
DELETE https://open.larksuite.com/open-apis/im/v1/messages/{message_id}/reactions/{reaction_id}
Authorization: Bearer {tenant_access_token}
```

### Reaction Removal Strategy

Instead of identifying which reactions belong to the bot (which would require fetching the bot's open_id and filtering), we attempt to delete **every** reaction on the message. Reactions not owned by the bot will fail with a permission error, which we log and ignore.

This approach is simpler and more robust:
- No need to fetch bot identity or manage an extra API call at startup
- No filtering logic to maintain
- Permission errors on non-bot reactions are harmless and expected
- Automatically handles any emoji type the bot may have added

A code comment will explain this reasoning at the call site.

### Flow

```
LarkNotifier.sendNotification(result)
  │
  ├── 1. Fetch tenant access token
  ├── 2. Build message text
  ├── 3. Send thread reply (if task_source.source === 'lark')
  │       └── If reply succeeds:
  │           └── 4. removeAllReactions(messageId, token)
  │                   ├── GET reactions list (single page)
  │                   ├── For each reaction (sequentially):
  │                   │   └── DELETE reaction_id (log warning on failure)
  │                   └── Return (best-effort, errors swallowed)
  └── (DM fallback path — no reaction cleanup)
```

### Changes to LarkNotifier

**New constants:**
```typescript
const LARK_REACTIONS_URL = (messageId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reactions?user_id_type=open_id`;
const LARK_DELETE_REACTION_URL = (messageId: string, reactionId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`;
```

**New private method:**
```typescript
private async removeAllReactions(messageId: string, token: string): Promise<void>
```

**Modified sendNotification flow:**
After the thread reply succeeds (response code === 0), call `removeAllReactions()` within a try/catch that logs and swallows errors.

### Type Assertions

The reaction list response will use inline type assertions at the call site:
```typescript
as { code: number; data?: { items?: { reaction_id: string }[] } }
```

No new interfaces in shared types — this is a best-effort internal operation.

### Pagination

Only the first page of reactions is fetched. Messages are unlikely to accumulate enough reactions to require pagination. The single-page approach keeps the implementation simple.

### Error Handling

| Scenario | Behavior |
|----------|----------|
| Reaction list API fails | Log warning, skip cleanup |
| Reaction list returns non-zero code | Log warning, skip cleanup |
| Reaction list returns empty items | No-op, return |
| Individual reaction DELETE fails | Log warning, continue to next |
| Individual reaction DELETE returns non-zero code | Log warning (expected for non-bot reactions), continue |
| Network error during DELETE | Log warning, continue to next |

### No Constructor Changes

The `LarkNotifier` constructor signature remains unchanged: `(appId, appSecret, recipientId)`. No new parameters, no new dependencies. The reaction cleanup method receives the token as a parameter from `sendNotification`.

### Test Plan

Add unit tests to `lark-notifier.test.ts` with mocked `fetch`:

1. **Reactions removed after successful thread reply** — verify GET reactions + DELETE calls happen after reply
2. **No cleanup on DM fallback** — verify no reaction API calls when task_source is absent
3. **Empty reaction list** — verify no DELETE calls when items is empty
4. **Reaction list API failure** — verify cleanup is skipped, notification still succeeds
5. **Individual DELETE failure** — verify remaining deletions still attempted

## Files Changed

| File | Change |
|------|--------|
| `packages/daemon/lark-result/src/adapters/lark-notifier.ts` | Add `removeAllReactions()` method, call after thread reply, add URL constants |
| `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts` | Add test cases for reaction cleanup |

## Out of Scope

- Token caching/optimization in LarkNotifier
- Adding a "DONE" reaction after cleanup
- Reaction cleanup in the DM fallback path
- Pagination for reaction list
- Shared reaction utility between lark-listener and lark-result
