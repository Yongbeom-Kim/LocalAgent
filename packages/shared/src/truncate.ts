export function truncate(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;
  const sliced = buf.subarray(0, maxBytes);
  return sliced.toString('utf-8').replace(/\uFFFD$/, '');
}