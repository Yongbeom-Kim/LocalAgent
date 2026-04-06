import { describe, expect, it } from 'vitest';
import { normalizeTelegramInboundContent } from '../telegram-content';

describe('normalizeTelegramInboundContent', () => {
  it('normalizes plain telegram text messages', () => {
    expect(normalizeTelegramInboundContent('text', 'hello telegram')).toEqual({
      is_normalizable: true,
      normalized_text: 'hello telegram',
    });
  });

  it('rejects non-text telegram messages as non-normalizable', () => {
    expect(normalizeTelegramInboundContent('photo', 'caption')).toEqual({
      is_normalizable: false,
    });
  });
});
