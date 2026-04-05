# GC Stale Session DB Cleanup Implementation Plan

**Goal:** Make `/gc` delete stale SQLite session rows by TTL using `lark_threads.updated_at_ms`, regardless of thread status, and report filesystem and DB cleanup counts separately.

**Architecture:** Keep the existing `/gc` pipeline intact. Narrow the implementation to the shared repository and `GcExecutor`: add a shared stale-session lookup helper keyed by `updated_at_ms < cutoff`, replace the ended-only DB cleanup path in `GcExecutor`, and extend tests to cover stale active sessions, stale ended sessions, missing directories, and summary formatting.

**Tech Stack:** TypeScript monorepo, SQLite via shared repository layer, Vitest.

---

## File Structure

- Modify: `LocalAgent/packages/shared/src/db/lark-history-repository.ts`
  Add a repository helper that returns stale `session_id` values by `updated_at_ms` cutoff.
- Modify: `LocalAgent/packages/shared/src/__tests__/db/lark-history-repository.test.ts`
  Add repository coverage for stale-session lookup behavior across active/ended rows.
- Modify: `LocalAgent/packages/daemon/task/src/services/gc-executor.ts`
  Replace ended-only DB cleanup with TTL-based stale-session cleanup and separate DB cleanup counts in the summary.
- Modify: `LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts`
  Add service tests for stale active sessions, stale ended sessions, directory-independent DB cleanup, and error/count behavior.

### Task 1: Add stale-session lookup to the shared repository

**Files:**
- Modify: `LocalAgent/packages/shared/src/db/lark-history-repository.ts`
- Modify: `LocalAgent/packages/shared/src/__tests__/db/lark-history-repository.test.ts`

- [ ] **Step 1: Write the failing repository tests**

Add tests near the existing repository delete tests for these cases:

```ts
it('returns stale session ids older than the cutoff regardless of status', async () => {
  // seed one stale active thread, one stale ended thread, one fresh active thread
  // expect only the two stale session ids back
});

it('returns an empty list when no thread rows are older than the cutoff', async () => {
  // seed only fresh rows
  // expect []
});
```

Use `repository.upsertLarkThreadState(...)` so the test reflects the real thread-state write path.

- [ ] **Step 2: Run the repository tests to verify they fail**

Run: `cd LocalAgent/packages/shared && pnpm test -- src/__tests__/db/lark-history-repository.test.ts`
Expected: FAIL because the stale-session lookup helper does not exist yet.

- [ ] **Step 3: Implement the repository helper**

Add this method to `LarkHistoryRepository`:

```ts
async getStaleLarkSessionIdsBeforeUpdatedAt(cutoffMs: number): Promise<string[]> {
  const rows = await this.db
    .select({ sessionId: larkThreadsTable.sessionId })
    .from(larkThreadsTable)
    .where(lt(larkThreadsTable.updatedAtMs, cutoffMs));

  return rows.map((row) => row.sessionId);
}
```

Implementation notes:

- import `lt` from `drizzle-orm` alongside the existing helpers;
- do not filter on `status`;
- keep the method in the shared repository because DB lifecycle queries belong in `packages/shared`.

- [ ] **Step 4: Run the repository tests to verify they pass**

Run: `cd LocalAgent/packages/shared && pnpm test -- src/__tests__/db/lark-history-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the repository change**

```bash
git -C LocalAgent add packages/shared/src/db/lark-history-repository.ts packages/shared/src/__tests__/db/lark-history-repository.test.ts
git -C LocalAgent commit -m "feat(shared): add stale lark session lookup for gc"
```

### Task 2: Switch `GcExecutor` DB cleanup from ended-only to stale-by-TTL

**Files:**
- Modify: `LocalAgent/packages/daemon/task/src/services/gc-executor.ts`
- Modify: `LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts`

- [ ] **Step 1: Write the failing GC executor tests**

Add targeted tests covering these behaviors:

```ts
it('deletes stale db rows for active sessions even when no session directories exist', async () => {
  const listStaleSessionIds = vi.fn().mockResolvedValue(['session-active-stale']);
  const deleteRowsBySessionId = vi.fn().mockResolvedValue(undefined);
  const executor = new GcExecutor(listStaleSessionIds, deleteRowsBySessionId);

  const result = await executor.execute(createJob());

  expect(deleteRowsBySessionId).toHaveBeenCalledWith('session-active-stale');
  expect(result.stdout).toContain('deleted 1 DB session(s)');
});

it('includes both stale active and stale ended sessions in db cleanup', async () => {
  const listStaleSessionIds = vi.fn().mockResolvedValue(['session-active', 'session-ended']);
  const deleteRowsBySessionId = vi.fn().mockResolvedValue(undefined);
  const executor = new GcExecutor(listStaleSessionIds, deleteRowsBySessionId);

  const result = await executor.execute(createJob());

  expect(deleteRowsBySessionId).toHaveBeenCalledTimes(2);
  expect(result.stdout).toContain('deleted 2 DB session(s)');
});

it('increments the error count when stale db row deletion fails', async () => {
  const listStaleSessionIds = vi.fn().mockResolvedValue(['session-ok', 'session-fail']);
  const deleteRowsBySessionId = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('db delete failed'));
  const executor = new GcExecutor(listStaleSessionIds, deleteRowsBySessionId);

  const result = await executor.execute(createJob());

  expect(result.stdout).toContain('deleted 1 DB session(s)');
  expect(result.stdout).toContain('Errors: 1.');
});
```

- [ ] **Step 2: Run the GC executor tests to verify they fail**

Run: `cd LocalAgent/packages/daemon/task && pnpm test -- src/services/__tests__/gc-executor.test.ts`
Expected: FAIL because `GcExecutor` still queries ended rows only and the summary does not include DB counts.

- [ ] **Step 3: Update `GcExecutor` to use the stale-session cutoff**

Refactor `gc-executor.ts` as follows:

1. Rename the injected lookup type from ended-only semantics to stale-session semantics:

```ts
type ListStaleSessionIds = (cutoffMs: number) => Promise<string[]>;
```

2. Replace the raw SQL helper with a repository-backed implementation:

```ts
const listStaleSessionIdsFromDb: ListStaleSessionIds = async (cutoffMs) => {
  const client = await createSqliteClient(loadSqliteConfig());

  try {
    const repository = new LarkHistoryRepository(client.db);
    return await repository.getStaleLarkSessionIdsBeforeUpdatedAt(cutoffMs);
  } finally {
    client.close();
  }
};
```

3. Compute `cutoff` once in `execute()` and pass it to DB cleanup.

4. Replace `cleanupEndedRows()` with a stale-session cleanup helper that returns counts:

```ts
private async cleanupStaleRows(job: Job, cutoffMs: number): Promise<{ deleted: number; errors: number }> {
  // list session ids via repository helper
  // delete each session in the existing per-session transaction helper
  // count successful deletions and per-session failures
}
```

5. Update the final summary format to include DB cleanup counts separately:

```ts
GC complete: removed ${removed} session dir(s), retained ${retained} session dir(s), deleted ${deletedDb} DB session(s).${errors > 0 ? ` Errors: ${errors}.` : ''}
```

6. Preserve existing filesystem behavior:

- same TTL cutoff;
- same locked-session skip behavior;
- same non-directory ignore behavior.

- [ ] **Step 4: Run the GC executor tests to verify they pass**

Run: `cd LocalAgent/packages/daemon/task && pnpm test -- src/services/__tests__/gc-executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit the GC executor change**

```bash
git -C LocalAgent add packages/daemon/task/src/services/gc-executor.ts packages/daemon/task/src/services/__tests__/gc-executor.test.ts
git -C LocalAgent commit -m "fix(task): gc stale sqlite sessions by ttl"
```

### Task 3: Run focused verification for the full correction

**Files:**
- Modify: none
- Test: `LocalAgent/packages/shared/src/__tests__/db/lark-history-repository.test.ts`
- Test: `LocalAgent/packages/daemon/task/src/services/__tests__/gc-executor.test.ts`

- [ ] **Step 1: Run the focused shared and task tests together**

Run: `cd LocalAgent && pnpm --dir packages/shared test -- src/__tests__/db/lark-history-repository.test.ts && pnpm --dir packages/daemon/task test -- src/services/__tests__/gc-executor.test.ts`
Expected: PASS.

- [ ] **Step 2: Sanity-check unchanged `/end` behavior by inspection**

Read:

- `LocalAgent/packages/daemon/task/src/adapters/cleanup-executor.ts`
- `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`

Verify:

- cleanup still deletes rows immediately by `session_id`;
- this feature did not broaden `/gc` into a replacement for `/end`.

- [ ] **Step 3: Capture the final implementation commit**

```bash
git -C LocalAgent status --short
git -C LocalAgent add packages/shared/src/db/lark-history-repository.ts packages/shared/src/__tests__/db/lark-history-repository.test.ts packages/daemon/task/src/services/gc-executor.ts packages/daemon/task/src/services/__tests__/gc-executor.test.ts
git -C LocalAgent commit -m "fix(gc): delete stale sqlite sessions by ttl"
```
