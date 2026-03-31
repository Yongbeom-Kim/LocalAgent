# Nodemon File-Watching for Dev Servers — Implementation Plan

**Goal:** Add nodemon-based auto-restart on file change to all 6 long-running dev servers, with cross-package watching of shared source.

**Architecture:** A root `nodemon.json` provides shared defaults (extension, debounce, exec). Each package's `dev` script invokes `nodemon` with `--watch` flags pointing to its own `src/` and `packages/shared/src/`. The Zellij layout gains a 4th bottom-row pane for lark-listener.

**Tech Stack:** nodemon ^3.x, ts-node (existing), Rush/pnpm (existing)

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `nodemon.json` | Root shared nodemon config |
| Modify | `packages/api/package.json` | Add nodemon devDep, update dev script |
| Modify | `packages/daemon/task/package.json` | Add nodemon devDep, update dev script |
| Modify | `packages/daemon/lark-result/package.json` | Add nodemon devDep, update dev script |
| Modify | `packages/daemon/telegram-result/package.json` | Add nodemon devDep, update dev script |
| Modify | `packages/daemon/task-enrichment/package.json` | Add nodemon devDep, update dev script |
| Modify | `packages/daemon/lark-listener/package.json` | Add nodemon devDep, update dev script |
| Modify | `zellij-dev-layout.kdl` | Add lark-listener pane to bottom row |
| Modify | `common/config/rush/pnpm-lock.yaml` | Auto-updated by `rush update` |

---

### Task 1: Create Root `nodemon.json`

**Files:**
- Create: `nodemon.json`

- [ ] **Step 1: Create `nodemon.json` at monorepo root**

```json
{
  "ext": "ts",
  "delay": 1000,
  "exec": "ts-node",
  "ignore": ["dist/", "node_modules/", "**/*.test.ts", "**/*.spec.ts"]
}
```

- [ ] **Step 2: Verify nodemon can parse the config**

Run: `cat nodemon.json | python3 -c "import sys,json; json.load(sys.stdin); print('Valid JSON')"`
Expected: `Valid JSON`

- [ ] **Step 3: Commit**

```bash
git add nodemon.json
git commit -m "feat: add root nodemon.json with shared dev-watch defaults"
```

---

### Task 2: Add nodemon to `@local-agent/api`

**Files:**
- Modify: `packages/api/package.json`

- [ ] **Step 1: Add nodemon devDependency**

In `packages/api/package.json`, add to `devDependencies`:

```json
"nodemon": "^3.1.0"
```

- [ ] **Step 2: Update the `dev` script**

In `packages/api/package.json`, change:

```json
"dev": "ts-node src/index.ts"
```

to:

```json
"dev": "nodemon --watch src --watch ../shared/src src/index.ts"
```

- [ ] **Step 3: Commit**

```bash
git add packages/api/package.json
git commit -m "feat(api): use nodemon for auto-restart in dev mode"
```

---

### Task 3: Add nodemon to `@local-agent/task-daemon`

**Files:**
- Modify: `packages/daemon/task/package.json`

- [ ] **Step 1: Add nodemon devDependency**

In `packages/daemon/task/package.json`, add to `devDependencies`:

```json
"nodemon": "^3.1.0"
```

- [ ] **Step 2: Update the `dev` script**

In `packages/daemon/task/package.json`, change:

```json
"dev": "ts-node src/task-daemon.ts"
```

to:

```json
"dev": "nodemon --watch src --watch ../../shared/src src/task-daemon.ts"
```

Note: entry file is `task-daemon.ts`, not `index.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/task/package.json
git commit -m "feat(task-daemon): use nodemon for auto-restart in dev mode"
```

---

### Task 4: Add nodemon to `@local-agent/lark-result-daemon`

**Files:**
- Modify: `packages/daemon/lark-result/package.json`

- [ ] **Step 1: Add nodemon devDependency**

In `packages/daemon/lark-result/package.json`, add to `devDependencies`:

```json
"nodemon": "^3.1.0"
```

- [ ] **Step 2: Update the `dev` script**

In `packages/daemon/lark-result/package.json`, change:

```json
"dev": "ts-node src/index.ts"
```

to:

```json
"dev": "nodemon --watch src --watch ../../shared/src src/index.ts"
```

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/lark-result/package.json
git commit -m "feat(lark-result-daemon): use nodemon for auto-restart in dev mode"
```

---

### Task 5: Add nodemon to `@local-agent/telegram-result-daemon`

**Files:**
- Modify: `packages/daemon/telegram-result/package.json`

- [ ] **Step 1: Add nodemon devDependency**

In `packages/daemon/telegram-result/package.json`, add to `devDependencies`:

```json
"nodemon": "^3.1.0"
```

- [ ] **Step 2: Update the `dev` script**

In `packages/daemon/telegram-result/package.json`, change:

```json
"dev": "ts-node src/index.ts"
```

to:

```json
"dev": "nodemon --watch src --watch ../../shared/src src/index.ts"
```

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/telegram-result/package.json
git commit -m "feat(telegram-result-daemon): use nodemon for auto-restart in dev mode"
```

---

### Task 6: Add nodemon to `@local-agent/task-enrichment-daemon`

**Files:**
- Modify: `packages/daemon/task-enrichment/package.json`

- [ ] **Step 1: Add nodemon devDependency**

In `packages/daemon/task-enrichment/package.json`, add to `devDependencies`:

```json
"nodemon": "^3.1.0"
```

- [ ] **Step 2: Update the `dev` script**

In `packages/daemon/task-enrichment/package.json`, change:

```json
"dev": "ts-node src/index.ts"
```

to:

```json
"dev": "nodemon --watch src --watch ../../shared/src src/index.ts"
```

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/task-enrichment/package.json
git commit -m "feat(task-enrichment-daemon): use nodemon for auto-restart in dev mode"
```

---

### Task 7: Add nodemon to `@local-agent/lark-listener-daemon`

**Files:**
- Modify: `packages/daemon/lark-listener/package.json`

- [ ] **Step 1: Add nodemon devDependency**

In `packages/daemon/lark-listener/package.json`, add to `devDependencies`:

```json
"nodemon": "^3.1.0"
```

- [ ] **Step 2: Update the `dev` script**

In `packages/daemon/lark-listener/package.json`, change:

```json
"dev": "ts-node src/index.ts"
```

to:

```json
"dev": "nodemon --watch src --watch ../../shared/src src/index.ts"
```

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/lark-listener/package.json
git commit -m "feat(lark-listener-daemon): use nodemon for auto-restart in dev mode"
```

---

### Task 8: Run `rush update` to install nodemon

**Files:**
- Modify: `common/config/rush/pnpm-lock.yaml` (auto-generated)

- [ ] **Step 1: Run rush update**

Run: `rush update`
Expected: Completes successfully. nodemon ^3.1.0 resolved in the lockfile for all 6 packages.

- [ ] **Step 2: Verify nodemon is accessible from one package**

Run: `cd packages/api && npx nodemon --version && cd ../..`
Expected: Prints nodemon version (e.g., `3.1.x`)

- [ ] **Step 3: Commit the lockfile**

```bash
git add common/config/rush/pnpm-lock.yaml
git commit -m "chore: rush update — add nodemon to lockfile"
```

---

### Task 9: Update Zellij Dev Layout

**Files:**
- Modify: `zellij-dev-layout.kdl:22-34`

- [ ] **Step 1: Update the bottom row pane layout**

In `zellij-dev-layout.kdl`, replace the bottom row (lines 22–34):

```kdl
        // Bottom row: notification daemons + scratch terminal
        pane split_direction="vertical" size="50%" {
            pane name="Lark" size="33%" {
                command "npm"
                args "run" "dev" "--prefix" "packages/daemon/lark-result"
            }
            pane name="Telegram" size="33%" {
                command "npm"
                args "run" "dev" "--prefix" "packages/daemon/telegram-result"
            }
            pane name="Shell" size="34%" focus=true
        }
```

with:

```kdl
        // Bottom row: notification daemons + listener + scratch terminal
        pane split_direction="vertical" size="50%" {
            pane name="Lark Result" size="25%" {
                command "npm"
                args "run" "dev" "--prefix" "packages/daemon/lark-result"
            }
            pane name="Telegram" size="25%" {
                command "npm"
                args "run" "dev" "--prefix" "packages/daemon/telegram-result"
            }
            pane name="Lark Listener" size="25%" {
                command "npm"
                args "run" "dev" "--prefix" "packages/daemon/lark-listener"
            }
            pane name="Shell" size="25%" focus=true
        }
```

Note: "Lark" pane renamed to "Lark Result" to distinguish from "Lark Listener".

- [ ] **Step 2: Commit**

```bash
git add zellij-dev-layout.kdl
git commit -m "feat: add lark-listener pane to Zellij dev layout"
```

---

### Task 10: Smoke Test

No files modified — manual verification.

- [ ] **Step 1: Test a single package with nodemon**

Run from monorepo root:

```bash
cd packages/daemon/lark-result && npm run dev
```

Expected: nodemon starts, prints `[nodemon] watching path(s) : src/**/* ../../shared/src/**/*`, then runs ts-node. (It may fail to connect to services — that's fine; we're verifying nodemon watches correctly.)

Press `Ctrl+C` to stop.

- [ ] **Step 2: Test shared file change triggers restart**

In a separate terminal while a dev server is running:

```bash
# Touch a file in shared to trigger restart
touch packages/shared/src/index.ts
```

Expected: After ~1s delay, nodemon prints `[nodemon] restarting due to changes...` and restarts the process.

- [ ] **Step 3: Test that .test.ts files are ignored**

```bash
touch packages/daemon/lark-result/src/some.test.ts
```

Expected: nodemon does NOT restart. Clean up: `rm packages/daemon/lark-result/src/some.test.ts`
