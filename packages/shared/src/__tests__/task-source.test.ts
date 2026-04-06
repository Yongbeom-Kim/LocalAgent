import { describe, it, expect } from 'vitest';
import {
  isValidTaskSource,
  isValidTelegramChatTaskSource,
  isValidTelegramTopicTaskSource,
} from '../types';

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

  it('returns true for telegram topic sources', () => {
    expect(
      isValidTaskSource({
        source: 'telegram',
        chat_id: '-100123',
        topic_id: '42',
        message_id: '99',
      }),
    ).toBe(true);
    expect(
      isValidTelegramTopicTaskSource({
        source: 'telegram',
        chat_id: '-100123',
        topic_id: '42',
        message_id: '99',
      }),
    ).toBe(true);
  });

  it('returns true for telegram chat sources without topic_id', () => {
    expect(
      isValidTaskSource({
        source: 'telegram',
        chat_id: '-100123',
        message_id: '99',
      }),
    ).toBe(true);
    expect(
      isValidTelegramChatTaskSource({
        source: 'telegram',
        chat_id: '-100123',
        message_id: '99',
      }),
    ).toBe(true);
  });

  it('returns false for telegram source with empty chat_id', () => {
    expect(
      isValidTaskSource({
        source: 'telegram',
        chat_id: '',
        topic_id: '42',
        message_id: '99',
      }),
    ).toBe(false);
  });

  it('returns false for telegram topic source with missing topic_id in strict validator', () => {
    expect(
      isValidTelegramTopicTaskSource({
        source: 'telegram',
        chat_id: '-100123',
        message_id: '99',
      }),
    ).toBe(false);
  });
});
