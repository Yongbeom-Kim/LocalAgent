import { describe, it, expect } from 'vitest';
import { truncate } from '../truncate';

describe('truncate', () => {
  it('returns string unchanged when shorter than maxBytes', () => {
    expect(truncate('hello', 100)).toBe('hello');
  });

  it('returns empty string unchanged', () => {
    expect(truncate('', 100)).toBe('');
  });

  it('truncates string exceeding maxBytes', () => {
    const long = 'a'.repeat(200);
    const result = truncate(long, 100);
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(100);
  });

  it('handles multi-byte characters without splitting mid-character', () => {
    // Each emoji is 4 bytes in UTF-8
    const emojis = '😀'.repeat(30); // 120 bytes
    const result = truncate(emojis, 100);
    // Should not produce invalid UTF-8
    expect(Buffer.from(result, 'utf-8').toString('utf-8')).toBe(result);
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(100);
  });

  it('returns full string when exactly at maxBytes', () => {
    const exact = 'a'.repeat(100);
    expect(truncate(exact, 100)).toBe(exact);
  });
});