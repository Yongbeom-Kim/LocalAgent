import { randomUUID } from "node:crypto";
import type { Channel, ConsumeMessage } from "amqplib";

interface InFlightEntry {
  channel: Channel;
  deliveryTag: number;
  createdAt: number;
}

export class InFlightManager {
  private entries = new Map<string, InFlightEntry>();
  private scavengerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private ttlMs: number) {}

  track(channel: Channel, deliveryTag: number): string {
    const handle = randomUUID();
    this.entries.set(handle, { channel, deliveryTag, createdAt: Date.now() });
    return handle;
  }

  ack(handle: string): boolean {
    const entry = this.entries.get(handle);
    if (!entry) return false;
    try {
      entry.channel.ack({ fields: { deliveryTag: entry.deliveryTag } } as ConsumeMessage);
    } catch { /* Channel may have closed */ }
    this.entries.delete(handle);
    return true;
  }

  nack(handle: string): boolean {
    const entry = this.entries.get(handle);
    if (!entry) return false;
    try {
      entry.channel.nack({ fields: { deliveryTag: entry.deliveryTag } } as ConsumeMessage, false, false);
    } catch { /* Channel may have closed */ }
    this.entries.delete(handle);
    return true;
  }

  startScavenger(intervalMs: number): void {
    this.scavengerTimer = setInterval(() => {
      const now = Date.now();
      for (const [handle, entry] of this.entries) {
        if (now - entry.createdAt > this.ttlMs) {
          console.warn(`Scavenging stale in-flight message: ${handle}`);
          try {
            entry.channel.nack({ fields: { deliveryTag: entry.deliveryTag } } as ConsumeMessage, false, true);
          } catch { /* Channel may have closed */ }
          this.entries.delete(handle);
        }
      }
    }, intervalMs);
  }

  stopScavenger(): void {
    if (this.scavengerTimer) {
      clearInterval(this.scavengerTimer);
      this.scavengerTimer = null;
    }
  }

  get size(): number { return this.entries.size; }
}
