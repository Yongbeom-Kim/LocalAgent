import { TaskResult, createLogger } from '@local-agent/shared';
import { DEFAULT_TELEGRAM_MAX_RETRIES, MAX_MESSAGE_CHARS } from '../constants';

const logger = createLogger('telegram-daemon:notifier');

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';
const MAX_RETRIES = DEFAULT_TELEGRAM_MAX_RETRIES;

// MarkdownV2 special chars that must be escaped outside code blocks
const MARKDOWNV2_ESCAPE_REGEX = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWNV2_ESCAPE_REGEX, '\\$1');
}

export class TelegramNotifier {
  private readonly apiBase: string;

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {
    this.apiBase = `${TELEGRAM_API_BASE}${botToken}`;
  }

  async validate(): Promise<string> {
    const res = await fetch(`${this.apiBase}/getMe`);
    const data = await res.json() as { ok: boolean; result?: { username: string }; description?: string };

    if (!data.ok) {
      throw new Error(`Telegram bot validation failed: ${data.description ?? 'unknown error'}`);
    }

    return data.result!.username;
  }

  async notify(result: TaskResult): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.sendMessage(result);
        return;
      } catch (err) {
        logger.warn(
          { result_id: result.result_id, attempt, err },
          'Telegram notification attempt failed',
        );
        if (attempt === MAX_RETRIES) {
          logger.error(
            { result_id: result.result_id },
            `Telegram notification failed after ${MAX_RETRIES} attempts — giving up`,
          );
        }
      }
    }
  }

  private async sendMessage(result: TaskResult): Promise<void> {
    const text = this.formatMessage(result);

    const res = await fetch(`${this.apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: 'MarkdownV2',
      }),
    });

    const data = await res.json() as { ok: boolean; description?: string };

    if (!data.ok) {
      throw new Error(`Telegram sendMessage failed: ${data.description ?? 'unknown error'}`);
    }
  }

  private formatMessage(result: TaskResult): string {
    // Only escape text outside code spans/blocks — inline code renders literally
    const status = escapeMarkdownV2(result.status);
    const exitCode = result.exit_code?.toString() ?? 'N/A';

    let outputSection: string;
    if (!result.stdout && !result.stderr) {
      outputSection = '_No output_';
    } else {
      let snippet = result.stdout || result.stderr;
      let truncated = false;
      if (snippet.length > MAX_MESSAGE_CHARS) {
        snippet = snippet.substring(0, MAX_MESSAGE_CHARS);
        truncated = true;
      }
      // Code blocks don't need escaping in MarkdownV2
      outputSection = '```\n' + snippet + (truncated ? '\n[truncated]' : '') + '\n```';
    }

    return [
      `*Job* \`${result.job_id}\` \\(Task \`${result.task_id}\`\\) — *${status}*`,
      `*Exit code:* \`${exitCode}\``,
      `*Output:*`,
      outputSection,
    ].join('\n');
  }
}
