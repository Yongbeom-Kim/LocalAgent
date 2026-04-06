const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

export interface TelegramCreatedTopic {
  message_thread_id: number;
  name: string;
}

export class TelegramTopicCreator {
  private readonly apiBase: string;

  constructor(private readonly botToken: string) {
    this.apiBase = `${TELEGRAM_API_BASE}${botToken}`;
  }

  async createForumTopic(chatId: string, name: string): Promise<TelegramCreatedTopic> {
    const res = await fetch(`${this.apiBase}/createForumTopic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, name }),
    });
    const data = await res.json() as { ok: boolean; result?: TelegramCreatedTopic; description?: string };

    if (!data.ok || !data.result) {
      throw new Error(`Telegram createForumTopic failed: ${data.description ?? 'unknown error'}`);
    }

    return data.result;
  }
}
