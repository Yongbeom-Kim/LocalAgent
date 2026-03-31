import { createLogger, extractLarkMessageContent } from '@local-agent/shared';

const logger = createLogger('enrichment-daemon:thread-context');

const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
const LARK_MESSAGE_URL = (messageId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}`;
const LARK_LIST_MESSAGES_URL = 'https://open.larksuite.com/open-apis/im/v1/messages';

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

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

  async fetchThreadContext(messageId: string): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.doFetch(messageId);
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

  private async doFetch(messageId: string): Promise<string | null> {
    // Step 1: Get token and check if message is in a thread
    const token = await this.getToken();
    const threadId = await this.getThreadId(messageId, token);

    if (!threadId) {
      return null;
    }

    // Step 2: Get fresh token and fetch thread messages
    const token2 = await this.getToken();
    const messages = await this.fetchAllThreadMessages(threadId, token2);

    // Step 3: Format, excluding the current message
    const filtered = messages.filter((m) => m.message_id !== messageId);

    if (filtered.length === 0) {
      return null;
    }

    return filtered
      .map((m) => {
        const role = m.sender.sender_type === 'user' ? 'user' : 'assistant';
        const content = extractLarkMessageContent(m.msg_type, m.body.content);
        return `${role}: ${content}`;
      })
      .join('\n');
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
