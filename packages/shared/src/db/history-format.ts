import { extractLarkMessageContent } from '../lark-content';
import type { LarkMessageRow } from './lark-history-repository';
import type { TelegramMessageRow } from './telegram-history-repository';

const TASK_TYPE_LINE_REGEX = /^task_type: [^\n]+\n?/gim;
const SESSION_ID_LINE_REGEX = /^session_id: [^\n]+\n?/gim;
const EXECUTOR_LINE_REGEX = /^executor: [^\n]+\n?/gim;
const MODEL_LINE_REGEX = /^model: [^\n]+\n?/gim;

export function formatLarkPromptHistory(rows: LarkMessageRow[]): string {
  const lines: string[] = [];

  for (const row of rows) {
    const role = resolveRole(row.direction, row.senderType);
    if (role === null) {
      continue;
    }

    const text = getMessageText(row);
    if (!text) {
      continue;
    }

    const cleanedText = role === 'assistant' ? stripOutboundMetadataHeaders(text) : text;
    const normalized = cleanedText.trim();
    if (!normalized) {
      continue;
    }

    lines.push(`${role}: ${normalized}`);
  }

  return lines.join('\n');
}

export function formatTelegramPromptHistory(rows: TelegramMessageRow[]): string {
  const lines: string[] = [];

  for (const row of rows) {
    const role = resolveRole(row.direction, row.senderType);
    if (role === null) {
      continue;
    }

    const text = getTelegramMessageText(row).trim();
    if (!text) {
      continue;
    }

    const cleanedText = role === 'assistant' ? stripOutboundMetadataHeaders(text) : text;
    const normalized = cleanedText.trim();
    if (!normalized) {
      continue;
    }

    lines.push(`${role}: ${normalized}`);
  }

  return lines.join('\n');
}

function resolveRole(direction: string, senderType: string): 'user' | 'assistant' | null {
  if (direction === 'inbound' && senderType === 'user') {
    return 'user';
  }

  if (direction === 'outbound' && senderType === 'bot') {
    return 'assistant';
  }

  return null;
}

function getMessageText(row: LarkMessageRow): string {
  if (row.normalizedText && row.normalizedText.trim().length > 0) {
    return row.normalizedText;
  }

  if (row.rawContent.trim().length === 0) {
    return '';
  }

  const extracted = extractLarkMessageContent(row.messageType, row.rawContent);
  if (extracted.trim().length > 0) {
    return extracted;
  }

  return row.rawContent;
}

function getTelegramMessageText(row: TelegramMessageRow): string {
  if (row.normalizedText && row.normalizedText.trim().length > 0) {
    return row.normalizedText;
  }

  return row.rawContent.trim().length > 0 ? row.rawContent : '';
}

function stripOutboundMetadataHeaders(text: string): string {
  return text
    .replace(TASK_TYPE_LINE_REGEX, '')
    .replace(SESSION_ID_LINE_REGEX, '')
    .replace(EXECUTOR_LINE_REGEX, '')
    .replace(MODEL_LINE_REGEX, '')
    .trim();
}
