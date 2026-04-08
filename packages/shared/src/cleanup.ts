export const CLEANUP_SUBTREE_PAYLOAD_VERSION = 1 as const;

export interface CleanupSubtreePayload {
  version: typeof CLEANUP_SUBTREE_PAYLOAD_VERSION;
  session_ids: string[];
}

export type CleanupPayloadParseResult =
  | { kind: 'legacy'; sessionIds: string[] }
  | { kind: 'subtree'; sessionIds: string[] }
  | { kind: 'invalid'; reason: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeSessionIds(sessionIds: readonly string[]): string[] {
  return [...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter((sessionId) => sessionId.length > 0))];
}

export function buildCleanupSubtreePayload(sessionIds: readonly string[]): string {
  const normalizedSessionIds = normalizeSessionIds(sessionIds);
  if (normalizedSessionIds.length === 0) {
    throw new Error('cleanup subtree payload requires at least one session id');
  }

  return JSON.stringify({
    version: CLEANUP_SUBTREE_PAYLOAD_VERSION,
    session_ids: normalizedSessionIds,
  } satisfies CleanupSubtreePayload);
}

export function parseCleanupPayload(payload: string, fallbackSessionId: string): CleanupPayloadParseResult {
  const fallbackSessionIds = normalizeSessionIds([fallbackSessionId]);
  if (fallbackSessionIds.length !== 1) {
    return { kind: 'invalid', reason: 'cleanup fallback session id must be a non-empty string' };
  }

  const trimmedPayload = payload.trim();
  if (trimmedPayload.length === 0 || (!trimmedPayload.startsWith('{') && !trimmedPayload.startsWith('['))) {
    return { kind: 'legacy', sessionIds: fallbackSessionIds };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmedPayload);
  } catch {
    return { kind: 'invalid', reason: 'cleanup payload must be valid JSON when subtree metadata is provided' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'cleanup payload must be a JSON object when subtree metadata is provided' };
  }

  const candidate = parsed;
  if (candidate.version !== CLEANUP_SUBTREE_PAYLOAD_VERSION) {
    return { kind: 'invalid', reason: 'cleanup payload version must be 1' };
  }

  if (!Array.isArray(candidate.session_ids)) {
    return { kind: 'invalid', reason: 'cleanup payload session_ids must be an array of non-empty strings' };
  }

  if (!candidate.session_ids.every(isNonEmptyString)) {
    return { kind: 'invalid', reason: 'cleanup payload session_ids must be an array of non-empty strings' };
  }

  const sessionIds = normalizeSessionIds(candidate.session_ids);
  if (sessionIds.length === 0) {
    return { kind: 'invalid', reason: 'cleanup payload session_ids must contain at least one session id' };
  }

  return { kind: 'subtree', sessionIds };
}
