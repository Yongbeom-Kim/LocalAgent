# Design: Nodemon File-Watching for Dev Servers

**Date:** 2026-03-31  
**Status:** Draft  
**Scope:** Dev-only change — production startup untouched

## Problem

All dev servers (`npm run dev`) use plain `ts-node src/index.ts` with no file watching. When source files change, developers must manually restart each daemon. This is tedious, especially with 6+ long-running services in the Zellij dev layout.

## Decision Summary

| Decision | Choice |
|----------|--------|
| Tool | nodemon |
| Packages affected | 6 long-running services (api + 5 daemons); cli excluded |
| Config location | Root `nodemon.json` for shared settings; per-package `--watch` CLI flags |
| Watch scope | Each package watches own `src/` + `packages/shared/src/` |
| Extensions | `.ts` only |
| Debounce | 1 second delay |
| Dependency | Per-package devDependency via `rush add` |
| Zellij layout | Add lark-listener pane to bottom row |
| Shared package | No separate `tsc --watch`; consumers watch shared/src directly via ts-node |
| Production | No changes |

## Design

### 1. Root `nodemon.json`

A single config file at the monorepo root provides shared defaults:

```json
{
  "ext": "ts",
  "delay": 1000,
  "exec": "ts-node",
  "ignore": ["dist/", "node_modules/", "**/*.test.ts", "**/*.spec.ts"]
}
```

- **`ext`**: Only `.ts` files trigger restarts.
- **`delay`**: 1000ms debounce prevents rapid cascading restarts.
- **`exec`**: Uses `ts-node` to run TypeScript directly (same as current dev scripts).
- **`ignore`**: Excludes build output, dependencies, and test files.

### 2. Per-Package Dev Scripts

Each package's `dev` script invokes `nodemon` with explicit `--watch` flags pointing to its own source and the shared package source. The entry file is passed as the final argument.

**Packages at `packages/<name>/` (2 levels deep):**

| Package | Dev Script |
|---------|-----------|
| `api` | `nodemon --watch src --watch ../shared/src src/index.ts` |

Relative path to shared: `../shared/src`

**Packages at `packages/daemon/<name>/` (3 levels deep):**

| Package | Dev Script |
|---------|-----------|
| `task` | `nodemon --watch src --watch ../../shared/src src/task-daemon.ts` |
| `lark-result` | `nodemon --watch src --watch ../../shared/src src/index.ts` |
| `telegram-result` | `nodemon --watch src --watch ../../shared/src src/index.ts` |
| `task-enrichment` | `nodemon --watch src --watch ../../shared/src src/index.ts` |
| `lark-listener` | `nodemon --watch src --watch ../../shared/src src/index.ts` |

Relative path to shared: `../../shared/src`

**Excluded:**
- `cli` — not a long-running service; retains plain `ts-node` dev script.
- `shared` — no dev script needed; watched by consumers.

### 3. How It Works

1. Developer runs `npm run dev` in a package (or Zellij launches it).
2. Nodemon starts, reads root `nodemon.json` for defaults.
3. CLI `--watch` flags override the watch paths to include own `src/` and `shared/src/`.
4. Nodemon spawns `ts-node <entry-file>`.
5. On any `.ts` file change in watched directories, nodemon waits 1s then sends SIGUSR2 (its default restart signal) to the child process, then respawns.
6. ts-node re-resolves all imports fresh on each restart, picking up shared changes.

### 4. Nodemon Config Resolution

Nodemon resolves config by walking up from CWD to find the nearest `nodemon.json`. Since each package's CWD is `packages/<name>/` or `packages/daemon/<name>/`, and no per-package `nodemon.json` exists, nodemon finds the root config. CLI flags (`--watch`, entry file) merge with/override the JSON config.

### 5. Zellij Layout Update

Current bottom row (3 panes):
```
| Lark Result (33%) | Telegram Result (33%) | Shell (34%) |
```

Updated bottom row (4 panes):
```
| Lark Result (25%) | Telegram Result (25%) | Lark Listener (25%) | Shell (25%) |
```

The new `Lark Listener` pane runs `npm run dev --prefix packages/daemon/lark-listener`.

### 6. Dependency Installation

nodemon is added as a **devDependency to each package that uses it** (api + 5 daemons). In each package directory:

```bash
cd packages/api
rush add -p nodemon --dev
# Repeat for each daemon package
```

Alternatively, manually add `"nodemon": "^3.x"` to each package's `devDependencies` in `package.json`, then run `rush update` once. Since all 6 packages need the same version, the pnpm lockfile will deduplicate it.

## Alternatives Considered

### Per-Package `nodemon.json`
Each package gets its own config file with tailored `watch` arrays. Rejected because it duplicates settings across 6 packages — any change to delay, extensions, or ignore patterns requires editing all files.

### Root Config + Helper Shell Script
A `scripts/dev-watch.sh` script computes relative paths to shared dynamically. Rejected because it adds indirection and complexity for minimal benefit over explicit `--watch` flags.

### tsx watch (replacing ts-node)
`tsx` uses esbuild for faster TypeScript execution and has built-in `--watch` mode. Rejected because it would be a larger change (replacing the TypeScript runtime for all packages), and nodemon is the user's explicit preference.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| nodemon doesn't find root config from nested CWD | Verified: nodemon walks up directory tree to find `nodemon.json` |
| Rapid restarts overwhelm RabbitMQ/API connections | 1s debounce + daemons already have reconnection logic |
| Shared changes restart all 6 services simultaneously | Acceptable for dev; 1s debounce helps stagger slightly |
| ts-node startup is slow | Existing behavior; not in scope to address (tsx would help but was out of scope) |

## Out of Scope

- Hot module replacement (HMR)
- Production Dockerfile changes
- Shared package `tsc --watch`
- CLI package file watching
- Root-level orchestration script (alternative to Zellij)
- Colored log prefixes per daemon
