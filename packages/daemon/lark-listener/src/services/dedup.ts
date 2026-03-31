import {
  DEFAULT_DEDUP_TTL_MS,
  DEFAULT_DEDUP_MAX_SIZE,
  DEFAULT_DEDUP_CLEANUP_INTERVAL_MS,
} from '../constants';

interface DedupOptions {
  ttlMs?: number;
  maxSize?: number;
  cleanupIntervalMs?: number;
}

export class DedupMap {
  private readonly map = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor(opts: DedupOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_DEDUP_TTL_MS;
    this.maxSize = opts.maxSize ?? DEFAULT_DEDUP_MAX_SIZE;

    const intervalMs = opts.cleanupIntervalMs ?? DEFAULT_DEDUP_CLEANUP_INTERVAL_MS;
    this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  add(id: string): void {
    if (this.map.size >= this.maxSize) {
      // Evict oldest entry
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
    this.map.set(id, Date.now());
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.map.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, ts] of this.map) {
      if (now - ts > this.ttlMs) {
        this.map.delete(id);
      }
    }
  }
}
