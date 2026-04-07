# Local Development Guide

Run RabbitMQ in a container, everything else on bare metal (localhost).

## Prerequisites

- Node.js 20+
- Docker
- Rush (`npm install -g @microsoft/rush` or use the local wrapper)

## 1. Install and Build

```bash
# Terminal 1 (project root)
rush install
rush build
```

## Pull Request Gate

Every GitHub pull request runs the `PR Merge Gate` workflow.

The gate executes:

- `node common/scripts/install-run-rush.js update`
- `node common/scripts/install-run-rush.js build`
- `node common/scripts/run-rush-project-tests.js`

Run the same checks locally before updating a PR when practical. If you add a new Rush project and expect it to participate in CI automatically, define a `test` script in that project's `package.json`.

## GitHub Rollout

The workflow file does not block merges by itself. Configure GitHub branch protection for the protected branch to require the merge-gate status check after the workflow lands and has appeared on at least one pull request.

In GitHub this typically appears as either `pr-merge-gate` or `PR Merge Gate / pr-merge-gate`. Enable `Require status checks to pass before merging`, then select that check from the branch protection rule.

## 2. Environment

```bash
cp .env.example .env
```

Copy `.env.example` before starting anything. Service endpoint variables are required and daemons now fail fast if they are missing:

| Variable | Default | Required |
|----------|---------|----------|
| `PORT` | `3000` | No |
| `RABBITMQ_URL` | Example: `amqp://guest:guest@localhost:5672` | Yes |
| `API_AUTH_TOKEN` | Example: `replace_me` | Yes unless `API_AUTH_DISABLED=1` |
| `API_AUTH_DISABLED` | unset | No; dev/test only |
| `API_URL` | Example: `http://localhost:3000` | Yes |
| `POLL_INTERVAL_MS` | `5000` | No |
| `TASK_DAEMON_STATUS_PORT` | `7070` | No |
| `TASK_DAEMON_DISABLE_MACHINE_LOCK` | unset | No; test/debug only |
| `TASK_DAEMON_STATUS_URL` | Example: `http://127.0.0.1:7070` | Yes for `task-enrichment` |
| `LOCAL_AGENT_DB_PATH` | Example: `/tmp/local-agent.sqlite` | Yes for `task`, `task-enrichment`, `lark-listener`, `lark-result`, `migrator` |
| `LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION` | `8` | Recommended for non-migrator services |
| `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_RECIPIENT_ID` | Provided by your Lark app | Yes for `lark-listener` and `lark-result` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_FORUM_GROUP_ID` | Provided by your Telegram bot/forum group | Yes for Telegram daemons |

## 3. Start RabbitMQ

```bash
# Terminal 1
docker compose up rabbitmq -d
```

Management UI is at http://localhost:15672 (guest / guest).

Wait until healthy:

```bash
docker compose ps   # should show "healthy"
```

**Important:** All daemons use `dotenv` and load `.env` from the current working directory. Run every command from the **project root** using `--prefix` so that the root `.env` is picked up correctly.

## 4. Run SQLite Migrations

Run this once before starting DB-backed daemons. The migrator is the only process that should upgrade schema state.

```bash
# Terminal 2 (project root)
npm run dev --prefix packages/migrator
```

## 5. Start the API Server

```bash
# Terminal 2 (project root)
npm run dev --prefix packages/api
```

Runs on http://localhost:3000. Verify with:

```bash
curl http://localhost:3000/health
```

Bearer auth is enabled by default for every API route except `/health`.

Protected-route smoke check:

```bash
curl http://localhost:3000/tasks/next \
  -H "Authorization: Bearer ${API_AUTH_TOKEN}"
```

For local debugging only, `API_AUTH_DISABLED=1` disables auth on non-health routes. Do not use that setting outside controlled dev/test workflows.

## 6. Start the Enrichment Daemon

```bash
# Terminal 3 (project root)
npm run dev --prefix packages/daemon/task-enrichment
```

Consumes from the `tasks` queue, enriches tasks, and posts them to the `jobs` queue.

## 7. Start the Task Daemon

```bash
# Terminal 4 (project root)
npm run dev --prefix packages/daemon/task
```

Polls `GET /jobs/next`, executes jobs, then ACKs them.

Only one `task-daemon` may run per machine at a time. If a second instance starts while another live `task-daemon` holds the machine lock, startup fails fast with a duplicate-lock error that includes the lock path and holder PID. Stale or corrupt lock files are recovered automatically using PID liveness checks.

`TASK_DAEMON_DISABLE_MACHINE_LOCK=1` bypasses this protection, but it is intended only for controlled tests or debugging.

## 8. Start Notification Daemons (optional)

These require credentials in `.env`.

```bash
# Terminal 5 — Lark notifications (project root)
npm run dev --prefix packages/daemon/lark-result
```

```bash
# Terminal 6 — Telegram inbound (project root)
npm run dev --prefix packages/daemon/telegram-inbound
```

```bash
# Terminal 7 — Telegram outbound (project root)
npm run dev --prefix packages/daemon/telegram-outbound
```

## 9. Start the Lark Listener (optional)

```bash
# Terminal 8 — Lark listener (project root)
npm run dev --prefix packages/daemon/lark-listener
```

## 10. Submit a Test Task

```bash
# Any terminal (project root)
npm run dev --prefix packages/cli -- submit --payload "hello world"
```

If you want to pass the token explicitly instead of relying on `.env`:

```bash
npm run dev --prefix packages/cli -- submit \
  --payload "hello world" \
  --type generic \
  --executor claude \
  --model sonnet \
  --token "$API_AUTH_TOKEN"
```

## Summary

| Terminal | Component | Command | Required |
|----------|-----------|---------|----------|
| 1 | RabbitMQ | `docker compose up rabbitmq -d` | Yes |
| 2 | Migrator | `npm run dev --prefix packages/migrator` | Yes for DB-backed services |
| 3 | API Server | `npm run dev --prefix packages/api` | Yes |
| 4 | Enrichment Daemon | `npm run dev --prefix packages/daemon/task-enrichment` | Yes |
| 5 | Task Daemon | `npm run dev --prefix packages/daemon/task` | Yes |
| 6 | Lark Result Daemon | `npm run dev --prefix packages/daemon/lark-result` | No |
| 7 | Lark Listener | `npm run dev --prefix packages/daemon/lark-listener` | No |
| 8 | Telegram Inbound | `npm run dev --prefix packages/daemon/telegram-inbound` | No |
| 9 | Telegram Outbound | `npm run dev --prefix packages/daemon/telegram-outbound` | No |

Minimum setup: Terminals 1-5.

## Schema Lifecycle

- `packages/migrator` owns schema creation and upgrades.
- DB-backed daemons open the shared SQLite file in WAL mode and assert `LOCAL_AGENT_DB_EXPECTED_SCHEMA_VERSION` on startup.
- If the schema version does not match, the service exits fast and requires the migrator to run first.
