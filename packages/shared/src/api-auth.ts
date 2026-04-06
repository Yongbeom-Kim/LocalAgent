export function resolveApiClientToken(opts: {
  explicitToken?: string;
  env: Record<string, string | undefined>;
}): string | undefined {
  const explicitToken = opts.explicitToken?.trim();
  if (explicitToken) {
    return explicitToken;
  }

  const envToken = opts.env.API_AUTH_TOKEN?.trim();
  return envToken || undefined;
}

export function buildApiAuthHeaders(token?: string): Record<string, string> {
  const trimmedToken = token?.trim();
  if (!trimmedToken) {
    return {};
  }

  return {
    Authorization: `Bearer ${trimmedToken}`,
  };
}
