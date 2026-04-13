# Mandatory Task Session ID Design

## Goal

Require every accepted task to carry a canonical `session_id` before it is enqueued, with producers generating a new session id when they want to start a fresh session.

## Problem

The current pipeline allows `POST /tasks` without `session_id`, while downstream phase/result delivery now expects `session_id` to exist. That leaves the system with a split contract:

- intake can accept a sessionless task
- enrichment publishes lifecycle events before any generic fallback session is guaranteed to exist
- routing, locking, persistence, and outbound notification all behave more deterministically when a canonical session already exists

This mismatch creates both operational ambiguity and avoidable special cases.

## Decision

Make `session_id` mandatory at task enqueue time.

Rules:

1. `POST /tasks` rejects any request whose `session_id` is missing, empty, or non-string.
2. Producers are responsible for supplying `session_id`.
3. If a producer wants a fresh session, it generates a new id locally and sends it.
4. Lark and Telegram inbound listeners continue resolving or generating canonical session ids before calling `/tasks`.
5. Scheduler continues generating a fresh session id before submit.
6. CLI/direct submitters generate a fresh session id when the caller omits one.

We do not add uniqueness guarantees beyond existing database behavior. Session id conflicts are tolerated as an operational caller responsibility.

## Why This Is Better

This keeps one invariant across the whole system:

> every queued task already has a canonical execution session

Benefits:

- `/tasks`, `/jobs`, `/results`, enrichment, task execution, and outbound delivery all use the same contract
- the first `enriching` phase can always include `session_id`
- enrichment no longer needs to treat missing-session intake as a normal path
- channel-based canonicalization stays near the channel adapters, where thread context is already available

## Non-Goals

- no server-side session allocation endpoint
- no attempt to prevent callers from reusing the same session id accidentally
- no redesign of the session-to-Lark/Telegram mapping model

## Implementation Notes

- API validation should use the same error semantics already used by `/results` and `/jobs`:
  - `session_id is required and must be a non-empty string`
- Producer-side UUID generation should happen in direct submitters, not in enrichment.
- Shared type definitions should be tightened if practical in the same change, so future optional-session callers are caught at compile time.

## Affected Areas

- `/tasks` route validation
- direct CLI submission
- any sessionless producer code paths
- enrichment assumptions/tests around generated session ids
- shared task types if they still model `session_id` as optional

## Acceptance Criteria

- accepted tasks always include `session_id`
- first-party producers always send `session_id`
- enrichment no longer depends on creating a generic fresh session after dequeue
- first `enriching` phase publish remains valid for all accepted tasks
