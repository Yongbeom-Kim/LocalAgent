import { TaskResult, createLogger, type TaskSource } from '@local-agent/shared';
import { DEFAULT_LARK_MAX_RETRIES } from '../constants';

const logger = createLogger('lark-daemon:notifier');

const LARK_TOKEN_URL = 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal';
const LARK_MESSAGE_URL = 'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id';
const LARK_REPLY_URL = (messageId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reply`;
const LARK_REACTIONS_URL = (messageId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reactions?user_id_type=open_id`;
const LARK_DELETE_REACTION_URL = (messageId: string, reactionId: string) =>
  `https://open.larksuite.com/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`;
const MAX_SNIPPET_CHARS = 2000;
const MAX_RETRIES = DEFAULT_LARK_MAX_RETRIES;

export class LarkNotifier {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly recipientId: string,
  ) {}

  async notify(result: TaskResult): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.sendNotification(result);
        return;
      } catch (err) {
        logger.warn(
          { result_id: result.result_id, attempt, err },
          'Lark notification attempt failed',
        );
        if (attempt === MAX_RETRIES) {
          logger.error(
            { result_id: result.result_id },
            `Lark notification failed after ${MAX_RETRIES} attempts — giving up`,
          );
        }
      }
    }
  }

  private async sendNotification(result: TaskResult): Promise<void> {
    const tokenRes = await fetch(LARK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const tokenData = await tokenRes.json() as { tenant_access_token: string; code: number };

    if (tokenData.code !== 0) {
      throw new Error(`Lark token request failed with code ${tokenData.code}`);
    }

    const snippet = result.stdout.length > MAX_SNIPPET_CHARS
      ? result.stdout.substring(0, MAX_SNIPPET_CHARS)
      : result.stdout;

    const text = [
      `Job ${result.job_id} (Task ${result.task_id}) — ${result.status}`,
      `Exit code: ${result.exit_code ?? 'N/A'}`,
      snippet ? `Output:\n${snippet}` : 'No output',
    ].join('\n');

    let msgRes: Response;

    if (result.task_source?.source === 'lark') {
      // Reply in thread to the original Lark message
      msgRes = await fetch(LARK_REPLY_URL(result.task_source.message_id), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.tenant_access_token}`,
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: JSON.stringify({ text }),
          reply_in_thread: true,
        }),
      });
    } else {
      // Fallback: send DM to fixed recipient
      msgRes = await fetch(LARK_MESSAGE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.tenant_access_token}`,
        },
        body: JSON.stringify({
          receive_id: this.recipientId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      });
    }

    const msgData = await msgRes.json() as { code: number };

    if (msgData.code !== 0) {
      throw new Error(`Lark message send failed with code ${msgData.code}`);
    }

    // Clean up reactions after successful thread reply
    if (result.task_source?.source === 'lark') {
      await this.removeAllReactions(result.task_source.message_id, tokenData.tenant_access_token);
    }
  }

  /**
   * Remove all reactions on a message. Best-effort — errors are logged and swallowed.
   *
   * We attempt to delete every reaction on the message rather than filtering by
   * bot identity. Reactions not owned by the bot will fail with a permission
   * error from the Lark API, which is expected and harmless. This avoids the
   * need to fetch the bot's open_id and keeps the logic simple.
   */
  private async removeAllReactions(messageId: string, token: string): Promise<void> {
    try {
      const listRes = await fetch(LARK_REACTIONS_URL(messageId), {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      const listData = await listRes.json() as {
        code: number;
        data?: { items?: { reaction_id: string }[] };
      };

      if (listData.code !== 0) {
        logger.warn({ messageId, code: listData.code }, 'Failed to list reactions');
        return;
      }

      const items = listData.data?.items ?? [];
      if (items.length === 0) return;

      for (const item of items) {
        try {
          const delRes = await fetch(LARK_DELETE_REACTION_URL(messageId, item.reaction_id), {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
          });
          const delData = await delRes.json() as { code: number };
          if (delData.code !== 0) {
            logger.debug(
              { messageId, reactionId: item.reaction_id, code: delData.code },
              'Failed to delete reaction (may not be owned by bot)',
            );
          }
        } catch (err) {
          logger.warn(
            { messageId, reactionId: item.reaction_id, err },
            'Error deleting reaction',
          );
        }
      }
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to remove reactions (best-effort)');
    }
  }
}
