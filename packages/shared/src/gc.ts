import { SESSION_DIR_TTL_DAYS } from './constants';

const GC_AGE_UNITS_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
} as const;

const GC_AGE_PATTERN = /^([1-9]\d*)([smhdw])$/;

export const DEFAULT_GC_AGE_THRESHOLD_MS = SESSION_DIR_TTL_DAYS * GC_AGE_UNITS_MS.d;

export function parseGcCommand(trimmedText: string): { payload: string } | null {
  const match = /^\/gc(?:\s+([^\s]+))?$/.exec(trimmedText);
  if (!match) {
    return null;
  }

  const payload = match[1] ?? '';
  return parseGcAgeThresholdPayload(payload) === null ? null : { payload };
}

export function parseGcAgeThresholdPayload(payload: string): number | null {
  const trimmedPayload = payload.trim();

  if (trimmedPayload === '') {
    return DEFAULT_GC_AGE_THRESHOLD_MS;
  }

  const match = GC_AGE_PATTERN.exec(trimmedPayload);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  const unit = match[2] as keyof typeof GC_AGE_UNITS_MS;
  return value * GC_AGE_UNITS_MS[unit];
}
