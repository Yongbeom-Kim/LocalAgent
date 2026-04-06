import { describe, expect, it } from 'vitest';
import { buildApiAuthHeaders, resolveApiClientToken } from '../api-auth';

describe('buildApiAuthHeaders', () => {
  it('builds bearer headers only when a client token is configured', () => {
    expect(buildApiAuthHeaders('secret')).toEqual({ Authorization: 'Bearer secret' });
    expect(buildApiAuthHeaders(undefined)).toEqual({});
  });

  it('trims token values before constructing headers', () => {
    expect(buildApiAuthHeaders('  secret  ')).toEqual({ Authorization: 'Bearer secret' });
  });

  it('returns empty headers when token is whitespace', () => {
    expect(buildApiAuthHeaders('   ')).toEqual({});
  });
});

describe('resolveApiClientToken', () => {
  it('prefers explicit token over env', () => {
    expect(resolveApiClientToken({ explicitToken: 'explicit', env: { API_AUTH_TOKEN: 'env-token' } })).toBe(
      'explicit',
    );
  });

  it('falls back to env token when explicit token is missing', () => {
    expect(resolveApiClientToken({ env: { API_AUTH_TOKEN: 'env-token' } })).toBe('env-token');
  });

  it('trims explicit and env values and returns undefined for blank inputs', () => {
    expect(resolveApiClientToken({ explicitToken: '  explicit  ', env: { API_AUTH_TOKEN: ' env-token ' } })).toBe(
      'explicit',
    );
    expect(resolveApiClientToken({ explicitToken: '   ', env: { API_AUTH_TOKEN: '  env-token  ' } })).toBe(
      'env-token',
    );
    expect(resolveApiClientToken({ explicitToken: '   ', env: { API_AUTH_TOKEN: '   ' } })).toBeUndefined();
  });
});
