import { createLogger, extractLarkMessageContent } from '@local-agent/shared';

const logger = createLogger('enrichment-daemon:thread-context');

const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
const LARK_MESSAGE_URL = (messageId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}`;
const LARK_LIST_MESSAGES_URL = 'https://open.larksuite.com/open-apis/im/v1/messages';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

const NEW_INSTANCE_MARKER = 'New session instance started.';

const TASK_TYPE_REGEX = /^task_type: ([a-zA-Z0-9_-]+)$/m;
const TASK_TYPE_LINE_REGEX = /^task_type: [a-zA-Z0-9_-]+\n?/m;
const UUID_V7_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SESSION_ID_REGEX = new RegExp(`^session_id: (${UUID_V7_PATTERN})$`, 'm');
const SESSION_ID_LINE_REGEX = new RegExp(`^session_id: ${UUID_V7_PATTERN}\\n?`, 'm');

export interface ThreadContextResult {
  threadContext: string | null;
  inheritedTaskType: string | null;
  inheritedSessionId: string | null;
}

interface LarkMessage {
  message_id: string;
  sender: { sender_type: string };
  msg_type: string;
  body: { content: string };
}

export class ThreadContextFetcher {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  async fetchThreadContext(messageId: string, validTaskTypes?: Set<string>): Promise<ThreadContextResult | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.doFetch(messageId, validTaskTypes);
      } catch (err) {
        logger.warn({ messageId, attempt, err }, 'Thread context fetch attempt failed');
        if (attempt < MAX_RETRIES) {
          await this.sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1));
        }
      }
    }
    logger.warn({ messageId }, `Thread context fetch failed after ${MAX_RETRIES} retries — proceeding without context`);
    return null;
  }

  private async doFetch(messageId: string, validTaskTypes?: Set<string>): Promise<ThreadContextResult | null> {
    // Step 1: Get token and check if message is in a thread
    const token = await this.getToken();
    const threadId = await this.getThreadId(messageId, token);

    if (!threadId) {
      return null;
    }

    // Step 2: Get fresh token and fetch thread messages
    const token2 = await this.getToken();
    const messages = await this.fetchAllThreadMessages(threadId, token2);

    // Step 3: Extract task_type from first valid bot message
    let inheritedTaskType: string | null = null;
    if (validTaskTypes && validTaskTypes.size > 0) {
      for (const m of messages) {
        if (m.sender.sender_type === 'user') continue;
        const content = extractLarkMessageContent(m.msg_type, m.body.content);
        const match = content.match(TASK_TYPE_REGEX);
        if (match && validTaskTypes.has(match[1])) {
          inheritedTaskType = match[1];
          break;
        }
      }
    }

    let inheritedSessionId: string | null = null;
    for (const m of messages) {
      if (m.sender.sender_type === 'user') continue;
      const content = extractLarkMessageContent(m.msg_type, m.body.content);
      const match = content.match(SESSION_ID_REGEX);
      if (match) {
        inheritedSessionId = match[1];
        break;
      }
    }

    // Step 4: Apply /new fence for thread context, then format
    const fencedMessages = this.applyNewInstanceFence(messages);
    const filtered = fencedMessages.filter((m) => m.message_id !== messageId);

    if (filtered.length === 0) {
      return { threadContext: null, inheritedTaskType, inheritedSessionId };
    }

    const threadContext = filtered
      .map((m) => {
        const role = m.sender.sender_type === 'user' ? 'user' : 'assistant';
        let content = extractLarkMessageContent(m.msg_type, m.body.content);
        content = content.replace(TASK_TYPE_LINE_REGEX, '');
        content = content.replace(SESSION_ID_LINE_REGEX, '');
        return `${role}: ${content}`;
      })
      .join('\n');

    return { threadContext: threadContext || null, inheritedTaskType, inheritedSessionId };
  }

  private async getToken(): Promise<string> {
    const res = await fetch(LARK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    if (!res.ok) {
      throw new Error(`Lark token request failed with HTTP status ${res.status}`);
    }
    const data = (await res.json()) as { tenant_access_token: string; code: number };
    if (data.code !== 0) {
      throw new Error(`Lark token request failed with code ${data.code}`);
    }
    return data.tenant_access_token;
  }

  private async getThreadId(messageId: string, token: string): Promise<string | null> {
    const res = await fetch(LARK_MESSAGE_URL(messageId), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as {
      code: number;
      data: { items: Array<{ message_id: string; root_id?: string; thread_id?: string }> };
    };
    if (data.code !== 0) {
      throw new Error(`Lark getMessage failed with code ${data.code}`);
    }
    const msg = data.data.items[0];
    // Not in a thread if no root_id or message is the thread root itself
    if (!msg?.root_id || msg.root_id === messageId) {
      return null;
    }
    // thread_id (format: omt_xxx) is the correct container_id for listing thread messages
    if (!msg.thread_id) {
      throw new Error(`Message ${messageId} has root_id but no thread_id`);
    }
    return msg.thread_id;
  }

  private async fetchAllThreadMessages(threadId: string, token: string): Promise<LarkMessage[]> {
    const allMessages: LarkMessage[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(LARK_LIST_MESSAGES_URL);
      url.searchParams.set('container_id_type', 'thread');
      url.searchParams.set('container_id', threadId);
      url.searchParams.set('sort_type', 'ByCreateTimeAsc');
      if (pageToken) {
        url.searchParams.set('page_token', pageToken);
      }

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as {
        code: number;
        data: { items: LarkMessage[]; has_more?: boolean; page_token?: string };
      };
      if (data.code !== 0) {
        throw new Error(`Lark listMessages failed with code ${data.code}`);
      }

      allMessages.push(...data.data.items);
      pageToken = data.data.has_more ? data.data.page_token : undefined;
    } while (pageToken);

    return allMessages;
  }

  private applyNewInstanceFence(messages: LarkMessage[]): LarkMessage[] {
    let fenceIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.sender.sender_type === 'user') continue;
      const content = extractLarkMessageContent(m.msg_type, m.body.content);
      if (content.includes(NEW_INSTANCE_MARKER)) {
        fenceIndex = i;
        break;
      }
    }

    if (fenceIndex === -1) {
      return messages;
    }

    return messages.slice(fenceIndex);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
