import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DedupMap } from '../services/dedup';

describe('DedupMap', () => {
  let dedup: DedupMap;

  beforeEach(() => {
    vi.useFakeTimers();
    dedup = new DedupMap({ ttlMs: 5000, maxSize: 3, cleanupIntervalMs: 2000 });
  });

  afterEach(() => {
    dedup.destroy();
    vi.useRealTimers();
  });

  it('returns false for unseen id, true for seen id', () => {
    expect(dedup.has('msg-1')).toBe(false);
    dedup.add('msg-1');
    expect(dedup.has('msg-1')).toBe(true);
  });

  it('expires entries after TTL', () => {
    dedup.add('msg-1');
    vi.advanceTimersByTime(2000);
    // trigger cleanup
    vi.advanceTimersByTime(1);
    expect(dedup.has('msg-1')).toBe(true);

    // Advance past TTL and wait for next cleanup (at 6000ms)
    vi.advanceTimersByTime(4000);
    expect(dedup.has('msg-1')).toBe(false);
  });

  it('evicts oldest when exceeding maxSize', () => {
    dedup.add('msg-1');
    vi.advanceTimersByTime(1);
    dedup.add('msg-2');
    vi.advanceTimersByTime(1);
    dedup.add('msg-3');
    vi.advanceTimersByTime(1);
    dedup.add('msg-4'); // should evict msg-1

    expect(dedup.has('msg-1')).toBe(false);
    expect(dedup.has('msg-4')).toBe(true);
  });

  it('destroy stops cleanup timer', () => {
    dedup.destroy();
    // Should not throw when timers advance
    vi.advanceTimersByTime(10_000);
  });
});
