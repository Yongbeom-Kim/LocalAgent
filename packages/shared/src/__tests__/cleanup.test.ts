import { describe, expect, it } from 'vitest';
import {
  CLEANUP_SUBTREE_PAYLOAD_VERSION,
  buildCleanupSubtreePayload,
  parseCleanupPayload,
} from '../cleanup';

describe('buildCleanupSubtreePayload', () => {
  it('serializes a deduplicated subtree payload', () => {
    expect(buildCleanupSubtreePayload(['root-session', 'child-session', 'root-session'])).toBe(
      JSON.stringify({
        version: CLEANUP_SUBTREE_PAYLOAD_VERSION,
        session_ids: ['root-session', 'child-session'],
      }),
    );
  });

  it('rejects an empty session id list', () => {
    expect(() => buildCleanupSubtreePayload([])).toThrow('cleanup subtree payload requires at least one session id');
  });
});

describe('parseCleanupPayload', () => {
  it('falls back to the root session for legacy payloads', () => {
    expect(parseCleanupPayload('cleanup session workspace', 'root-session')).toEqual({
      kind: 'legacy',
      sessionIds: ['root-session'],
    });
  });

  it('parses subtree cleanup payloads', () => {
    expect(
      parseCleanupPayload(
        JSON.stringify({
          version: CLEANUP_SUBTREE_PAYLOAD_VERSION,
          session_ids: ['root-session', 'child-session', 'child-session'],
        }),
        'ignored-root',
      ),
    ).toEqual({
      kind: 'subtree',
      sessionIds: ['root-session', 'child-session'],
    });
  });

  it('rejects malformed subtree JSON', () => {
    expect(parseCleanupPayload('{', 'root-session')).toEqual({
      kind: 'invalid',
      reason: 'cleanup payload must be valid JSON when subtree metadata is provided',
    });
  });

  it('rejects invalid subtree session_ids', () => {
    expect(
      parseCleanupPayload(
        JSON.stringify({ version: CLEANUP_SUBTREE_PAYLOAD_VERSION, session_ids: ['root-session', ''] }),
        'root-session',
      ),
    ).toEqual({
      kind: 'invalid',
      reason: 'cleanup payload session_ids must be an array of non-empty strings',
    });
  });
});
