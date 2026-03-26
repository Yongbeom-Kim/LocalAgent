import amqplib, { Channel, Connection, ConsumeMessage } from 'amqplib';
import { v4 as uuidv4 } from 'uuid';
import { Task } from '@local-agent/shared';

interface DeliveryInfo {
  message: ConsumeMessage;
}

export class RabbitMQService {
  private connection: Connection | null = null;
  private channel: Channel | null = null;
  private deliveryMap = new Map<string, DeliveryInfo>();

  constructor(
    private readonly url: string,
    private readonly queueName: string,
  ) {}

  async connect(): Promise<void> {
    this.connection = await amqplib.connect(this.url);
    this.connection.on('error', () => {});
    this.connection.on('close', () => {});
    this.channel = await this.connection.createChannel();
    await this.channel.assertQueue(this.queueName, { durable: true });
  }

  async close(): Promise<void> {
    await this.connection?.close();
    this.connection = null;
    this.channel = null;
  }

  publish(message: { task_type: string; payload: string; submitted_at?: string }): void {
    if (!this.channel) throw new Error('Not connected');
    const buffer = Buffer.from(JSON.stringify(message));
    this.channel.sendToQueue(this.queueName, buffer, { persistent: true });
  }

  async getNext(): Promise<Task | null> {
    if (!this.channel) throw new Error('Not connected');
    const msg = await this.channel.get(this.queueName, { noAck: false });
    if (msg === false) return null;

    const parsed = JSON.parse(msg.content.toString());
    const taskId = uuidv4();

    this.deliveryMap.set(taskId, { message: msg });

    return {
      task_id: taskId,
      task_type: parsed.task_type,
      payload: parsed.payload,
      submitted_at: parsed.submitted_at,
    };
  }

  ack(taskId: string): boolean {
    if (!this.channel) throw new Error('Not connected');
    const delivery = this.deliveryMap.get(taskId);
    if (!delivery) return false;
    this.channel.ack(delivery.message);
    this.deliveryMap.delete(taskId);
    return true;
  }

  isConnected(): boolean {
    return this.connection !== null && this.channel !== null;
  }
}
