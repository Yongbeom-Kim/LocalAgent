# Design: Lark Listener Daemon

**Date:** 2026-03-31
**Status:** Draft
**Package:** `packages/daemon/lark-listener`

## Problem

Users currently submit tasks only via CLI (`packages/cli`) or HTTP API. There is no way to submit tasks by sending a Lark message to the bot. Adding a Lark listener daemon enables task submission via natural language messages in Lark — both DMs and @mentions in group chats.

## Solution Overview

A new daemon (`lark-listener`) that connects to Lark via WebSocket (using the official `@larksuiteoapi/node-sdk`), listens for incoming messages, and enqueues them as `generic` tasks by POSTing to the existing `POST /tasks` API endpoint.

### Architecture

```
                                        +-----------------+
  Lark User (DM or @mention)           |  lark-listener  |
  ─────────────────────────────────>    |  daemon         |
       WebSocket push                   |                 |
       (im.message.receive_v1)          |  1. Parse msg   |
                                        |  2. Build JSON  |
                                        |  3. POST /tasks |
                                        |  4. React OnIt  |
                                        +--------+--------+
                                                 |
                                                 v
                                        +--------+--------+
                                        |   Existing API  |
                                        |  POST /tasks    |
                                        +-----------------+
                                                 |
                                                 v
                                        (existing pipeline:
                                         enrichment -> job
                                         -> execution
                                         -> result notification)
```

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Transport | Lark WebSocket (long connection) | No public URL needed; SDK handles reconnection |
| SDK | `@larksuiteoapi/node-sdk` | Official SDK; handles WebSocket, decryption, reconnection |
| Message sources | DM + @mentions in groups | Covers both use cases via `im.message.receive_v1` |
| Message types | All types (text, image, file, rich text, etc.) | Future-proof; non-text encoded as JSON payload |
| Task type | Fixed `"generic"` | Matches existing convention; simplest, no parsing logic needed |
| Acknowledgment | "OnIt" emoji reaction on source message | Lightweight, non-intrusive confirmation |
| Payload format (text) | Raw message text as-is (including @bot placeholders) | User preference; no stripping |
| Payload format (non-text) | JSON: `{ "type": "<msg_type>", "key": "<file_key>", "text": "<caption>" }` | Structured for executor consumption |
| Deduplication | In-memory TTL map of message_ids | Handles WebSocket reconnection duplicates |
| API failure | Retry with exponential backoff (3 attempts) + error log | Resilient without local queue complexity |
| Bot message filtering | None | Accept all messages including from bots |
| Credentials | Reuse `LARK_APP_ID`, `LARK_APP_SECRET` from `.env` | Same bot app, different function |
| Result routing | Out of scope | lark-result daemon unchanged |

## Detailed Design

### 1. Package Structure

```
packages/daemon/lark-listener/
  src/
    index.ts                  # Bootstrap: load config, create WSClient, start
    config.ts                 # Load LARK_APP_ID, LARK_APP_SECRET, API_URL from env
    message-handler.ts        # Core logic: parse event, build TaskSubmission, POST /tasks
    adapters/
      lark-ws-client.ts       # Wrapper around SDK WSClient + EventDispatcher setup
      lark-reactor.ts         # Adds "OnIt" reaction to a message via Lark API
      task-submitter.ts       # POST /tasks with retry logic
    services/
      dedup.ts                # In-memory TTL dedup map
  __tests__/
    message-handler.test.ts
    dedup.test.ts
    task-submitter.test.ts
  package.json
  tsconfig.json
  Dockerfile
```

### 2. Entry Point (`index.ts`)

```typescript
// Pseudocode
loadEnvFromRoot();
const config = loadLarkListenerConfig();
const logger = createLogger('lark-listener', config.logLevel);
const submitter = new TaskSubmitter(config.apiUrl, logger);
const reactor = new LarkReactor(config.appId, config.appSecret, logger);
const dedup = new DedupMap(/* ttlMs: 300_000 */);
const handler = new MessageHandler(submitter, reactor, dedup, logger);
const wsClient = createLarkWsClient(config, handler, logger);
// Graceful shutdown on SIGINT/SIGTERM
```

### 3. Message Handler (`message-handler.ts`)

Receives `im.message.receive_v1` events and:

1. **Dedup check** — skip if `message_id` already seen
2. **Build payload**:
   - If `message_type === "text"`: payload = `JSON.parse(content).text`
   - Otherwise: payload = `JSON.stringify({ type: message_type, key: extractKey(content), text: extractText(content) })`
3. **Submit task** — `POST /tasks` with `{ task_type: "generic", payload }`
4. **React** — Add "OnIt" emoji to the message via `POST /im/v1/messages/{message_id}/reactions`
5. **Log** — Log task_id on success, error on failure

### 4. Task Submitter (`task-submitter.ts`)

- `POST /tasks` with `{ task_type: "generic", payload }`
- Retry with exponential backoff: delays of 1s, 2s, 4s (3 attempts max)
- On final failure: log error, do not react with emoji (or react with error emoji)

### 5. Lark Reactor (`lark-reactor.ts`)

- Fetches `tenant_access_token` using `LARK_APP_ID` / `LARK_APP_SECRET` (same pattern as lark-result daemon's `LarkNotifier`)
- `POST https://open.larksuite.com/open-apis/im/v1/messages/{message_id}/reactions` with `{ reaction_type: { emoji_type: "OnIt" } }`
- Best-effort: log and swallow errors (reaction failure should not block task enqueue)

### 6. Dedup Map (`dedup.ts`)

- `Map<string, number>` mapping `message_id → timestamp`
- `has(id)` / `add(id)` methods
- Periodic cleanup (every 60s) removes entries older than TTL (5 minutes)
- Bounded: if map exceeds 10,000 entries, evict oldest

### 7. WebSocket Client Wrapper (`lark-ws-client.ts`)

```typescript
import * as lark from '@larksuiteoapi/node-sdk';

export function createLarkWsClient(config, handler, logger) {
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': (data) => handler.handle(data),
  });

  const client = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  client.start({ eventDispatcher: dispatcher });
  return client;
}
```

### 8. Configuration (`config.ts`)

| Env Var | Default | Description |
|---------|---------|-------------|
| `LARK_APP_ID` | (required) | Lark bot app ID |
| `LARK_APP_SECRET` | (required) | Lark bot app secret |
| `API_URL` | `http://localhost:3000` | LocalAgent API base URL |
| `LOG_LEVEL` | `info` | Pino log level |
| `DEDUP_TTL_MS` | `300000` | Dedup window (5 min) |

### 9. Non-Text Message Payload Examples

| Message Type | Payload |
|-------------|---------|
| `text` | `"fix the CI pipeline"` (plain string) |
| `image` | `{"type":"image","key":"img_v3_xxxx"}` |
| `file` | `{"type":"file","key":"file_v3_xxxx","name":"report.pdf"}` |
| `post` (rich text) | `{"type":"post","content":<raw post JSON>}` |
| `audio` | `{"type":"audio","key":"file_v3_xxxx"}` |

### 10. Docker Compose Addition

Add to `docker-compose.yml` under the `full` profile:

```yaml
lark-listener:
  build:
    context: .
    dockerfile: packages/daemon/lark-listener/Dockerfile
  environment:
    - LARK_APP_ID=${LARK_APP_ID}
    - LARK_APP_SECRET=${LARK_APP_SECRET}
    - API_URL=http://api:3000
    - LOG_LEVEL=${LOG_LEVEL:-info}
  depends_on:
    api:
      condition: service_healthy
  profiles:
    - full
  restart: unless-stopped
```

### 11. Zellij Layout Addition

Add a "Lark Listener" pane to the bottom row in `zellij-dev-layout.kdl`, adjusting the existing pane sizes to accommodate 4 panes instead of 3.

### 12. Rush Configuration

Add the new package to `rush.json` in the `projects` array:

```json
{
  "packageName": "@local-agent/lark-listener",
  "projectFolder": "packages/daemon/lark-listener"
}
```

## Testing Strategy

- **Unit tests** with mocked SDK — mock `WSClient`, `EventDispatcher`, and HTTP calls
- **`message-handler.test.ts`**: Test text extraction, non-text JSON building, dedup skipping, error handling
- **`task-submitter.test.ts`**: Test retry logic, exponential backoff, success/failure paths
- **`dedup.test.ts`**: Test TTL expiry, max size eviction, duplicate detection

## Out of Scope

- Routing task results back to the original Lark sender
- Parsing `task_type` from message text
- Stripping @bot mentions from payload
- Allowlist/denylist of users
- Extending the lark-result daemon

## Dependencies

- New npm dependency: `@larksuiteoapi/node-sdk`
- Existing: `@local-agent/shared` (types, config, logger, constants)
- Lark Developer Console: must enable WebSocket event subscription and subscribe to `im.message.receive_v1`
