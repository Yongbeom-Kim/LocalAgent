export function truncate(str: string, maxBytes: number): string {
  if (typeof str !== 'string') {
    throw new TypeError('str must be a string');
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative integer');
  }

  // Return empty string immediately for zero maxBytes
  if (maxBytes === 0) return '';

  // Fast path for strings much shorter than maxBytes
  if (str.length < maxBytes / 4) {
    return str;
  }

  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;

  // Ensure we don't truncate in the middle of a multi-byte character
  const sliced = buf.subarray(0, maxBytes);
  let result = sliced.toString('utf-8');

  // Remove replacement character if it was added by truncating mid-character
  return result.replace(/\uFFFD$/, '');
}