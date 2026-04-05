import { describe, it, expect } from 'vitest';
import {
  extractLarkMessageContent,
  isLarkMessageTypeNormalizable,
  normalizeLarkInboundContent,
} from '../lark-content';

describe('extractLarkMessageContent', () => {
  it('extracts text from text message', () => {
    const content = JSON.stringify({ text: 'hello world' });
    expect(extractLarkMessageContent('text', content)).toBe('hello world');
  });

  it('returns raw content when text message has invalid JSON', () => {
    expect(extractLarkMessageContent('text', 'not json')).toBe('not json');
  });

  it('returns image placeholder for image message', () => {
    const content = JSON.stringify({ image_key: 'img_v3_abc' });
    expect(extractLarkMessageContent('image', content)).toBe('[Image: img_v3_abc]');
  });

  it('returns file placeholder for file message', () => {
    const content = JSON.stringify({ file_key: 'file_v3_xyz', file_name: 'report.pdf' });
    expect(extractLarkMessageContent('file', content)).toBe('[File: report.pdf]');
  });

  it('returns audio placeholder for audio message', () => {
    const content = JSON.stringify({ file_key: 'file_v3_audio' });
    expect(extractLarkMessageContent('audio', content)).toBe('[Audio message]');
  });

  it('extracts text from post (rich text) message', () => {
    const content = JSON.stringify({
      title: 'My Post',
      content: [
        [{ tag: 'text', text: 'Hello ' }, { tag: 'text', text: 'world' }],
        [{ tag: 'text', text: 'Second paragraph' }, { tag: 'a', text: 'link', href: 'https://example.com' }],
      ],
    });
    expect(extractLarkMessageContent('post', content)).toBe('Hello world\nSecond paragraph link');
  });

  it('returns empty string for post with no text elements', () => {
    const content = JSON.stringify({ title: 'Empty', content: [[{ tag: 'img', image_key: 'abc' }]] });
    expect(extractLarkMessageContent('post', content)).toBe('');
  });

  it('returns generic placeholder for unknown message type', () => {
    const content = JSON.stringify({ sticker_id: 'abc' });
    expect(extractLarkMessageContent('sticker', content)).toBe('[sticker message]');
  });

  it('handles malformed JSON for non-text types gracefully', () => {
    expect(extractLarkMessageContent('image', 'not json')).toBe('[image message]');
  });
});

describe('normalizeLarkInboundContent', () => {
  it('returns is_normalizable=true with normalized_text for text', () => {
    const raw = JSON.stringify({ text: 'hello world' });
    expect(normalizeLarkInboundContent('text', raw)).toEqual({
      is_normalizable: true,
      normalized_text: 'hello world',
    });
    expect(isLarkMessageTypeNormalizable('text')).toBe(true);
  });

  it('returns is_normalizable=true with normalized_text for post', () => {
    const raw = JSON.stringify({
      content: [[{ tag: 'text', text: 'Hello' }, { tag: 'text', text: 'world' }]],
    });
    expect(normalizeLarkInboundContent('post', raw)).toEqual({
      is_normalizable: true,
      normalized_text: 'Hello world',
    });
    expect(isLarkMessageTypeNormalizable('post')).toBe(true);
  });

  it('returns is_normalizable=false and omits normalized_text for unknown/unusable message types', () => {
    const raw = JSON.stringify({ sticker_id: 'abc' });
    expect(normalizeLarkInboundContent('sticker', raw)).toEqual({ is_normalizable: false });
    expect(isLarkMessageTypeNormalizable('sticker')).toBe(false);
  });
});
