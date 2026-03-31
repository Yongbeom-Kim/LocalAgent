import { describe, it, expect } from 'vitest';
import { isValidTaskSource } from '../types';

describe('isValidTaskSource', () => {
  it('returns true for valid lark source', () => {
    expect(isValidTaskSource({ source: 'lark', message_id: 'om_abc123' })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isValidTaskSource(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isValidTaskSource(undefined)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isValidTaskSource('lark')).toBe(false);
  });

  it('returns false for unknown source', () => {
    expect(isValidTaskSource({ source: 'unknown', id: '123' })).toBe(false);
  });

  it('returns false for lark source with missing message_id', () => {
    expect(isValidTaskSource({ source: 'lark' })).toBe(false);
  });

  it('returns false for lark source with empty message_id', () => {
    expect(isValidTaskSource({ source: 'lark', message_id: '' })).toBe(false);
  });

  it('returns false for lark source with non-string message_id', () => {
    expect(isValidTaskSource({ source: 'lark', message_id: 123 })).toBe(false);
  });
});
