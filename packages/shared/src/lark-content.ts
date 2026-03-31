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
