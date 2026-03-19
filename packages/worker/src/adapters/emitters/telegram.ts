import type { EmitterPort } from "../../ports/emitter.js";
import type { ResultMessage } from "@localagent/shared";

const TELEGRAM_MAX_LENGTH = 4096;

export class TelegramEmitter implements EmitterPort {
  readonly outputType = "telegram";
  constructor(private botToken: string) {}

  async emit(result: ResultMessage): Promise<void> {
    const chatId = (result.outputMeta as { chatId: string }).chatId;
    const prefix = result.status === "ok" ? "" : "[ERROR] ";
    const text = `${prefix}Task ${result.taskId}:\n\n${result.output}`;

    const chunks = this.chunk(text, TELEGRAM_MAX_LENGTH);
    for (const chunk of chunks) {
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      });
      if (!res.ok) throw new Error(`Telegram API error: ${res.status}`);
    }
  }

  private chunk(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
    return chunks;
  }
}
