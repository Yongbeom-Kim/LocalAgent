# Design: telegram-result-daemon

**Date:** 2026-03-29
**Status:** Draft
**Approach:** Direct clone of lark-result-daemon with Telegram-specific adapter

## 1. Overview

Add a new `telegram-result-daemon` package that consumes task results from the existing RabbitMQ fanout exchange and delivers them as private Telegram messages via the Telegram Bot API. The daemon follows the same architecture as `lark-result-daemon` — polling the API for results from a dedicated queue, formatting a notification, and sending it to a single hardcoded recipient.

## 2. Motivation

The system currently broadcasts task results to a `results` fanout exchange with a single consumer (`lark-result-daemon`). Adding a Telegram consumer provides an alternative notification channel that leverages the existing fanout architecture — no changes to the result publishing flow are needed.

## 3. Design Decisions

### 3.1 Architecture: Clone lark-result-daemon

The telegram-result-daemon mirrors the lark-result-daemon 1:1 in structure:

```
packages/telegram-result-daemon/
├── src/
│   ├── index.ts                          # Entry point
│   ├── config.ts                         # TelegramDaemonConfig loader
│   ├── constants.ts                      # MAX_RETRIES, MAX_MESSAGE_CHARS
│   ├── telegram-poller.ts                # Poll API, format message, delegate, ACK
│   └── adapters/
│       └── telegram-notifier.ts          # Telegram Bot API HTTP calls
├── src/__tests__/
│   ├── config.test.ts
│   ├── telegram-notifier.test.ts
│   └── telegram-poller.test.ts
├── package.json
├── tsconfig.json
└── Dockerfile
```

**Rationale:** YAGNI. Two consumers don't justify a shared framework. Copying the pattern keeps packages independent and avoids coupling. If a third notification channel is added, extraction can happen then.

### 3.2 Queue Setup

A new `telegram-messages` queue is declared and bound to the `results` fanout exchange in the API's `RabbitMQService.connect()` method, alongside the existing `lark-messages` queue. This follows the established pattern where the API service owns queue topology.

**Changes to `packages/shared/src/constants.ts`:**
```typescript
export const DEFAULT_TELEGRAM_QUEUE_NAME = 'telegram-messages';
```

**Changes to `packages/api/src/services/rabbitmq.ts`:**
```typescript
await ch.assertQueue(DEFAULT_TELEGRAM_QUEUE_NAME, { durable: true });
await ch.bindQueue(DEFAULT_TELEGRAM_QUEUE_NAME, DEFAULT_RESULTS_EXCHANGE_NAME, '');
```

### 3.3 Telegram Bot API Integration

The daemon uses **direct HTTP calls** to the Telegram Bot API (no third-party SDK), matching the lark-notifier's pattern of minimal dependencies.

**Endpoints used:**
- `GET https://api.telegram.org/bot{token}/getMe` — Startup validation (verify bot token)
- `POST https://api.telegram.org/bot{token}/sendMessage` — Send notification

**Authentication:** Single `TELEGRAM_BOT_TOKEN` environment variable containing the bot token from BotFather.

**Recipient:** Single `TELEGRAM_CHAT_ID` environment variable containing the numeric chat ID of the recipient.

### 3.4 Message Format

Messages use **Telegram MarkdownV2** parse mode for readability:

```
*Job* `job-456` \(Task `task-123`\) — *success*
*Exit code:* `0`
*Output:*
```
Task completed successfully
```
```

**Truncation:** Output is truncated to ~3500 characters to stay within Telegram's 4096-character message limit, leaving room for metadata. A `[truncated]` indicator is appended when truncation occurs.

### 3.5 MarkdownV2 Escaping

Telegram MarkdownV2 requires escaping these characters outside of code blocks: `_ * [ ] ( ) ~ ` > # + - = | { } . !`

A dedicated `escapeMarkdownV2(text: string): string` utility function handles this. Text inside `` ` `` code blocks and ``` ``` ``` code fences is not escaped.

### 3.6 Startup Validation

On startup, the daemon calls `GET /getMe` to verify the bot token is valid. If the call fails, the daemon logs a fatal error and exits immediately (fail-fast). On success, it logs the bot's username for operator visibility.

### 3.7 Error Handling

Matches lark-notifier: retry up to 3 times on Telegram API failure, then ACK the message and log the error. This prevents poison messages from blocking the queue.

### 3.8 Configuration

```typescript
interface TelegramDaemonConfig {
  apiUrl: string;           // API_URL (default: http://localhost:3000)
  pollIntervalMs: number;   // POLL_INTERVAL_MS (default: 5000)
  logLevel: string;         // LOG_LEVEL (default: info)
  telegramBotToken: string; // TELEGRAM_BOT_TOKEN (required)
  telegramChatId: string;   // TELEGRAM_CHAT_ID (required)
}
```

### 3.9 Docker Compose

New service added to `docker-compose.yml` following the same pattern as `lark-result-daemon`:

```yaml
telegram-result-daemon:
  build:
    context: .
    dockerfile: packages/telegram-result-daemon/Dockerfile
  environment:
    API_URL: http://api:3000
    POLL_INTERVAL_MS: "5000"
    LOG_LEVEL: info
    TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
    TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID}
  depends_on:
    rabbitmq:
      condition: service_healthy
    api:
      condition: service_started
  profiles:
    - telegram-result-daemon
    - full
```

### 3.10 Rush Monorepo Registration

Add to `rush.json`:
```json
{
  "packageName": "@local-agent/telegram-result-daemon",
  "projectFolder": "packages/telegram-result-daemon"
}
```

## 4. Changes to Existing Code

| File | Change |
|------|--------|
| `packages/shared/src/constants.ts` | Add `DEFAULT_TELEGRAM_QUEUE_NAME` |
| `packages/shared/src/index.ts` | Re-export the new constant |
| `packages/api/src/services/rabbitmq.ts` | Assert + bind `telegram-messages` queue |
| `docker-compose.yml` | Add `telegram-result-daemon` service |
| `.env.example` | Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` |
| `rush.json` | Register new package |

## 5. New Package: `@local-agent/telegram-result-daemon`

### 5.1 Dependencies

```json
{
  "dependencies": {
    "@local-agent/shared": "workspace:*",
    "dotenv": "~16.4.7"
  },
  "devDependencies": {
    "typescript": "~5.7.0",
    "vitest": "~1.6.0",
    "rimraf": "~5.0.0",
    "ts-node": "~10.9.0"
  }
}
```

No Telegram-specific dependencies. Uses native `fetch` for HTTP calls.

### 5.2 Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `index.ts` | Load config, validate env vars, call `getMe`, create notifier + poller, start polling, handle SIGINT/SIGTERM |
| `config.ts` | Load `TelegramDaemonConfig` from env vars with defaults |
| `constants.ts` | `DEFAULT_TELEGRAM_MAX_RETRIES = 3`, `MAX_MESSAGE_CHARS = 3500` |
| `telegram-poller.ts` | Poll `/results/next/telegram-messages`, format MarkdownV2 message, delegate to notifier, ACK result |
| `adapters/telegram-notifier.ts` | `validate()` calls getMe, `notify(result)` calls sendMessage with retry logic |

### 5.3 Message Flow

```
results exchange (fanout)
        │
        ├── lark-messages queue ──► lark-result-daemon
        │
        └── telegram-messages queue ──► telegram-result-daemon
                                              │
                                        GET /results/next/telegram-messages
                                              │
                                        Format MarkdownV2 message
                                              │
                                        POST api.telegram.org/bot.../sendMessage
                                              │
                                        POST /results/telegram-messages/{id}/ack
```

## 6. Testing Strategy

Mirror the lark-result-daemon test suite:

- **`telegram-notifier.test.ts`**: Mock `fetch`, verify getMe validation, sendMessage calls, MarkdownV2 formatting, retry behavior (3 attempts then resolve), successful retry on second attempt
- **`telegram-poller.test.ts`**: Mock notifier + fetch, verify poll → notify → ACK flow, 204 empty queue handling, fetch error resilience
- **`config.test.ts`**: Verify env var loading with defaults

## 7. Filtering

No filtering — all results published to the fanout exchange are delivered as Telegram messages. This can be revisited if needed.

## 8. Out of Scope

- Multi-recipient support
- Message threading or reply-to
- Rich media (images, files) in notifications
- Shared notification framework / base class extraction
- Rate limiting (Telegram allows ~30 msg/s to a single chat, unlikely to be hit)
