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

## 2. Environment

```bash
cp .env.example .env
```

Copy `.env.example` before starting anything. Service endpoint variables are required and daemons now fail fast if they are missing:

| Variable | Default | Required |
|----------|---------|----------|
| `PORT` | `3000` | No |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | Yes |
| `API_URL` | `http://localhost:3000` | Yes |
| `POLL_INTERVAL_MS` | `5000` | No |
| `TASK_DAEMON_STATUS_PORT` | `7070` | No |
| `TASK_DAEMON_STATUS_URL` | `http://127.0.0.1:7070` | Yes for `task-enrichment` |
| `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_RECIPIENT_ID` | — | Yes for Lark services |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Yes for Telegram daemon |

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

## 4. Start the API Server

```bash
# Terminal 2 (project root)
npm run dev --prefix packages/api
```

Runs on http://localhost:3000. Verify with:

```bash
curl http://localhost:3000/health
```

## 5. Start the Enrichment Daemon

```bash
# Terminal 3 (project root)
npm run dev --prefix packages/daemon/task-enrichment
```

Consumes from the `tasks` queue, enriches tasks, and posts them to the `jobs` queue.

## 6. Start the Task Daemon

```bash
# Terminal 4 (project root)
npm run dev --prefix packages/daemon/task
```

Polls `GET /jobs/next`, executes jobs, then ACKs them.

## 7. Start Notification Daemons (optional)

These require credentials in `.env`.

```bash
# Terminal 5 — Lark notifications (project root)
npm run dev --prefix packages/daemon/lark-result
```

```bash
# Terminal 6 — Telegram notifications (project root)
npm run dev --prefix packages/daemon/telegram-result
```

## 8. Submit a Test Task

```bash
# Any terminal (project root)
npm run dev --prefix packages/cli -- submit --payload "hello world"
```

## Summary

| Terminal | Component | Command | Required |
|----------|-----------|---------|----------|
| 1 | RabbitMQ | `docker compose up rabbitmq -d` | Yes |
| 2 | API Server | `npm run dev --prefix packages/api` | Yes |
| 3 | Enrichment Daemon | `npm run dev --prefix packages/daemon/task-enrichment` | Yes |
| 4 | Task Daemon | `npm run dev --prefix packages/daemon/task` | Yes |
| 5 | Lark Daemon | `npm run dev --prefix packages/daemon/lark-result` | No |
| 6 | Telegram Daemon | `npm run dev --prefix packages/daemon/telegram-result` | No |

Minimum setup: Terminals 1-4.
