export interface ConsumedMessage<T = unknown> {
  receiptHandle: string;
  message: T;
}

export interface QueuePort {
  consume(queueName: string): Promise<ConsumedMessage | null>;
  ack(receiptHandle: string): Promise<void>;
  nack(receiptHandle: string): Promise<void>;
  publish(queueName: string, message: unknown, routingKey?: string): Promise<void>;
}
