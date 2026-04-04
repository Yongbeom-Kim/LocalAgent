# Design: Machine-Wide Singleton Lock for `task-daemon`

**Date:** 2026-04-04
**Status:** Draft
**Depends on:** Concurrent Session Execution (implemented), Thread `/status` Command for Live Executor Presence (implemented design assumption)

## Problem

The current system assumes a single `task-daemon` process owns execution for a machine, but that assumption is not enforced at startup.

Today, starting a second `task-daemon` instance on the same machine can create ambiguous behavior:

- both daemons may poll the API concurrently;
- `/status` semantics are only correct if one process owns the machine-local running state;
- operators do not get a clear fail-fast signal that the deployment is misconfigured.

The repo already has per-session lock files under `SESSION_BASE_DIR`, but those locks serialize job execution within a session. They are not the right abstraction for machine-wide daemon ownership.

## Goal

Enforce that only one `task-daemon` process can run per machine at a time.

Concretely:

1. `task-daemon` startup must attempt to acquire a dedicated machine-wide lock before starting the status server or poller.
2. If another live `task-daemon` process already holds the lock, startup must log a clear error and exit with a non-zero code.
3. If the lock file is stale or corrupt, startup must treat it as stale, overwrite it, and continue.
4. On normal shutdown, `task-daemon` must remove the machine-wide lock best-effort.
5. A test/debug-only env var, `TASK_DAEMON_DISABLE_MACHINE_LOCK=1`, may bypass the entire singleton lock path.

## Non-Goals

- Applying a machine-wide singleton lock to other daemon packages.
- Replacing the existing per-session execution lock.
- Introducing cross-machine coordination or distributed leader election.
- Changing how local development scripts launch non-task daemons.
- Using the status port binding itself as the singleton contract.

## User Decisions

- Scope is `task-daemon` only.
- Duplicate startup should fail fast.
- Stale lock detection should use PID liveness.
- Corrupt lock files should be treated as stale and overwritten.
- Lock acquisition must happen before the status server starts listening.
- A bypass env var is allowed for tests/debugging only.
- Runtime docs should mention the singleton behavior and bypass flag.

## Existing Context

### 1. Process-local `/status` already assumes a singleton task daemon

`docs/development/design/2026-04-03-thread-status-command-design.md` explicitly states that live running-state checks are only correct if one `task-daemon` process owns execution for the machine. This feature turns that assumption into an enforced startup invariant.

### 2. Session lock and machine lock have different responsibilities

`packages/daemon/task/src/services/session-lock.ts` guards per-session job execution using session directories under `SESSION_BASE_DIR`.

That lock:

- is keyed by `session_id` and `job_id`;
- is acquired/released repeatedly during job execution;
- exists to serialize work within a session.

The new machine-wide lock is different:

- it is keyed to the daemon process itself;
- it is acquired once at startup and released at shutdown;
- it exists to guarantee singleton daemon ownership.

The two concerns should remain separate.

### 3. Current tests are mostly unaffected

The current task-daemon unit tests primarily cover:

- `TaskPoller`
- `SessionLockManager`
- shared config parsing
- `createStatusServer()`

They do not currently launch `main()` twice in the same process or start full daemon startup in integration-style tests. That means the singleton lock should not break the current unit suites by default. The bypass flag is still justified for future startup-level tests and ad hoc debug workflows.

## Approaches Considered

### Approach 1: Reuse the existing session-lock implementation

Use `SessionLockManager` with a synthetic session id to represent daemon ownership.

**Why not chosen:**

- mixes startup ownership with per-session execution concerns;
- makes lock-file semantics harder to reason about;
- risks accidental coupling between daemon lifecycle and session cleanup behavior.

### Approach 2: Add a dedicated machine-lock manager for `task-daemon`

Introduce a new startup/shutdown lock manager responsible only for machine-wide daemon ownership.

**Why chosen:**

- directly matches the requirement;
- keeps the lock contract small and explicit;
- avoids contaminating the session-lock abstraction;
- makes duplicate startup failures and stale-lock recovery easy to document and test.

### Approach 3: Treat status-port binding as the singleton gate

Rely on `TASK_DAEMON_STATUS_PORT` bind failures instead of a dedicated lock file.

**Why not chosen:**

- conflates network binding with ownership semantics;
- provides weaker stale-holder diagnostics;
- only works if every deployment uses a single fixed port contract;
- hides the intended singleton policy behind an implementation detail.

## Design

### 1. Add a dedicated machine-lock manager

**New file:** `packages/daemon/task/src/services/machine-lock.ts`

Add a small service responsible for startup-level singleton ownership.

Recommended lock file path:

- `/var/tmp/local-agent/task-daemon.lock`

Recommended lock file schema:

```json
{
  "pid": 12345,
  "locked_at": "2026-04-04T12:34:56.000Z"
}
```

`job_id` is intentionally omitted because this lock represents process ownership, not job ownership.

Recommended public API:

- `acquire(): { acquired: true } | { acquired: false; holderPid: number; lockPath: string }`
- `release(): void`

Implementation constraint:

- lock acquisition must be race-safe if two `task-daemon` processes start at the same time. Do not implement acquisition as a naive "check then write" (`existsSync` + `writeFileSync`) because it can allow double-acquire.
- recommended approach: attempt `openSync(lockPath, 'wx')` (exclusive create). If it succeeds, write lock contents and close. If it fails with `EEXIST`, fall back to reading/parsing the existing lock and applying the stale/corrupt logic below.

Behavior:

1. If `TASK_DAEMON_DISABLE_MACHINE_LOCK=1`, do not read, write, or delete the lock file. Log that the machine lock is disabled and return success through a bypassed code path.
2. If no lock file exists, write the current PID and timestamp, then return acquired.
3. If the lock file exists and parses:
   - if the recorded PID is the current process PID, treat acquisition as idempotent and return acquired;
   - if the recorded PID is alive, return `acquired: false` with the holder PID and lock path;
   - if the recorded PID is dead, log a stale-lock warning, overwrite the file, and return acquired.
4. If the lock file is corrupt or unreadable, log a warning, overwrite it, and return acquired.
5. `release()` removes the file best-effort when the lock is enabled. Failures should be logged but not thrown.

Notes:

- tests should not touch the real lock path; the manager should accept a lock-path override for unit tests.

Use the same PID liveness check pattern as `SessionLockManager.isPidAlive()`:

- `process.kill(pid, 0)` success means alive;
- `EPERM` means alive;
- `ESRCH` means dead.

This shared behavior is intentional, but the implementation should remain independent unless refactoring reveals a clean low-risk extraction.

### 2. Wire machine lock acquisition into daemon startup before any listeners start

**File:** `packages/daemon/task/src/task-daemon.ts`

Startup order must become:

1. load config;
2. create logger;
3. instantiate the machine-lock manager;
4. attempt machine-lock acquisition;
5. if acquisition fails, log holder PID + lock path and exit non-zero;
6. only after successful acquisition, create/start the status server and poller.

This ordering guarantees that a rejected duplicate daemon:

- does not bind the status port;
- does not start polling or executing jobs;
- does not appear partially healthy.

Recommended log shape on failure:

- include `holderPid`
- include `lockPath`
- make it clear that only one `task-daemon` may run per machine

Recommended exit behavior:

- duplicate startup exits with code `1`

### 3. Release the machine lock during shutdown and fatal startup cleanup

**File:** `packages/daemon/task/src/task-daemon.ts`

Update shutdown handling so normal exits release the singleton lock best-effort after the server is closed and the poller drains.

Important cases:

- `SIGINT`
- `SIGTERM`
- startup failure after the machine lock is acquired but before the daemon is fully running

Design requirement:

- if startup acquires the machine lock and then later throws while bringing up the status server, the code must still release the machine lock before exiting.

This avoids creating unnecessary stale locks on startup errors.

### 4. Keep configuration explicit and scoped to task-daemon startup

**Files:**

- `packages/shared/src/constants.ts`
- `packages/shared/src/config.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/__tests__/config.test.ts`

Add explicit shared constants for the new lock behavior, recommended:

- `DEFAULT_TASK_DAEMON_MACHINE_LOCK_PATH = '/var/tmp/local-agent/task-daemon.lock'`
- `TASK_DAEMON_MACHINE_LOCK_DISABLE_ENV = 'TASK_DAEMON_DISABLE_MACHINE_LOCK'`

Config handling should stay lightweight. There are two acceptable options:

1. expose the lock path and disable flag interpretation from `loadDaemonConfig()`; or
2. keep `loadDaemonConfig()` focused on current daemon network/polling settings and let `task-daemon.ts` / `machine-lock.ts` read the specific env var directly while using shared constants for names/defaults.

**Recommendation:** option 2.

Reasoning:

- the new env var is task-daemon-specific and not relevant to other daemons using different config loaders;
- it avoids widening the generic daemon config type for a startup concern only one current consumer needs;
- constants still keep the contract centralized and testable.

If implementation reveals that `loadDaemonConfig()` already acts as task-daemon-specific config in practice, widening it is still acceptable, but it is not required by the design.

### 5. Tests should target the lock manager and startup order boundaries

**Files:**

- `packages/daemon/task/src/services/__tests__/machine-lock.test.ts` (new)
- `packages/daemon/task/src/__tests__/task-daemon.test.ts`
- optional: `packages/shared/src/__tests__/config.test.ts` if new shared constants/config exposure is added

#### `MachineLockManager` tests

Add focused unit tests for:

- acquires when no lock file exists;
- returns duplicate-start rejection when another live PID owns the lock;
- overwrites stale lock when PID is dead;
- overwrites corrupt JSON lock file;
- treats same-PID reacquisition as idempotent;
- bypass env var skips file creation and acquisition failures;
- `release()` removes the lock when enabled;
- `release()` is a no-op when bypass is enabled.

Use a temp test lock path rather than the real `/var/tmp/local-agent/task-daemon.lock`.

#### `task-daemon` startup tests

The current `task-daemon.test.ts` only covers `createStatusServer()`. Expand it so startup sequencing is verifiable without launching a real long-running daemon process.

Recommended direction:

- extract a small startup helper if needed so tests can assert that duplicate-start rejection happens before `statusServer.listen()` / `poller.start()`;
- verify that startup failure after lock acquisition calls machine-lock release;
- keep these tests narrow and mock-driven rather than building a full process harness.

The design does not require a full child-process integration suite for V1.

### 6. Runtime docs must describe the singleton contract and bypass flag

**File:** `docs/LOCAL_DEVELOPMENT.md`

Document:

- only one `task-daemon` may run per machine at a time;
- duplicate startup fails fast;
- stale lock files are automatically recovered via PID liveness checks;
- `TASK_DAEMON_DISABLE_MACHINE_LOCK=1` is for tests/debugging only.

Important wording constraint:

- do not present the bypass flag as normal operational configuration.

This should read as an escape hatch for controlled test/debug scenarios, not a recommended deployment mode.

## Testing Strategy

### Unit tests

Run targeted task-daemon tests:

- machine-lock manager tests;
- task-daemon startup sequencing tests;
- existing `task-daemon` status server tests;
- existing session-lock tests to verify no regression.

### Shared verification

If shared constants/config are touched, run the relevant shared test suite.

### Manual smoke test

From the repo root:

1. start API and one `task-daemon`;
2. attempt to start a second `task-daemon` on the same machine;
3. confirm the second process exits immediately with a clear duplicate-lock error;
4. stop the first daemon cleanly;
5. confirm a fresh `task-daemon` can start afterward without manual lock cleanup.

Optional stale-lock smoke check:

1. create a synthetic lock file with a dead PID;
2. start `task-daemon`;
3. confirm it logs stale-lock recovery and proceeds.

## Files Expected to Change

| File | Change |
|------|--------|
| `packages/daemon/task/src/services/machine-lock.ts` | New machine-wide singleton lock manager |
| `packages/daemon/task/src/services/__tests__/machine-lock.test.ts` | New unit tests for machine lock behavior |
| `packages/daemon/task/src/task-daemon.ts` | Acquire/release machine lock around startup and shutdown |
| `packages/daemon/task/src/__tests__/task-daemon.test.ts` | Add startup sequencing / duplicate-start tests |
| `packages/shared/src/constants.ts` | Add shared constant(s) for machine lock path/env name |
| `packages/shared/src/index.ts` | Re-export any new shared constant(s) |
| `packages/shared/src/__tests__/config.test.ts` | Only if config exposure changes |
| `docs/LOCAL_DEVELOPMENT.md` | Document singleton startup behavior and test/debug bypass |

## Risks and Trade-Offs

### Risk: startup cleanup gaps leave stale locks behind

Mitigation:

- ensure startup exceptions after acquisition call `release()`;
- preserve stale-PID recovery on subsequent launches.

### Risk: bypass flag leaks into normal operation

Mitigation:

- name it explicitly as disable/bypass behavior;
- document it as test/debug-only;
- log clearly when the lock is disabled.

### Trade-off: dedicated lock file instead of OS-only binding

This adds one more startup artifact on disk, but the resulting contract is easier to inspect, log, document, and test than a port-binding side effect.

## Recommendation

Proceed with a dedicated `task-daemon` machine-lock manager that acquires `/var/tmp/local-agent/task-daemon.lock` before startup, fails fast on a live competing PID, automatically recovers stale/corrupt locks, releases best-effort on shutdown, and supports a test/debug-only bypass via `TASK_DAEMON_DISABLE_MACHINE_LOCK=1`.

This is the smallest change that enforces the singleton-per-machine invariant already assumed elsewhere in the system without overloading the existing per-session lock abstraction.
