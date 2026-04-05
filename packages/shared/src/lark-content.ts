/**
 * Extracts a human-readable string from a Lark message based on its type.
 * Used by ThreadContextFetcher (all types) and MessageHandler (text type only).
 */
export function extractLarkMessageContent(msgType: string, content: string): string {
  if (msgType === 'text') {
    return extractText(content);
  }

  try {
    const parsed = JSON.parse(content);
    switch (msgType) {
      case 'image':
        return `[Image: ${parsed.image_key}]`;
      case 'file':
        return `[File: ${parsed.file_name}]`;
      case 'audio':
        return '[Audio message]';
      case 'post':
        return extractPostText(parsed);
      default:
        return `[${msgType} message]`;
    }
  } catch {
    return `[${msgType} message]`;
  }
}

const NORMALIZABLE_LARK_MESSAGE_TYPES = ['text', 'post'] as const;
export type NormalizableLarkMessageType = (typeof NORMALIZABLE_LARK_MESSAGE_TYPES)[number];

export function isLarkMessageTypeNormalizable(messageType: string): messageType is NormalizableLarkMessageType {
  return (NORMALIZABLE_LARK_MESSAGE_TYPES as readonly string[]).includes(messageType);
}

export type LarkInboundContentNormalization =
  | { is_normalizable: true; normalized_text: string }
  | { is_normalizable: false };

// Listener-facing helper: this intentionally does not encode downstream policy about whether
// placeholders like "[Image: ...]" should be accepted; it only distinguishes types that
// produce a reliable human-usable normalized text.
export function normalizeLarkInboundContent(
  messageType: string,
  rawContent: string,
): LarkInboundContentNormalization {
  if (!isLarkMessageTypeNormalizable(messageType)) {
    return { is_normalizable: false };
  }

  return { is_normalizable: true, normalized_text: extractLarkMessageContent(messageType, rawContent) };
}

function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return parsed.text ?? content;
  } catch {
    return content;
  }
}

function extractPostText(parsed: Record<string, unknown>): string {
  const contentArray = parsed.content;
  if (!Array.isArray(contentArray)) return '';

  return contentArray
    .map((paragraph: unknown[]) => {
      if (!Array.isArray(paragraph)) return '';
      return paragraph
        .filter((el: any) => typeof el.text === 'string')
        .map((el: any) => el.text)
        .join(' ')
        .replace(/\s+/g, ' ');
    })
    .filter(Boolean)
    .join('\n');
}
