# Lark Reaction Cleanup Implementation Plan

**Goal:** After the lark-result daemon successfully replies in-thread, remove all reactions on the original Lark message so stale "OnIt" indicators are cleaned up.

**Architecture:** Add a private `removeAllReactions(messageId, token)` method to the existing `LarkNotifier` class. After a successful thread reply, it lists all reactions on the message via GET, then sequentially DELETEs each one. Reactions not owned by the bot will fail with a permission error — this is expected and logged as a debug-level warning. No bot identity fetch is needed.

**Tech Stack:** TypeScript, Vitest, Lark Open API (REST)

**Design Doc:** `docs/development/design/2026-03-31-lark-reaction-cleanup-design.md`

---

### Task 1: Add URL constants for reaction APIs

**Files:**
- Modify: `packages/daemon/lark-result/src/adapters/lark-notifier.ts:6-9`

- [ ] **Step 1: Add the new URL helper constants**

In `packages/daemon/lark-result/src/adapters/lark-notifier.ts`, add after the existing `LARK_REPLY_URL` constant (line 9):

```typescript
const LARK_REACTIONS_URL = (messageId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reactions?user_id_type=open_id`;
const LARK_DELETE_REACTION_URL = (messageId: string, reactionId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`;
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd packages/daemon/lark-result && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/lark-result/src/adapters/lark-notifier.ts
git commit -m "feat(lark-result): add Lark reaction API URL constants"
```

---

### Task 2: Write failing tests for reaction cleanup

**Files:**
- Modify: `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`

- [ ] **Step 1: Add test — reactions removed after successful thread reply**

Add to the bottom of the `describe('LarkNotifier', ...)` block in `packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts`:

```typescript
  describe('reaction cleanup', () => {
    it('removes all reactions after successful thread reply', async () => {
      mockFetch
        // 1. Token fetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
        })
        // 2. Thread reply
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        // 3. List reactions
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            code: 0,
            data: {
              items: [
                { reaction_id: 'react-1' },
                { reaction_id: 'react-2' },
              ],
            },
          }),
        })
        // 4. Delete reaction 1
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        // 5. Delete reaction 2
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      await notifier.notify(result);

      expect(mockFetch).toHaveBeenCalledTimes(5);
      // Verify list reactions call
      expect(mockFetch).toHaveBeenNthCalledWith(3,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions?user_id_type=open_id',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer token-abc',
          }),
        }),
      );
      // Verify delete calls
      expect(mockFetch).toHaveBeenNthCalledWith(4,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions/react-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(5,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions/react-2',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('does not attempt reaction cleanup on DM fallback', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      await notifier.notify(createResult()); // no task_source
      expect(mockFetch).toHaveBeenCalledTimes(2); // only token + DM send
    });

    it('skips deletion when reaction list is empty', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0, data: { items: [] } }),
        });

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      await notifier.notify(result);

      expect(mockFetch).toHaveBeenCalledTimes(3); // token + reply + list reactions (no deletes)
    });

    it('continues notification when reaction list API fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        .mockRejectedValueOnce(new Error('Network error'));

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      // Should not throw — reaction cleanup is best-effort
      await expect(notifier.notify(result)).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('continues deleting remaining reactions when one DELETE fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ tenant_access_token: 'token-abc', code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            code: 0,
            data: {
              items: [
                { reaction_id: 'react-1' },
                { reaction_id: 'react-2' },
              ],
            },
          }),
        })
        // Delete react-1 fails
        .mockRejectedValueOnce(new Error('Network error'))
        // Delete react-2 succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ code: 0 }),
        });

      const result = createResult({
        task_source: { source: 'lark', message_id: 'om_msg1' },
      });
      await expect(notifier.notify(result)).resolves.toBeUndefined();

      // Should still attempt to delete react-2 after react-1 fails
      expect(mockFetch).toHaveBeenCalledTimes(5);
      expect(mockFetch).toHaveBeenNthCalledWith(5,
        'https://open.larksuite.com/open-apis/im/v1/messages/om_msg1/reactions/react-2',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts`
Expected: FAIL — `removeAllReactions` method doesn't exist yet; fetch call count assertions will fail (only 2 calls happen: token + reply)

---

### Task 3: Implement removeAllReactions private method

**Files:**
- Modify: `packages/daemon/lark-result/src/adapters/lark-notifier.ts`

- [ ] **Step 1: Add the removeAllReactions method**

Add this private method to the `LarkNotifier` class, after the `sendNotification` method:

```typescript
  /**
   * Remove all reactions on a message. Best-effort — errors are logged and swallowed.
   *
   * We attempt to delete every reaction on the message rather than filtering by
   * bot identity. Reactions not owned by the bot will fail with a permission
   * error from the Lark API, which is expected and harmless. This avoids the
   * need to fetch the bot's open_id and keeps the logic simple.
   */
  private async removeAllReactions(messageId: string, token: string): Promise<void> {
    try {
      const listRes = await fetch(LARK_REACTIONS_URL(messageId), {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      const listData = await listRes.json() as {
        code: number;
        data?: { items?: { reaction_id: string }[] };
      };

      if (listData.code !== 0) {
        logger.warn({ messageId, code: listData.code }, 'Failed to list reactions');
        return;
      }

      const items = listData.data?.items ?? [];
      if (items.length === 0) return;

      for (const item of items) {
        try {
          const delRes = await fetch(LARK_DELETE_REACTION_URL(messageId, item.reaction_id), {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const delData = await delRes.json() as { code: number };
          if (delData.code !== 0) {
            logger.debug(
              { messageId, reactionId: item.reaction_id, code: delData.code },
              'Failed to delete reaction (may not be owned by bot)',
            );
          }
        } catch (err) {
          logger.warn(
            { messageId, reactionId: item.reaction_id, err },
            'Error deleting reaction',
          );
        }
      }
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to remove reactions (best-effort)');
    }
  }
```

- [ ] **Step 2: Call removeAllReactions after successful thread reply**

In the `sendNotification` method, after the `if (msgData.code !== 0)` error check at the end (line ~96-98), add the reaction cleanup call:

```typescript
    if (msgData.code !== 0) {
      throw new Error(`Lark message send failed with code ${msgData.code}`);
    }

    // Clean up reactions after successful thread reply
    if (result.task_source?.source === 'lark') {
      await this.removeAllReactions(result.task_source.message_id, tokenData.tenant_access_token);
    }
```

- [ ] **Step 3: Update existing "replies in thread" test to account for reaction cleanup calls**

The existing test `'replies in thread when task_source is lark'` in `lark-notifier.test.ts` asserts `mockFetch` is called exactly 2 times (token + reply). After this change, the lark thread-reply path also calls GET reactions, so the mock must include a reactions list response and the assertion must be updated.

Add a third mock response for the reactions list (returning empty items to keep the test focused on the reply behavior):

```typescript
    // After the existing two mockResolvedValueOnce calls, add:
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ code: 0, data: { items: [] } }),
    });
```

Update the assertion from `toHaveBeenCalledTimes(2)` to `toHaveBeenCalledTimes(3)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/daemon/lark-result && npx vitest run src/__tests__/lark-notifier.test.ts`
Expected: PASS — all existing tests and all 5 new reaction cleanup tests pass

- [ ] **Step 5: Run all lark-result tests**

Run: `cd packages/daemon/lark-result && npx vitest run`
Expected: PASS — no regressions

- [ ] **Step 6: Verify compilation**

Run: `cd packages/daemon/lark-result && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/lark-result/src/adapters/lark-notifier.ts packages/daemon/lark-result/src/__tests__/lark-notifier.test.ts
git commit -m "feat(lark-result): remove all reactions on original message after thread reply"
```
