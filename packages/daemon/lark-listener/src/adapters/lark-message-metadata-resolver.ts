import { createLogger } from '@local-agent/shared';
import { LARK_TOKEN_URL, LARK_REACTION_URL_PREFIX } from '../constants';

const logger = createLogger('lark-listener:message-metadata-resolver');

export interface ResolvedThreadIdentity {
  rootMessageId: string;
  threadId: string | null;
}

export interface LarkMessageMetadataResolver {
  resolve(messageId: string): Promise<ResolvedThreadIdentity>;
}

interface LarkGetMessageItem {
  message_id: string;
  root_id?: string;
  thread_id?: string;
}

export class LarkOpenApiMessageMetadataResolver implements LarkMessageMetadataResolver {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  async resolve(messageId: string): Promise<ResolvedThreadIdentity> {
    try {
      const token = await this.fetchTenantToken();
      const response = await fetch(`${LARK_REACTION_URL_PREFIX}/${messageId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error(`Lark getMessage request failed with HTTP status ${response.status}`);
      }

      const data = (await response.json()) as {
        code: number;
        msg?: string;
        data?: { items?: LarkGetMessageItem[] };
      };

      if (data.code !== 0) {
        throw new Error(`Lark getMessage request failed with code ${data.code}: ${data.msg ?? 'unknown error'}`);
      }

      const item = data.data?.items?.[0];
      if (!item) {
        throw new Error(`Lark getMessage response for ${messageId} had no items`);
      }

      const rootMessageId = item.root_id && item.root_id.length > 0 ? item.root_id : item.message_id;
      const threadId = item.thread_id && item.thread_id.length > 0 ? item.thread_id : null;

      return {
        rootMessageId,
        threadId,
      };
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to resolve thread metadata from Lark, falling back to root=messageId');
      return {
        rootMessageId: messageId,
        threadId: null,
      };
    }
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

