export type TelegramInboundContentNormalization =
  | { is_normalizable: true; normalized_text: string }
  | { is_normalizable: false };

const NORMALIZABLE_TELEGRAM_MESSAGE_TYPES = ['text'] as const;

export type NormalizableTelegramMessageType = (typeof NORMALIZABLE_TELEGRAM_MESSAGE_TYPES)[number];

export function isTelegramMessageTypeNormalizable(
  messageType: string,
): messageType is NormalizableTelegramMessageType {
  return (NORMALIZABLE_TELEGRAM_MESSAGE_TYPES as readonly string[]).includes(messageType);
}

export function normalizeTelegramInboundContent(
  messageType: string,
  rawContent: string,
): TelegramInboundContentNormalization {
  if (!isTelegramMessageTypeNormalizable(messageType)) {
    return { is_normalizable: false };
  }

  return {
    is_normalizable: true,
    normalized_text: rawContent,
  };
}
