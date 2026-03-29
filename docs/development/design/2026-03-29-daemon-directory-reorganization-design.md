# Design: Daemon Directory Reorganization

**Date:** 2026-03-29
**Status:** Draft
**Approach:** Atomic big-bang move with `git mv`

## 1. Overview

Reorganize all daemon packages from `packages/<name>-daemon/` to `packages/daemon/<name>/`, grouping them under a shared `daemon/` directory. Package names (`@local-agent/*-daemon`) remain unchanged — only the filesystem layout changes.

## 2. Motivation

The monorepo currently has 7 packages at the top level of `packages/`:

```
packages/
├── api/
├── cli/
├── shared/
├── lark-result-daemon/
├── task-daemon/
├── task-enrichment-daemon/
└── telegram-result-daemon/
```

As daemon count grows, the flat structure becomes harder to navigate. Grouping daemons under `packages/daemon/` clarifies which packages are long-running background services versus libraries or entry points.

## 3. Design Decisions

### 3.1 Target Layout

```
packages/
├── api/
├── cli/
├── shared/
└── daemon/
    ├── task/                    (was: packages/task-daemon/)
    ├── lark-result/             (was: packages/lark-result-daemon/)
    ├── task-enrichment/         (was: packages/task-enrichment-daemon/)
    └── telegram-result/         (was: packages/telegram-result-daemon/)
```

Directory names strip the `-daemon` suffix since the parent directory already communicates that. Package names remain unchanged:
- `@local-agent/task-daemon`
- `@local-agent/lark-result-daemon`
- `@local-agent/task-enrichment-daemon`
- `@local-agent/telegram-result-daemon`

### 3.2 Approach: Atomic Single Commit

All 4 daemons are moved in a single commit alongside all reference updates. This avoids intermediate broken states where some paths point to old locations and some to new.

**Alternatives considered:**
- **Sequential per-daemon** (4 commits): Smaller diffs but Dockerfiles cross-reference other packages, creating messy intermediate states.
- **Two-phase** (move then fix): Separates move from reference updates but creates a broken intermediate commit.

### 3.3 Files Requiring Updates

#### 3.3.1 rush.json

Update `projectFolder` for all 4 daemons:

| Package | Old | New |
|---------|-----|-----|
| `@local-agent/task-daemon` | `packages/task-daemon` | `packages/daemon/task` |
| `@local-agent/lark-result-daemon` | `packages/lark-result-daemon` | `packages/daemon/lark-result` |
| `@local-agent/task-enrichment-daemon` | `packages/task-enrichment-daemon` | `packages/daemon/task-enrichment` |
| `@local-agent/telegram-result-daemon` | `packages/telegram-result-daemon` | `packages/daemon/telegram-result` |

#### 3.3.2 docker-compose.yml

Update `dockerfile:` paths for all 4 daemon services:
- `packages/task-daemon/Dockerfile` → `packages/daemon/task/Dockerfile`
- `packages/lark-result-daemon/Dockerfile` → `packages/daemon/lark-result/Dockerfile`
- `packages/task-enrichment-daemon/Dockerfile` → `packages/daemon/task-enrichment/Dockerfile`
- `packages/telegram-result-daemon/Dockerfile` → `packages/daemon/telegram-result/Dockerfile`

#### 3.3.3 Dockerfiles (5 files)

Each daemon Dockerfile contains `COPY` instructions with `packages/<name>/` paths. All references to daemon package paths must be updated. References to non-daemon packages (`packages/shared/`, `packages/api/`, `packages/cli/`) remain unchanged.

Key path changes inside each daemon Dockerfile:
- `COPY packages/<old-name>/ ...` → `COPY packages/daemon/<new-name>/ ...`
- `COPY --from=builder /app/packages/<old-name>/ ...` → `COPY --from=builder /app/packages/daemon/<new-name>/ ...`
- `WORKDIR /app/packages/<old-name>` → `WORKDIR /app/packages/daemon/<new-name>`

Cross-references between daemons also need updating: each Dockerfile copies package.json files of other daemon packages for Rush dependency resolution.

Additionally, `packages/api/Dockerfile` copies daemon `package.json` files for Rush workspace resolution (e.g., `COPY packages/task-daemon/package.json ...`). These references must also be updated to the new paths.

#### 3.3.4 tsconfig.json (4 files)

The `extends` field changes from `../../tsconfig.base.json` to `../../../tsconfig.base.json` since daemons move one directory deeper.

#### 3.3.5 pnpm-lock.yaml

Regenerated automatically by `rush update` after `rush.json` changes. Not manually edited.

### 3.4 What Does NOT Change

- Package names in `package.json` (`@local-agent/*-daemon`)
- Source code within each daemon (no import path changes — daemons only import from `@local-agent/shared`)
- Non-daemon packages (`api`, `cli`, `shared`) stay in place
- Docker service names in `docker-compose.yml`
- Environment variables and volumes

## 4. Verification

After the move:
1. `rush update` — regenerate lockfile
2. `rush build` — verify TypeScript compilation for all packages
3. `rush test` — run all test suites (unit tests use vitest, no path-dependent configuration)

## 5. Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Missed path reference | Low | Grep for old paths after move; single commit makes it easy to spot |
| `git mv` loses history | Low | Git tracks renames when content similarity is high (>50%); no content changes in this PR |
| Rush workspace resolution breaks | Low | `rush update` will fail immediately if paths are wrong |
