# Design: Scheduled Task Submission with Lazy Outbound Fallback Threads

**Date:** 2026-04-08
**Status:** Approved
**Depends on:** Canonical `/tasks` intake, task-enrichment YAML directory loading, per-session job queues, Lark and Telegram outbound delivery daemons

## Problem

The product needs scheduled task execution without forcing users to write raw HTTP requests, manage API authentication headers, or manually wire environment details. At the same time, scheduled work must not become a second-class execution path with scheduler-specific branching spread across enrichment, execution, and result publishing.

Two concrete design problems need to be solved together:

1. Users need a scheduler-facing configuration model that is easier than writing `POST /tasks` requests but still maps cleanly onto the existing canonical task contract.
2. Outbound delivery currently assumes that thread/topic context either already exists or it can fall back to blunt defaults. For scheduled work and any other session lacking prior messaging context, result delivery must lazily create a new Lark root message or Telegram forum topic only when delivery discovers that no existing destination can be resolved.

## Goals

1. Add scheduled task execution through a new compose-managed scheduler service.
2. Let users define schedules in a directory of YAML files that are merged like enrichment configuration.
3. Keep scheduled runs on the normal pipeline: scheduler -> `POST /tasks` -> enrichment -> `POST /jobs` -> task daemon -> results.
4. Hide API URL, auth headers, and related submission boilerplate from schedule authors.
5. Require schedule authors to keep specifying the normal task fields they already understand: `task_type`, `executor`, `executor_model`, and `payload`.
6. Make Lark and Telegram outbound delivery create a fallback conversation anchor only when phase/result delivery cannot resolve an existing thread/topic.
7. Reuse the same lazy fallback behavior for any session without thread/topic context, not just scheduled sessions.

## Non-Goals

- Making enrichment, execution, or result publication semantically aware of a new “scheduled job” type.
- Adding destination overrides in schedule YAML.
- Replacing cron syntax with a natural-language schedule DSL.
- Hiding executor/model/task-type choices from schedule authors.
- Adding an enable/disable flag per schedule entry.
- Forcing result events to carry the original task payload.

## Constraints From Existing Code

- `packages/api/src/routes/tasks.ts` is the canonical intake contract and already validates `task_type`, `payload`, optional executor fields, optional `session_id`, and optional `task_source`.
- `packages/daemon/task-enrichment/src/enrichment-service.ts` already supports merging a directory of YAML files, so schedule config should follow that pattern.
- `packages/daemon/lark-result/src/adapters/lark-notifier.ts` currently replies in-thread for Lark-sourced work and otherwise falls back to sending a new top-level message to the fixed recipient.
- `packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts` currently falls back to posting into the configured forum group without creating a new topic.
- Phase and result events do not carry the original task payload, so outbound fallback cannot seed a new conversation from event data alone.

## Key Decisions (For Planning)

1. **Persistence path:** fallback seed metadata is persisted via the canonical `/tasks` intake (additive, optional fields) rather than requiring the scheduler daemon to write to the DB directly.
2. **Naming:** DB columns use `snake_case`; TypeScript fields use `camelCase`.
3. **Idempotency:** lazy anchor creation is guarded by a uniqueness constraint on `(session_id, platform)` plus transaction/upsert semantics to prevent duplicate anchors under retries or concurrent deliveries.

## Approaches Considered

### Approach 1: Scheduler-aware source propagated end to end

Introduce a new `task_source.source = "scheduler"` variant and teach enrichment, execution, phase publishing, and outbound delivery to branch on it.

Why not chosen:

- violates the desired contract that scheduled work should behave like normal work through the core pipeline;
- leaks schedule awareness into components that should remain generic;
- creates extra branching in validation and event handling for logic that only outbound fallback needs.

### Approach 2: Put the original payload onto phase/result events

Keep the pipeline generic, but expand outbound event contracts so phase and result handlers can seed a fallback root message/topic directly from the event payload.

Why not chosen:

- broadens event schemas for data only fallback delivery needs;
- duplicates data already known earlier in the pipeline;
- increases coupling between execution output events and delivery bootstrapping.

### Approach 3: Persist fallback seed metadata by session and create conversations lazily in outbound delivery

Keep scheduled intake generic, persist enough session-scoped metadata for later delivery fallback, and let Lark/Telegram outbound daemons create a root anchor only if they cannot resolve an existing thread/topic at delivery time.

Why chosen:

- matches the requirement that only fallback behavior should be special;
- keeps enrichment and execution unaware of scheduling;
- works for both scheduled runs and any future session that also lacks messaging context;
- lets phase updates and final results share the same lazily created destination once it exists.

## Chosen Design

### 1. Add a scheduler service that submits normal canonical tasks

**Files likely involved:**
- `LocalAgent/docker-compose.yml`
- `LocalAgent/packages/daemon/task-scheduler/` (new package)
- `LocalAgent/packages/shared/src/api-auth.ts`
- `LocalAgent/packages/shared/src/config.ts`

Add a new compose service dedicated to schedule execution. The service should run Supercronic as the trigger engine, but Supercronic should execute a local scheduler command rather than raw `curl` commands.

Each fired schedule entry becomes a normal `POST /tasks` request. The scheduler owns API URL resolution, bearer token injection, env loading, and retry/logging behavior. Schedule authors do not write HTTP requests.

The resulting task submissions must be indistinguishable from manually submitted tasks except for metadata persisted for delivery fallback.

### 2. Use a directory of YAML files merged like enrichment config

**Files likely involved:**
- `LocalAgent/packages/daemon/task-scheduler/config/` (new)
- `LocalAgent/packages/daemon/task-scheduler/src/schedule-config.ts` (new)
- `LocalAgent/packages/daemon/task-scheduler/src/cron-renderer.ts` (new)

Scheduler config should be directory-based and merged across all `*.yaml` and `*.yml` files, mirroring the existing enrichment configuration loading model.

Recommended structure:

```yaml
schedules:
  morning-review:
    cron: "0 9 * * 1-5"
    task:
      task_type: generic
      executor: claude
      executor_model: sonnet
      payload: |
        Review the overnight failures and summarize the top issues.
```

Properties:

- top-level `schedules` map keyed by stable schedule name;
- each entry uses raw cron syntax as the source of truth;
- each entry contains a nested canonical task body with the same user-visible fields they would otherwise send to `/tasks`.

The scheduler merges all files, rejects duplicate schedule names across files, validates cron strings, and validates required task fields before rendering runtime output.

### 3. Render cron entries into scheduler-owned commands, not user-authored shell boilerplate

**Files likely involved:**
- `LocalAgent/packages/daemon/task-scheduler/src/cron-renderer.ts` (new)
- `LocalAgent/packages/daemon/task-scheduler/src/submitter.ts` (new)
- `LocalAgent/packages/cli/src/commands/submit.ts` (reference only)

Each schedule entry should render to a cron line that invokes the scheduler package itself with a stable schedule identifier, for example:

```text
0 9 * * 1-5 node dist/index.js run morning-review
```

The cron layer should not embed payload JSON, auth headers, or environment secrets into crontab lines. Instead:

1. scheduler startup loads and validates merged YAML;
2. scheduler renders a temporary crontab file for Supercronic;
3. scheduler writes a validated config snapshot to disk (for example `config.snapshot.json`) that cron-fired processes can read without re-merging YAML;
4. when a cron entry fires, the scheduler resolves the named entry from the config snapshot;
5. the scheduler submits the corresponding canonical task to `/tasks`.

This keeps crontab generation simple and makes schedule files the source of truth.

### 4. Persist session-scoped fallback seed metadata before outbound delivery needs it

**Files likely involved:**
- `LocalAgent/packages/shared/src/db/schema.ts`
- `LocalAgent/packages/shared/src/db/session-repository.ts`
- `LocalAgent/packages/shared/src/types.ts`
- `LocalAgent/packages/api/src/routes/tasks.ts`
- `LocalAgent/packages/daemon/task-scheduler/src/submitter.ts` (new)

Outbound fallback needs enough data to create the first conversation anchor even though result and phase events do not carry the original task payload. The cleanest place to store that data is session-scoped persistence.

Add session-level fallback metadata that can be recovered by `session_id`, minimally:

- `fallback_seed_text`: the original task payload used to seed a new Lark root message or Telegram topic/message;
- `fallback_origin`: a lightweight string such as `canonical-task` or `scheduler`, useful for observability only;
- optional `fallback_title_hint`: for Telegram topic naming if needed, though v1 can use the payload text directly or a truncated derivative.

**Write path:** the scheduler submits this metadata through the canonical `/tasks` request as additive optional fields (for example a `session` object), and the API persists it alongside session creation/update. This avoids coupling the scheduler to DB connectivity and keeps a single authoritative write-path for session data.

**Guardrails:** schedule YAML must not allow specifying `task_source` or destination/thread/topic identifiers (explicitly out of scope for v1). If present, the scheduler should reject the config at startup.

The scheduler should generate a fresh `session_id` before calling `/tasks` so it can include fallback metadata alongside the canonical submission. Manual or other submitters that want the same lazy fallback behavior can also opt into populating this metadata later without changing the execution pipeline.

### 5. Make outbound delivery lazily create the missing destination on first phase/result delivery

**Files likely involved:**
- `LocalAgent/packages/daemon/lark-result/src/adapters/lark-notifier.ts`
- `LocalAgent/packages/daemon/lark-result/src/adapters/lark-phase-notifier.ts`
- `LocalAgent/packages/daemon/telegram-outbound/src/adapters/telegram-notifier.ts`
- `LocalAgent/packages/daemon/telegram-inbound/src/adapters/telegram-topic-manager.ts` (reused or moved to shared code)
- `LocalAgent/packages/shared/src/db/session-platform-link-repository.ts`
- `LocalAgent/packages/shared/src/db/lark-history-repository.ts`
- `LocalAgent/packages/shared/src/db/telegram-history-repository.ts`

Delivery logic becomes:

1. phase or result notifier receives an event;
2. if explicit thread/topic info exists in `task_source`, use it exactly as today;
3. else if an existing session-to-platform mapping exists, use that destination;
4. else resolve session fallback metadata;
5. lazily create a new platform-specific anchor;
6. persist platform link + thread/topic state;
7. deliver the current phase/result into that new destination.

This keeps the special behavior entirely inside outbound fallback resolution.

#### Lark fallback behavior

When no Lark thread can be resolved:

- send a new top-level message to the configured recipient containing the stored fallback seed text;
- persist the created root message in `lark_threads`, `lark_messages`, and `session_platform_links`;
- deliver the current phase or result by replying in-thread to that root message.

The initial root message becomes the anchor for future phase and result replies in that session.

#### Telegram fallback behavior

When no Telegram topic can be resolved:

- create a new forum topic in the configured forum group;
- seed that topic with an initial message containing the stored fallback seed text;
- persist the new topic and message in `telegram_threads`, `telegram_messages`, and `session_platform_links`;
- deliver the current phase or result message into that topic.

Telegram therefore mirrors Lark behavior conceptually: create a new anchor only when outbound fallback needs one.

### 6. Phase updates and final results use the same lazy destination contract

**Files likely involved:**
- `LocalAgent/packages/daemon/lark-result/src/lark-poller.ts`
- `LocalAgent/packages/daemon/telegram-outbound/src/telegram-poller.ts`
- phase notifier adapters for both platforms

The same fallback creation logic must be used for both phase updates and final results. The first outbound event for a session, whether it is `received`, `queued`, `executing`, or `result`, is allowed to create the anchor. Later events reuse the persisted link.

This satisfies the requirement that execution itself does not know or care whether the work is scheduled.

### 7. No scheduler-specific task source is added in v1

The scheduler should submit ordinary canonical tasks without introducing a new `task_source` variant. Existing source semantics remain reserved for real inbound messaging origins such as Lark or Telegram.

The scheduler may still persist fallback seed metadata and a generated `session_id`, but that metadata must not change the meaning of task intake, enrichment, or execution.

## Data Model Changes

### Session persistence

Extend session persistence so outbound services can load fallback metadata by `session_id`.

Recommended additions to `sessions` table or a closely related session metadata table:

- DB columns:
  - `fallback_seed_text TEXT NULL`
  - `fallback_origin TEXT NULL`
  - `fallback_title_hint TEXT NULL`
- TypeScript fields (for API + repositories):
  - `fallbackSeedText?: string`
  - `fallbackOrigin?: string`
  - `fallbackTitleHint?: string`

Storing this with the session is preferable to inventing a separate schedule-specific table because the metadata serves delivery fallback for any session, not only scheduled sessions.

### Platform link persistence

No conceptual schema change is required for `session_platform_links`, but the write path expands: links are no longer created only from inbound listeners or bridge setup. Outbound fallback can create the first platform link for a session.

Add (or confirm) a uniqueness constraint to make lazy creation safe under retries/concurrency:

- `UNIQUE(session_id, platform)` on `session_platform_links`

## Runtime Flow

### Scheduled run submission

1. Supercronic fires a named schedule entry.
2. Scheduler loads the entry and generates a fresh `session_id`.
3. Scheduler submits a normal canonical task to `/tasks` using that `session_id` and includes session fallback metadata (seed text, origin, optional title hint).
4. The `/tasks` intake persists the session fallback metadata alongside session creation/update.
5. Enrichment and execution proceed exactly as they do for any other task.

### Lazy fallback delivery

1. Outbound phase/result daemon receives an event with no usable thread/topic info.
2. Daemon checks for an existing platform link for the session.
3. If none exists, daemon reads session fallback metadata.
4. Daemon creates the platform anchor:
   - Lark: top-level message
   - Telegram: forum topic + seed message
5. Daemon persists platform link + message/thread state.
6. Daemon posts the current event into the newly created destination.
7. Future events for the same session reuse that destination.

## Failure Handling

### Scheduler failures

- Invalid YAML or duplicate schedule names should fail scheduler startup clearly.
- Invalid cron expressions should fail before Supercronic starts.
- Failure to submit to `/tasks` should be logged with the schedule name and retried only according to the scheduler’s own submission policy, not by cron shell loops.

### Fallback delivery failures

- If outbound delivery cannot create a Lark root or Telegram topic, it should log and retry according to the existing notifier retry behavior.
- Fallback creation must be idempotent enough to avoid duplicate anchors on retried delivery and under concurrent deliveries. The preferred strategy is:
  - perform link creation with a transaction + upsert keyed by `(session_id, platform)`;
  - on a retryable failure, re-check `session_platform_links` before attempting a second create;
  - persist the created destination immediately after success (before delivering the triggering phase/result if practical).

## Testing Strategy

### Scheduler config and rendering

Add tests for:

- loading and merging multiple schedule YAML files;
- rejecting duplicate schedule names across files;
- validating required task fields and cron expressions;
- rendering stable Supercronic entries that invoke named schedules rather than embedding request boilerplate.

### Scheduler submission

Add tests for:

- generating a fresh `session_id` per fired run;
- including fallback seed metadata in the `/tasks` submission and verifying it is persisted by the API;
- posting a normal canonical task to `/tasks` with auth headers handled by the scheduler;
- surfacing submission failures clearly.

### Lark lazy fallback

Add tests for:

- phase delivery creating a new root message when no thread or platform link exists;
- result delivery creating the root if phase delivery did not do so first;
- persisting the resulting root message and session-platform link;
- later events reusing the same root and replying in-thread.

### Telegram lazy fallback

Add tests for:

- creating a forum topic when no topic or platform link exists;
- sending the seed message with fallback text into the new topic;
- delivering the triggering phase/result into that topic;
- persisting topic state and later reusing it.

### Regression coverage

Add tests to prove that:

- existing Lark- and Telegram-sourced threaded flows remain unchanged;
- tasks with existing `task_source` still reply into their original thread/topic;
- non-scheduled sessions can also benefit from lazy outbound fallback if session metadata exists.

## Open Questions Resolved

- Schedule files use raw cron syntax, not a natural-language schedule DSL.
- Schedule YAML hides API/auth/env boilerplate only; it does not hide executor/model/task-type choices.
- There are no destination overrides in v1.
- There is no enable/disable switch in schedule config.
- Result events do not need to carry the original payload; fallback delivery recovers the seed text from session-scoped persistence instead.

## Recommendation

Implement the scheduler and lazy outbound fallback together, but keep their coupling narrow:

- scheduler is responsible only for canonical submission plus seeding session fallback metadata;
- outbound daemons are responsible only for creating missing destinations when delivery requires them;
- enrichment, execution, and result publication remain generic.

This preserves the current mental model of the system while adding scheduled execution and robust fallback delivery with the smallest amount of new semantic branching.
