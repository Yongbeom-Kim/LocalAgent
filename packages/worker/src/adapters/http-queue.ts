import type { QueuePort, ConsumedMessage } from "../ports/queue.js";

export class HttpQueueAdapter implements QueuePort {
  constructor(private baseUrl: string, private apiKey: string) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  async consume(queueName: string): Promise<ConsumedMessage | null> {
    const res = await fetch(`${this.baseUrl}/queues/${queueName}/consume`, { method: "GET", headers: this.headers() });
    if (res.status === 204) return null;
    if (res.status !== 200) throw new Error(`Consume failed: ${res.status}`);
    return res.json() as Promise<ConsumedMessage>;
  }

  async ack(receiptHandle: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/queues/ack`, {
      method: "POST", headers: this.headers(), body: JSON.stringify({ receiptHandle }),
    });
    if (res.status === 404) { console.warn(`Stale receipt handle: ${receiptHandle}`); return; }
    if (res.status !== 200) throw new Error(`Ack failed: ${res.status}`);
  }

  async nack(receiptHandle: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/queues/nack`, {
      method: "POST", headers: this.headers(), body: JSON.stringify({ receiptHandle }),
    });
    if (res.status === 404) { console.warn(`Stale receipt handle: ${receiptHandle}`); return; }
    if (res.status !== 200) throw new Error(`Nack failed: ${res.status}`);
  }

  async publish(queueName: string, message: unknown, routingKey?: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/queues/${queueName}/publish`, {
      method: "POST", headers: this.headers(), body: JSON.stringify({ message, routingKey }),
    });
    if (res.status !== 200) throw new Error(`Publish failed: ${res.status}`);
  }
}
