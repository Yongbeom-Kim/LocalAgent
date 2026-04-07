const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

export interface TelegramChatInfo {
  id: number;
  is_forum?: boolean;
  title?: string;
}

export interface TelegramTopicInfo {
  message_thread_id: number;
  name: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    message_thread_id?: number;
    from?: { id: number; is_bot?: boolean };
    sender_chat?: { id: number };
    chat: TelegramChatInfo;
    text?: string;
    caption?: string;
    photo?: Array<unknown>;
  };
}

export class TelegramTopicManager {
  private readonly apiBase: string;

  constructor(private readonly botToken: string) {
    this.apiBase = `${TELEGRAM_API_BASE}${botToken}`;
  }

  async getMe(): Promise<{ username: string; id: number }> {
    const res = await fetch(`${this.apiBase}/getMe`);
    const data = await res.json() as { ok: boolean; result?: { username: string; id: number }; description?: string };

    if (!data.ok || !data.result) {
      throw new Error(`Telegram bot validation failed: ${data.description ?? 'unknown error'}`);
    }

    return data.result;
  }

  async getChat(chatId: string): Promise<TelegramChatInfo> {
    const res = await fetch(`${this.apiBase}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    });
    const data = await res.json() as { ok: boolean; result?: TelegramChatInfo; description?: string };

    if (!data.ok || !data.result) {
      throw new Error(`Telegram getChat failed: ${data.description ?? 'unknown error'}`);
    }

    return data.result;
  }

  async createForumTopic(chatId: string, name: string): Promise<TelegramTopicInfo> {
    const res = await fetch(`${this.apiBase}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, name }),
    });
    const data = await res.json() as { ok: boolean; result?: TelegramTopicInfo; description?: string };

    if (!data.ok || !data.result) {
      throw new Error(`Telegram createForumTopic failed: ${data.description ?? 'unknown error'}`);
    }

    return data.result;
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const res = await fetch(`${this.apiBase}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeout: 0,
        ...(offset !== undefined ? { offset } : {}),
      }),
    });
    const data = await res.json() as { ok: boolean; result?: TelegramUpdate[]; description?: string };

    if (!data.ok || !Array.isArray(data.result)) {
      throw new Error(`Telegram getUpdates failed: ${data.description ?? 'unknown error'}`);
    }

    return data.result;
  }
}
