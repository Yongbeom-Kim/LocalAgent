# Daemon Directory Reorganization Implementation Plan

**Goal:** Move all 4 daemon packages from `packages/<name>-daemon/` to `packages/daemon/<name>/` in a single atomic commit.

**Architecture:** Filesystem reorganization only — `git mv` directories, update all path references in rush.json, docker-compose.yml, 5 Dockerfiles, and 4 tsconfig.json files, then regenerate the lockfile.

**Tech Stack:** Rush monorepo, pnpm, TypeScript, Docker

---

### Path Mapping Reference

| Package Name | Old Directory | New Directory |
|---|---|---|
| `@local-agent/task-daemon` | `packages/task-daemon` | `packages/daemon/task` |
| `@local-agent/lark-result-daemon` | `packages/lark-result-daemon` | `packages/daemon/lark-result` |
| `@local-agent/task-enrichment-daemon` | `packages/task-enrichment-daemon` | `packages/daemon/task-enrichment` |
| `@local-agent/telegram-result-daemon` | `packages/telegram-result-daemon` | `packages/daemon/telegram-result` |

### File Structure

All files listed below are modifications to existing files. No new files are created.

- Modify: `rush.json` — update 4 `projectFolder` entries
- Modify: `docker-compose.yml` — update 4 `dockerfile:` paths
- Modify: `packages/daemon/task/Dockerfile` (moved from `packages/task-daemon/Dockerfile`)
- Modify: `packages/daemon/lark-result/Dockerfile` (moved from `packages/lark-result-daemon/Dockerfile`)
- Modify: `packages/daemon/task-enrichment/Dockerfile` (moved from `packages/task-enrichment-daemon/Dockerfile`)
- Modify: `packages/daemon/telegram-result/Dockerfile` (moved from `packages/telegram-result-daemon/Dockerfile`)
- Modify: `packages/api/Dockerfile` — update daemon package.json COPY paths
- Modify: `packages/daemon/task/tsconfig.json` (moved from `packages/task-daemon/tsconfig.json`)
- Modify: `packages/daemon/lark-result/tsconfig.json` (moved from `packages/lark-result-daemon/tsconfig.json`)
- Modify: `packages/daemon/task-enrichment/tsconfig.json` (moved from `packages/task-enrichment-daemon/tsconfig.json`)
- Modify: `packages/daemon/telegram-result/tsconfig.json` (moved from `packages/telegram-result-daemon/tsconfig.json`)
- Regenerated: `common/config/rush/pnpm-lock.yaml`

---

### Task 1: Create daemon directory and git mv all 4 packages

**Files:**
- Create directory: `packages/daemon/`
- Move: `packages/task-daemon/` → `packages/daemon/task/`
- Move: `packages/lark-result-daemon/` → `packages/daemon/lark-result/`
- Move: `packages/task-enrichment-daemon/` → `packages/daemon/task-enrichment/`
- Move: `packages/telegram-result-daemon/` → `packages/daemon/telegram-result/`

- [ ] **Step 1: Create the parent directory**

```bash
mkdir -p packages/daemon
```

- [ ] **Step 2: git mv all 4 daemon directories**

```bash
git mv packages/task-daemon packages/daemon/task
git mv packages/lark-result-daemon packages/daemon/lark-result
git mv packages/task-enrichment-daemon packages/daemon/task-enrichment
git mv packages/telegram-result-daemon packages/daemon/telegram-result
```

- [ ] **Step 3: Verify the move**

Run: `ls packages/daemon/`
Expected: `lark-result  task  task-enrichment  telegram-result`

Run: `ls packages/`
Expected: `api  cli  daemon  shared` (no more `*-daemon` directories)

---

### Task 2: Update rush.json project paths

**Files:**
- Modify: `rush.json:19-33`

- [ ] **Step 1: Update all 4 projectFolder entries**

Change each `projectFolder` to the new path:

```json
{
  "packageName": "@local-agent/task-daemon",
  "projectFolder": "packages/daemon/task"
},
{
  "packageName": "@local-agent/lark-result-daemon",
  "projectFolder": "packages/daemon/lark-result"
},
{
  "packageName": "@local-agent/telegram-result-daemon",
  "projectFolder": "packages/daemon/telegram-result"
},
{
  "packageName": "@local-agent/task-enrichment-daemon",
  "projectFolder": "packages/daemon/task-enrichment"
}
```

- [ ] **Step 2: Verify rush.json is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('rush.json','utf8')); console.log('OK')"`
Expected: `OK`

---

### Task 3: Update all 4 daemon tsconfig.json files

**Files:**
- Modify: `packages/daemon/task/tsconfig.json`
- Modify: `packages/daemon/lark-result/tsconfig.json`
- Modify: `packages/daemon/task-enrichment/tsconfig.json`
- Modify: `packages/daemon/telegram-result/tsconfig.json`

- [ ] **Step 1: Update extends path in all 4 files**

In each file, change:
```json
"extends": "../../tsconfig.base.json"
```
to:
```json
"extends": "../../../tsconfig.base.json"
```

The 4 files are:
- `packages/daemon/task/tsconfig.json`
- `packages/daemon/lark-result/tsconfig.json`
- `packages/daemon/task-enrichment/tsconfig.json`
- `packages/daemon/telegram-result/tsconfig.json`

Note: `packages/daemon/telegram-result/tsconfig.json` has an extra `"lib": ["ES2022", "dom"]` — keep that unchanged.

- [ ] **Step 2: Verify the extends path resolves**

Run: `ls packages/daemon/task/../../../tsconfig.base.json`
Expected: `tsconfig.base.json`

---

### Task 4: Update docker-compose.yml

**Files:**
- Modify: `docker-compose.yml:37,57,77,94`

- [ ] **Step 1: Update all 4 dockerfile paths**

| Service | Old `dockerfile:` | New `dockerfile:` |
|---|---|---|
| `task-daemon` (line 37) | `packages/task-daemon/Dockerfile` | `packages/daemon/task/Dockerfile` |
| `lark-result-daemon` (line 57) | `packages/lark-result-daemon/Dockerfile` | `packages/daemon/lark-result/Dockerfile` |
| `task-enrichment-daemon` (line 77) | `packages/task-enrichment-daemon/Dockerfile` | `packages/daemon/task-enrichment/Dockerfile` |
| `telegram-result-daemon` (line 94) | `packages/telegram-result-daemon/Dockerfile` | `packages/daemon/telegram-result/Dockerfile` |

---

### Task 5: Update task-daemon Dockerfile

**Files:**
- Modify: `packages/daemon/task/Dockerfile`

- [ ] **Step 1: Update all daemon path references**

Apply these replacements throughout the file:

| Line(s) | Old Path | New Path |
|---|---|---|
| 11 | `packages/task-daemon/package.json` | `packages/daemon/task/package.json` |
| 13 | `packages/lark-result-daemon/package.json` | `packages/daemon/lark-result/package.json` |
| 14 | `packages/cli/package.json` | `packages/cli/package.json` (unchanged) |
| 21 | `packages/task-daemon/` | `packages/daemon/task/` |
| 24 | `cd packages/task-daemon` | `cd packages/daemon/task` |
| 36 | `packages/task-daemon/package.json` | `packages/daemon/task/package.json` |
| 37 | `packages/task-daemon/dist/` | `packages/daemon/task/dist/` |
| 38 | `packages/task-daemon/node_modules/` | `packages/daemon/task/node_modules/` |
| 41 | `WORKDIR /app/packages/task-daemon` | `WORKDIR /app/packages/daemon/task` |

The full updated Dockerfile:

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/daemon/task/package.json packages/daemon/task/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/daemon/lark-result/package.json packages/daemon/lark-result/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/task-daemon

COPY packages/shared/ packages/shared/
COPY packages/daemon/task/ packages/daemon/task/

RUN cd packages/shared && npx tsc
RUN cd packages/daemon/task && npx tsc

FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/daemon/task/package.json packages/daemon/task/package.json
COPY --from=builder /app/packages/daemon/task/dist/ packages/daemon/task/dist/
COPY --from=builder /app/packages/daemon/task/node_modules/ packages/daemon/task/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/daemon/task

CMD ["node", "dist/task-daemon.js"]
```

---

### Task 6: Update lark-result-daemon Dockerfile

**Files:**
- Modify: `packages/daemon/lark-result/Dockerfile`

- [ ] **Step 1: Update all daemon path references**

The full updated Dockerfile:

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/daemon/lark-result/package.json packages/daemon/lark-result/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/daemon/task/package.json packages/daemon/task/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/lark-result-daemon

COPY packages/shared/ packages/shared/
COPY packages/daemon/lark-result/ packages/daemon/lark-result/

RUN cd packages/shared && npx tsc
RUN cd packages/daemon/lark-result && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/daemon/lark-result/package.json packages/daemon/lark-result/package.json
COPY --from=builder /app/packages/daemon/lark-result/dist/ packages/daemon/lark-result/dist/
COPY --from=builder /app/packages/daemon/lark-result/node_modules/ packages/daemon/lark-result/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/daemon/lark-result

CMD ["node", "dist/index.js"]
```

---

### Task 7: Update task-enrichment-daemon Dockerfile

**Files:**
- Modify: `packages/daemon/task-enrichment/Dockerfile`

- [ ] **Step 1: Update all daemon path references**

The full updated Dockerfile:

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/daemon/task/package.json packages/daemon/task/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/daemon/lark-result/package.json packages/daemon/lark-result/package.json
COPY packages/daemon/task-enrichment/package.json packages/daemon/task-enrichment/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/task-enrichment-daemon

COPY packages/shared/ packages/shared/
COPY packages/daemon/task-enrichment/ packages/daemon/task-enrichment/

RUN cd packages/shared && npx tsc
RUN cd packages/daemon/task-enrichment && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/daemon/task-enrichment/package.json packages/daemon/task-enrichment/package.json
COPY --from=builder /app/packages/daemon/task-enrichment/dist/ packages/daemon/task-enrichment/dist/
COPY --from=builder /app/packages/daemon/task-enrichment/config/ packages/daemon/task-enrichment/config/
COPY --from=builder /app/packages/daemon/task-enrichment/node_modules/ packages/daemon/task-enrichment/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/daemon/task-enrichment

CMD ["node", "dist/index.js"]
```

---

### Task 8: Update telegram-result-daemon Dockerfile

**Files:**
- Modify: `packages/daemon/telegram-result/Dockerfile`

- [ ] **Step 1: Update all daemon path references**

The full updated Dockerfile:

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

COPY rush.json .
COPY tsconfig.base.json .
COPY common/ common/

# Rush requires all project manifests
COPY packages/shared/package.json packages/shared/package.json
COPY packages/daemon/telegram-result/package.json packages/daemon/telegram-result/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/daemon/task/package.json packages/daemon/task/package.json
COPY packages/daemon/lark-result/package.json packages/daemon/lark-result/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/daemon/task-enrichment/package.json packages/daemon/task-enrichment/package.json

RUN npm install -g @microsoft/rush@5.172.1
RUN rm -rf common/temp/pnpm-store common/temp/node_modules common/temp/install-run common/temp/rush-recycler common/temp/last-install.flag
RUN rush install --to @local-agent/telegram-result-daemon

COPY packages/shared/ packages/shared/
COPY packages/daemon/telegram-result/ packages/daemon/telegram-result/

RUN cd packages/shared && npx tsc
RUN cd packages/daemon/telegram-result && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/rush.json .
COPY --from=builder /app/common/ common/
COPY --from=builder /app/packages/shared/package.json packages/shared/package.json
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/daemon/telegram-result/package.json packages/daemon/telegram-result/package.json
COPY --from=builder /app/packages/daemon/telegram-result/dist/ packages/daemon/telegram-result/dist/
COPY --from=builder /app/packages/daemon/telegram-result/node_modules/ packages/daemon/telegram-result/node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/

WORKDIR /app/packages/daemon/telegram-result

CMD ["node", "dist/index.js"]
```

---

### Task 9: Update api Dockerfile

**Files:**
- Modify: `packages/api/Dockerfile:13-14`

- [ ] **Step 1: Update daemon package.json COPY paths**

The api Dockerfile copies daemon package.json files for Rush workspace resolution. Update lines 13-14:

Old:
```dockerfile
COPY packages/task-daemon/package.json packages/task-daemon/package.json
COPY packages/lark-result-daemon/package.json packages/lark-result-daemon/package.json
```

New:
```dockerfile
COPY packages/daemon/task/package.json packages/daemon/task/package.json
COPY packages/daemon/lark-result/package.json packages/daemon/lark-result/package.json
```

Note: The api Dockerfile does not currently reference `task-enrichment-daemon` or `telegram-result-daemon`. Those were added to rush.json after the api Dockerfile was last updated. This is a pre-existing issue — do not fix it in this task (out of scope).

---

### Task 10: Run rush update and verify

**Files:**
- Regenerated: `common/config/rush/pnpm-lock.yaml`

- [ ] **Step 1: Run rush update to regenerate lockfile**

Run: `rush update`
Expected: Completes successfully, regenerates `common/config/rush/pnpm-lock.yaml`

- [ ] **Step 2: Run rush build for all packages**

Run: `rush build`
Expected: All packages build successfully (exit code 0)

- [ ] **Step 3: Run rush test for all daemon packages**

Run the test suite for each daemon:

```bash
cd packages/daemon/task && npx vitest run && cd ../../..
cd packages/daemon/lark-result && npx vitest run && cd ../../..
cd packages/daemon/task-enrichment && npx vitest run && cd ../../..
cd packages/daemon/telegram-result && npx vitest run && cd ../../..
```

Expected: All tests pass.

- [ ] **Step 4: Grep for any remaining old paths**

Run: `grep -r "packages/task-daemon\|packages/lark-result-daemon\|packages/task-enrichment-daemon\|packages/telegram-result-daemon" --include="*.json" --include="*.yml" --include="*.yaml" --include="Dockerfile" .`

Expected: No matches (only hits should be in `pnpm-lock.yaml` if any, and in `docs/` which are historical).

---

### Task 11: Commit

- [ ] **Step 1: Stage all changes**

```bash
git add rush.json docker-compose.yml packages/api/Dockerfile
git add packages/daemon/
```

Note: `git mv` already staged the renames in Task 1. This adds the content modifications and any new files.

- [ ] **Step 2: Stage the regenerated lockfile**

```bash
git add common/config/rush/pnpm-lock.yaml
```

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor: move daemon packages to packages/daemon/*

Move all 4 daemon packages into a packages/daemon/ subdirectory:
- packages/task-daemon → packages/daemon/task
- packages/lark-result-daemon → packages/daemon/lark-result
- packages/task-enrichment-daemon → packages/daemon/task-enrichment
- packages/telegram-result-daemon → packages/daemon/telegram-result

Update rush.json, docker-compose.yml, all Dockerfiles, and
tsconfig.json extends paths. Package names unchanged."
```

- [ ] **Step 4: Verify clean state**

Run: `git status`
Expected: `nothing to commit, working tree clean`
