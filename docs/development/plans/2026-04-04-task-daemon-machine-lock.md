# Task-Daemon Machine Lock Implementation Plan

**Goal:** Enforce that only one `task-daemon` process may run per machine at a time, with stale-lock recovery, fail-fast duplicate startup, and a test/debug-only bypass flag.

**Architecture:** Add a dedicated machine-lock service for `task-daemon` startup ownership using an exclusive-create lock file at `/var/tmp/local-agent/task-daemon.lock`. Wire acquisition ahead of status-server and poller startup, release the lock during shutdown and startup-failure cleanup, and document the singleton contract in local development docs.

**Tech Stack:** TypeScript, Node.js fs/path/process APIs, Vitest, existing LocalAgent shared constants/logger/config patterns.

---

## File Map

| File | Responsibility |
|------|----------------|
| `packages/daemon/task/src/services/machine-lock.ts` | Own machine-wide singleton lock acquisition, stale/corrupt lock recovery, bypass behavior, and best-effort release |
| `packages/daemon/task/src/services/__tests__/machine-lock.test.ts` | Verify machine lock behavior with temp lock paths and mocked PID liveness |
| `packages/daemon/task/src/task-daemon.ts` | Acquire machine lock before startup, fail fast on duplicate holder, release on shutdown/startup failure |
| `packages/daemon/task/src/__tests__/task-daemon.test.ts` | Verify startup sequencing and cleanup without spawning a full daemon process |
| `packages/shared/src/constants.ts` | Define canonical machine-lock path and disable-env-name constants |
| `packages/shared/src/index.ts` | Re-export new shared constants |
| `docs/LOCAL_DEVELOPMENT.md` | Explain singleton startup behavior, stale-lock recovery, and test/debug bypass flag |

### Task 1: Add shared machine-lock constants

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add shared constants**

In `packages/shared/src/constants.ts`, add these exports near the existing task-daemon constants:

```ts
export const DEFAULT_TASK_DAEMON_MACHINE_LOCK_PATH = '/var/tmp/local-agent/task-daemon.lock';
export const TASK_DAEMON_MACHINE_LOCK_DISABLE_ENV = 'TASK_DAEMON_DISABLE_MACHINE_LOCK';
```

Then re-export them from `packages/shared/src/index.ts` with the other constants.

- [ ] **Step 2: Verify shared compiles**

Run: `pnpm --filter @local-agent/shared exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/index.ts
git commit -m "feat(shared): add task-daemon machine lock constants"
```

### Task 2: Implement the machine-lock manager

**Files:**
- Create: `packages/daemon/task/src/services/machine-lock.ts`
- Test: `packages/daemon/task/src/services/__tests__/machine-lock.test.ts`

- [ ] **Step 1: Write the failing machine-lock tests**

Create `packages/daemon/task/src/services/__tests__/machine-lock.test.ts` with a temp lock directory and targeted coverage for:

```ts
it('acquires when no lock file exists', () => {
  const manager = new MachineLockManager({ lockPath, env: {} });
  expect(manager.acquire()).toEqual({ acquired: true });
});

it('returns duplicate-start failure for a live foreign pid', () => {
  // seed lock file with another pid and mock process.kill(pid, 0) => alive
  expect(manager.acquire()).toEqual({ acquired: false, holderPid: otherPid, lockPath });
});

it('overwrites stale lock files when pid is dead', () => {
  expect(manager.acquire()).toEqual({ acquired: true });
  expect(readBack.pid).toBe(process.pid);
});

it('overwrites corrupt lock files', () => {
  writeFileSync(lockPath, 'not-json');
  expect(manager.acquire()).toEqual({ acquired: true });
});

it('is idempotent for the same pid', () => {
  expect(manager.acquire()).toEqual({ acquired: true });
  expect(manager.acquire()).toEqual({ acquired: true });
});

it('bypasses lock operations when TASK_DAEMON_DISABLE_MACHINE_LOCK=1', () => {
  const manager = new MachineLockManager({
    lockPath,
    env: { TASK_DAEMON_DISABLE_MACHINE_LOCK: '1' },
  });
  expect(manager.acquire()).toEqual({ acquired: true });
  expect(existsSync(lockPath)).toBe(false);
});
```

Also add release coverage:

- enabled release removes the lock file;
- bypassed release does not create or delete files;
- `acquire()` does not use naive check-then-write semantics. Do not unit-test system call internals directly; instead, structure tests around visible behavior and keep a comment noting that the implementation must use exclusive create.

Also add a directory-creation regression test:

```ts
it('creates the parent directory when missing', () => {
  const nestedLockPath = join(tmpDir, 'nested', 'task-daemon.lock');
  const manager = new MachineLockManager({ lockPath: nestedLockPath, env: {} });
  expect(manager.acquire()).toEqual({ acquired: true });
  expect(existsSync(nestedLockPath)).toBe(true);
});
```

- [ ] **Step 2: Run the focused machine-lock test file to verify failure**

Run: `pnpm --filter @local-agent/task-daemon test -- --run src/services/__tests__/machine-lock.test.ts`
Expected: FAIL because `machine-lock.ts` does not exist yet.

- [ ] **Step 3: Write the minimal machine-lock implementation**

Create `packages/daemon/task/src/services/machine-lock.ts` with:

```ts
interface MachineLockManagerOptions {
  lockPath?: string;
  env?: Record<string, string | undefined>;
}

type AcquireResult =
  | { acquired: true }
  | { acquired: false; holderPid: number; lockPath: string };

export class MachineLockManager {
  constructor(private readonly options: MachineLockManagerOptions = {}) {}

  acquire(): AcquireResult { /* exclusive create + stale/corrupt recovery */ }
  release(): void { /* best-effort unlink when enabled */ }
}
```

Implementation requirements:

- default lock path uses `DEFAULT_TASK_DAEMON_MACHINE_LOCK_PATH`;
- disable flag uses `TASK_DAEMON_MACHINE_LOCK_DISABLE_ENV`;
- ensure the parent directory for the lock path exists (`mkdirSync(dirname(lockPath), { recursive: true })`) before attempting `openSync(..., 'wx')`;
- use `openSync(lockPath, 'wx')` for first-write acquisition;
- on `EEXIST`, inspect the existing file and decide live/stale/corrupt behavior;
- when replacing a stale/corrupt file, remove it and retry exclusive create rather than downgrading to unconditional overwrite;
- use the same PID liveness semantics as `SessionLockManager` (`EPERM` alive, `ESRCH` dead);
- keep logging scoped to `task-daemon:machine-lock`.

- [ ] **Step 4: Re-run the focused machine-lock tests**

Run: `pnpm --filter @local-agent/task-daemon test -- --run src/services/__tests__/machine-lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/task/src/services/machine-lock.ts packages/daemon/task/src/services/__tests__/machine-lock.test.ts
git commit -m "feat(task-daemon): add machine-wide startup lock"
```

### Task 3: Wire machine-lock acquisition and cleanup into `task-daemon` startup

**Files:**
- Modify: `packages/daemon/task/src/task-daemon.ts`
- Test: `packages/daemon/task/src/__tests__/task-daemon.test.ts`

- [ ] **Step 1: Write the failing startup-sequencing tests**

Expand `packages/daemon/task/src/__tests__/task-daemon.test.ts` so it still covers `createStatusServer()` and also verifies startup sequencing through a small extracted helper. Recommended tests:

```ts
it('does not start status server or poller when machine lock is already held', async () => {
  const machineLock = { acquire: vi.fn().mockReturnValue({ acquired: false, holderPid: 4321, lockPath }), release: vi.fn() };
  await expect(startTaskDaemon({ machineLock, ...deps })).rejects.toThrow(/only one task-daemon/i);
  expect(fakeServer.listen).not.toHaveBeenCalled();
  expect(fakePoller.start).not.toHaveBeenCalled();
});

it('releases machine lock if startup fails after acquisition', async () => {
  const machineLock = { acquire: vi.fn().mockReturnValue({ acquired: true }), release: vi.fn() };
  // Simulate a bind failure by having the fake server emit an error after listen is invoked.
  fakeServer.listen.mockImplementationOnce(() => {
    queueMicrotask(() => fakeServer.emit('error', new Error('bind failed')));
    return fakeServer;
  });
  await expect(startTaskDaemon({ machineLock, ...deps })).rejects.toThrow(/bind failed/);
  expect(machineLock.release).toHaveBeenCalledTimes(1);
});
```

Keep the existing `createStatusServer()` tests intact.

- [ ] **Step 2: Run the focused task-daemon test file to verify failure**

Run: `pnpm --filter @local-agent/task-daemon test -- --run src/__tests__/task-daemon.test.ts`
Expected: FAIL because the startup helper / new behavior is not implemented yet.

- [ ] **Step 3: Refactor `task-daemon.ts` for testable startup orchestration**

Update `packages/daemon/task/src/task-daemon.ts` to extract a small orchestration helper, for example:

```ts
export async function startTaskDaemon(deps?: Partial<StartTaskDaemonDeps>): Promise<RunningTaskDaemon> {
  // acquire machine lock
  // start status server
  // start poller
  // return shutdown handle
}
```

Then have `main()` call that helper and register signal handlers around the returned shutdown function.

To keep tests simple and deterministic, prefer dependency injection over mocking Node internals. Recommended dependency surface for the helper:

```ts
type StartTaskDaemonDeps = {
  machineLock: Pick<MachineLockManager, 'acquire' | 'release'>;
  createStatusServer: typeof createStatusServer;
  createPoller: (args: { apiUrl: string; orchestrator: TaskOrchestrator; sessionLock: SessionLockManager; maxConcurrency: number }) => Pick<TaskPoller, 'start' | 'drain' | 'isSessionActive'>;
  loadDaemonConfig: typeof loadDaemonConfig;
};
```

In tests, provide a fake `Server` (EventEmitter) whose `listen()` can trigger an `error` event, and a fake poller with `start()`/`drain()` spies.

Implementation requirements:

- acquire machine lock before `createStatusServer()` / `statusServer.listen()` / `poller.start()`;
- if `acquire()` returns duplicate holder info, throw a clear error and let the top-level `main()` exit with code `1`;
- if any later startup step throws after lock acquisition, call `machineLock.release()` before rethrowing;
- normal shutdown should close the status server, drain the poller, then call `machineLock.release()` best-effort;
- avoid double-release bugs by tracking whether shutdown already ran.

- [ ] **Step 4: Re-run the focused task-daemon test file**

Run: `pnpm --filter @local-agent/task-daemon test -- --run src/__tests__/task-daemon.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing session-lock regression suite**

Run: `pnpm --filter @local-agent/task-daemon test -- --run src/services/__tests__/session-lock.test.ts`
Expected: PASS, confirming the startup lock work did not regress per-session locking.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/task/src/task-daemon.ts packages/daemon/task/src/__tests__/task-daemon.test.ts
git commit -m "feat(task-daemon): enforce singleton startup lock"
```

### Task 4: Document local-development singleton behavior

**Files:**
- Modify: `docs/LOCAL_DEVELOPMENT.md`

- [ ] **Step 1: Add the runtime documentation changes**

Update `docs/LOCAL_DEVELOPMENT.md` so the task-daemon section and env table state:

- only one `task-daemon` may run per machine at a time;
- duplicate startup fails fast with a lock-holder error;
- stale/corrupt lock files are recovered automatically via PID liveness checks;
- `TASK_DAEMON_DISABLE_MACHINE_LOCK=1` is a test/debug-only escape hatch.

Add this env-row content to the existing table:

```md
| `TASK_DAEMON_DISABLE_MACHINE_LOCK` | unset | No; test/debug only |
```

Do not suggest it for normal operations.

- [ ] **Step 2: Review the markdown for wording and consistency**

Run: `sed -n '1,220p' docs/LOCAL_DEVELOPMENT.md`
Expected: the singleton behavior is explicit in the task-daemon section and env table.

- [ ] **Step 3: Commit**

```bash
git add docs/LOCAL_DEVELOPMENT.md
git commit -m "docs: describe task-daemon machine lock behavior"
```

### Task 5: Run final focused verification and smoke-check commands

**Files:**
- Test: `packages/daemon/task/src/services/__tests__/machine-lock.test.ts`
- Test: `packages/daemon/task/src/__tests__/task-daemon.test.ts`
- Test: `packages/daemon/task/src/services/__tests__/session-lock.test.ts`
- Test: `packages/shared/src/__tests__/config.test.ts` if touched

- [ ] **Step 1: Run the focused automated test set**

Run:

```bash
pnpm --filter @local-agent/shared exec tsc --noEmit
pnpm --filter @local-agent/task-daemon test -- --run src/services/__tests__/machine-lock.test.ts src/__tests__/task-daemon.test.ts src/services/__tests__/session-lock.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the optional manual duplicate-start smoke test**

From the repo root, in separate terminals if available:

```bash
npm run dev --prefix packages/api
npm run dev --prefix packages/daemon/task
npm run dev --prefix packages/daemon/task
```

Expected: the second `task-daemon` exits immediately with a clear duplicate-lock error mentioning the lock path and holder PID.

- [ ] **Step 3: Run the optional stale-lock smoke test**

Seed a stale lock using a dead PID, then start the daemon:

```bash
printf '{"pid":999999,"locked_at":"2026-04-04T00:00:00.000Z"}' > /var/tmp/local-agent/task-daemon.lock
npm run dev --prefix packages/daemon/task
```

Expected: startup logs stale-lock recovery and continues.

- [ ] **Step 4: Create the final integration commit**

If you have already committed per task, skip this. Otherwise, commit the whole change:

```bash
git add packages/shared/src/constants.ts packages/shared/src/index.ts packages/daemon/task/src/services/machine-lock.ts packages/daemon/task/src/services/__tests__/machine-lock.test.ts packages/daemon/task/src/task-daemon.ts packages/daemon/task/src/__tests__/task-daemon.test.ts docs/LOCAL_DEVELOPMENT.md
git commit -m "feat(task-daemon): add machine-wide singleton startup lock"
```

## Notes for the Implementer

- Keep machine-lock logic separate from `SessionLockManager`; do not retrofit session abstractions for startup ownership.
- Prefer a constructor-level lock-path override for tests rather than mocking global constants everywhere.
- If you extract a startup helper from `task-daemon.ts`, keep it small and purpose-built for orchestration/testing.
- If the shared config loader remains unchanged, do not force artificial config-surface expansion just to route one task-daemon-only env var through it.
