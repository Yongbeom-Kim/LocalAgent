# Design: `/gc` Should Delete Stale Session DB Rows by TTL, Not Only `ended` Rows

**Date:** 2026-04-05
**Status:** Draft
**Depends on:** Session Directory Garbage Collection (implemented), Lark Thread State Backed by SQLite (implemented), `/end` cleanup flow (implemented)

## 1. Problem

The current `/gc` implementation cleans filesystem session directories by age, but its SQLite cleanup path only deletes rows where `lark_threads.status = 'ended'`.

That is narrower than the intended purpose of `/gc`.

The operational need for `/gc` is to clean up stale sessions when the user forgot to send `/end`. In those cases the thread row may still be marked `active`, even though the session is abandoned and older than the TTL. Under the current logic:

1. the workspace directory may be removed by age-based GC;
2. the stale SQLite rows may remain forever if the session was never marked `ended`;
3. the DB cleanup query also ignores the TTL and deletes all `ended` rows immediately, which is broader than the original SQLite lifecycle design.

So the DB query is wrong in both directions: it misses stale non-ended sessions, and it over-deletes ended rows without applying the time cutoff.

## 2. Goal

Make `/gc` delete stale SQLite thread/message rows for any session whose canonical thread state is older than the configured TTL, regardless of whether the session is marked `active` or `ended`.

## 3. Non-Goals

- No change to `/end` behavior. `/end` should continue to delete rows immediately for its own session.
- No new user-facing `/gc` arguments or TTL overrides.
- No schema migration. This is a behavior correction using existing columns.
- No attempt to infer activity from filesystem presence alone.

## 4. User Decisions Captured

- `/gc` should delete DB rows for stale sessions even if they are not marked `ended`.
- Use the existing `updated_at_ms` field as the staleness signal if it is updated on session end as well as normal activity.
- DB cleanup should proceed even when the matching workspace directory is already missing.
- `/gc` should report filesystem and DB cleanup counts separately in the result summary.

## 5. Current State

### 5.1 Filesystem GC behavior

`GcExecutor` scans session directories under `SESSION_BASE_DIR` and removes a directory only when both `mtime` and `atime` are older than the TTL.

### 5.2 Current DB GC behavior

`GcExecutor` currently runs this conceptual query:

```sql
SELECT session_id
FROM lark_threads
WHERE status = 'ended';
```

It then deletes `lark_messages` and `lark_threads` rows by `session_id` for every returned row.

### 5.3 Why `updated_at_ms` is sufficient

The existing SQLite thread state already updates `lark_threads.updated_at_ms` on normal thread-state writes, and cleanup/end flows also set `updated_at_ms` to the end timestamp when a session is ended.

That means `updated_at_ms` is already the canonical “last meaningful thread activity” field for both:

- stale sessions that were never explicitly ended;
- stale sessions that were ended earlier and remained in SQLite due to transient cleanup failure or ordering.

No second timestamp is needed for GC candidate selection.

### 5.4 `updated_at_ms` contract for GC

For this feature, `lark_threads.updated_at_ms` is the canonical last-thread-activity timestamp.

It is expected to advance on:

- authoritative inbound thread-state writes;
- persisted outbound bot replies;
- `/new` thread-state updates;
- end bookkeeping when a session is marked `ended` before deletion.

This design intentionally does not treat local workspace-only file activity as a keepalive signal. If a session produces no thread-state writes for longer than the TTL, `/gc` may collect it even if local files still exist.

That is acceptable because `/gc` is explicitly a stale-session cleanup mechanism, not a “currently open terminal workspace” tracker.

## 6. Scope Assessment

This is one small behavior-correction feature inside the existing GC subsystem:

- tighten DB candidate selection to use TTL;
- broaden candidate selection beyond `status = 'ended'`;
- improve the `/gc` summary so filesystem cleanup and DB cleanup are both visible.

No subsystem split is needed.

## 7. Approaches Considered

### Approach A: Select stale DB candidates by `updated_at_ms` only, regardless of status (recommended)

Use `lark_threads.updated_at_ms < cutoff` as the sole DB staleness predicate, fetch matching `session_id`s, and hard-delete rows by `session_id`.

**Pros**

- matches the actual operational purpose of `/gc`;
- uses one canonical thread-level clock for both active and ended sessions;
- does not depend on workspace presence;
- requires no schema changes;
- keeps `/end` immediate-delete behavior intact.

**Cons**

- a stale-but-intentionally-preserved thread would also be deleted, but that is already the stated intent of `/gc`.

### Approach B: Use `status` plus per-status timestamps

Delete ended rows by `ended_at_ms < cutoff` and active rows by `updated_at_ms < cutoff`.

**Pros**

- makes ended-session handling explicit.

**Cons**

- more branching for no real gain;
- still relies on `updated_at_ms` for active sessions;
- increases implementation and test surface without improving the user contract.

### Approach C: Gate DB deletion on stale filesystem directories

Delete DB rows only when a matching stale workspace directory exists.

**Pros**

- tighter coupling between filesystem and DB cleanup.

**Cons**

- incorrect for sessions whose directories were already removed or never materialized;
- leaves stale SQLite rows behind;
- contradicts the explicit requirement to clean DB rows even if the directory is missing.

## 8. Recommendation

Adopt **Approach A**.

`updated_at_ms` already represents the best canonical last-activity timestamp. It advances when normal thread activity is recorded and when a session is marked ended. That makes it the right single cutoff field for GC candidate selection. `/gc` should be defined as “delete stale sessions older than TTL,” not “delete ended sessions.”

## 9. Proposed Design

### 9.1 Correct `/gc` semantics

`/gc` has two independent cleanup responsibilities:

1. remove stale session directories by filesystem timestamps;
2. remove stale SQLite thread/message rows by DB timestamps.

These responsibilities should be correlated by the same TTL window, but not by physical presence of a workspace directory.

### 9.2 DB candidate query

Replace the current ended-only query with a TTL-based query over canonical thread state:

```sql
SELECT session_id
FROM lark_threads
WHERE updated_at_ms < ?;
```

Where `?` is the same cutoff timestamp used by filesystem GC:

```text
Date.now() - SESSION_DIR_TTL_DAYS * 24 * 60 * 60 * 1000
```

This query intentionally does not filter on `status`.

Recommended repository helper name:

```ts
getStaleLarkSessionIdsBeforeUpdatedAt(cutoffMs: number): Promise<string[]>
```

The helper returns `session_id` values because DB deletion is by `session_id`, even though the staleness predicate is evaluated on the thread row.

### 9.3 Why status should not participate

`status` is still useful thread metadata, but it is not the right GC ownership boundary.

- `ended` rows can remain due to transient failure and should be collected once stale.
- `active` rows can still be abandoned if the user forgot `/end` and should also be collected once stale.

Therefore GC candidate selection should be age-based, not status-based.

### 9.4 Repository boundary

The raw SQL query for stale DB candidates should not live inside `GcExecutor` long-term. The shared DB layer already owns Lark thread/message lifecycle operations, so the stale-session lookup should become a repository helper in `packages/shared`.

Recommended repository API:

```ts
getStaleLarkSessionIdsBeforeUpdatedAt(cutoffMs: number): Promise<string[]>
```

`GcExecutor` should call that helper and then reuse the existing delete-by-session helper.

### 9.5 `/end` failure interaction

This feature does not change the `/end` retry contract.

If `/end` marks a session ended but immediate DB deletion fails, that session becomes eligible for `/gc` only after it is stale relative to the same TTL cutoff. That is acceptable for this narrow correction because the primary goal is to fix stale-session collection, not to introduce a separate near-term retry channel for failed `/end` deletions.

If faster retry for failed `/end` cleanup is needed later, that should be a separate design change.

### 9.6 Query cost and index expectations

The current schema has an index on `(status, updated_at_ms DESC)`, but the corrected GC query filters by `updated_at_ms` without using `status`.

Implementation planning should explicitly verify whether the existing index is sufficient for expected row counts. For this small feature, the default assumption is:

- current table size is small enough that a scan or suboptimal index usage is acceptable;
- no schema migration is required as part of this correction.

If implementation-time evidence shows the query is materially inefficient, a follow-up design can add a dedicated `updated_at_ms` index.

### 9.7 Result summary contract

The `/gc` result should report filesystem and DB cleanup separately.

Recommended summary shape:

```text
GC complete: removed X session dir(s), retained Y session dir(s), deleted Z DB session(s). Errors: N.
```

Behavior notes:

- `deleted Z DB session(s)` counts stale session IDs whose thread/message rows were successfully deleted.
- DB deletion is counted independently of whether a workspace directory existed.
- Per-session DB deletion remains atomic because the existing delete helper removes both tables in one transaction. A session contributes to `deleted Z` only if that transaction succeeds.
- If there are DB cleanup failures, they contribute to the shared error count and should be logged with `session_id`.

### 9.8 Interaction with `/end`

No change:

- `/end` continues to delete its session rows immediately.
- `/gc` remains the safety net for stale sessions and delayed cleanup cases.

This separation is important. `/end` is explicit per-session teardown; `/gc` is broad stale-session collection.

## 10. Affected Components

| Package | File | Change |
|---------|------|--------|
| `@local-agent/shared` | `src/db/lark-history-repository.ts` | Add stale-session lookup helper by `updated_at_ms` cutoff |
| `@local-agent/shared` | `src/__tests__/db/lark-history-repository.test.ts` | Cover stale-session lookup behavior |
| `@local-agent/task-daemon` | `src/services/gc-executor.ts` | Replace ended-only DB query with TTL-based stale-session lookup; track DB deletion counts; update summary |
| `@local-agent/task-daemon` | `src/services/__tests__/gc-executor.test.ts` | Cover stale active sessions, stale ended sessions, missing directories, and separate summary counts |
| `LocalAgent/docs/development/design` | this doc | Correct the GC SQLite lifecycle contract |

## 11. Testing Strategy

### Unit tests

- shared repository returns only session IDs with `updated_at_ms < cutoff`;
- rows newer than cutoff are excluded regardless of status;
- both stale `active` and stale `ended` rows are included.

### Service tests

- `GcExecutor` deletes stale DB rows even when no session directories exist;
- `GcExecutor` deletes stale DB rows for active sessions the user never ended;
- `GcExecutor` reports filesystem and DB counts separately;
- DB deletion failures are logged and reflected in the error count without aborting the whole GC pass.

## 12. Acceptance Criteria

This feature is complete when:

1. `/gc` selects stale SQLite sessions by `lark_threads.updated_at_ms < cutoff`.
2. `/gc` deletes stale DB rows regardless of whether thread `status` is `active` or `ended`.
3. `/gc` deletes stale DB rows even if the session workspace directory is already missing.
4. `/gc` no longer deletes all ended rows immediately without applying TTL.
5. `/gc` returns a user-visible summary with separate filesystem and DB cleanup counts.
6. `/end` behavior remains unchanged.
