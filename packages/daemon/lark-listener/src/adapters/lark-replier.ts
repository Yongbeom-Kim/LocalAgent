import { createLogger } from '@local-agent/shared';
import { LARK_TOKEN_URL, LARK_REACTION_URL_PREFIX } from '../constants';

const logger = createLogger('lark-listener:replier');

export interface LarkReplyResult {
  messageId: string;
  messageType: 'text';
  rawContent: string;
  normalizedText: string;
  createdAtMs: number;
}

export class LarkReplier {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  /**
   * Reply to a message in-thread. Best-effort — errors are logged and swallowed.
   */
  async reply(messageId: string, text: string): Promise<LarkReplyResult | null> {
    try {
      const token = await this.fetchTenantToken();
      const createdAtMs = Date.now();
      const rawContent = JSON.stringify({ text });

      const res = await fetch(`${LARK_REACTION_URL_PREFIX}/${messageId}/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: rawContent,
          reply_in_thread: true,
        }),
      });

      const data = (await res.json()) as {
        code: number;
        msg?: string;
        data?: { message_id?: string };
      };
      if (data.code !== 0) {
        logger.warn({ messageId, code: data.code, msg: data.msg }, 'Reply API returned non-zero code');
        return null;
      }

      return {
        messageId: data.data?.message_id ?? '',
        messageType: 'text',
        rawContent,
        normalizedText: text,
        createdAtMs,
      };
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to reply (best-effort)');
      return null;
    }
  }

  /**
   * Generic helper for enqueue failures.
   */
  async replyEnqueueFailure(messageId: string): Promise<LarkReplyResult | null> {
    return this.reply(messageId, 'Failed to enqueue task. Please try again.');
  }

  private async fetchTenantToken(): Promise<string> {
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
}
