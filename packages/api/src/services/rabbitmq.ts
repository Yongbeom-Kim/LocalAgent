import amqplib from 'amqplib';
import { v4 as uuidv4 } from 'uuid';
import { Task } from '@local-agent/shared';

interface GetMessage {
  content: Buffer;
  fields: { deliveryTag: number };
}

export class RabbitMQService {
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private deliveryMap = new Map<string, GetMessage>();

  constructor(
    private readonly url: string,
    private readonly queueName: string,
  ) {}

  async connect(): Promise<void> {
    const conn = await amqplib.connect(this.url);
    conn.on('error', () => {
      this.connection = null;
      this.channel = null;
    });
    conn.on('close', () => {
      this.connection = null;
      this.channel = null;
    });
    this.connection = conn;
    const ch = await conn.createChannel();
    await ch.assertQueue(this.queueName, { durable: true });
    this.channel = ch;
  }

  async close(): Promise<void> {
    await this.connection?.close();
    this.connection = null;
    this.channel = null;
  }

  publish(message: { task_type: string; payload: string; submitted_at?: string }): boolean {
    if (!this.channel) throw new Error('Not connected');
    const buffer = Buffer.from(JSON.stringify(message));
    return this.channel.sendToQueue(this.queueName, buffer, { persistent: true });
  }

  async getNext(): Promise<Task | null> {
    if (!this.channel) throw new Error('Not connected');
    const msg = await this.channel.get(this.queueName, { noAck: false });
    if (msg === false) return null;

    const parsed = JSON.parse(msg.content.toString());
    const taskId = uuidv4();

    this.deliveryMap.set(taskId, msg as unknown as GetMessage);

    return {
      task_id: taskId,
      task_type: parsed.task_type,
      payload: parsed.payload,
      submitted_at: parsed.submitted_at,
    };
  }

  ack(taskId: string): boolean {
    if (!this.channel) return false;
    const delivery = this.deliveryMap.get(taskId);
    if (!delivery) return false;
    this.channel.ack(delivery as any);
    this.deliveryMap.delete(taskId);
    return true;
  }

  isConnected(): boolean {
    return this.connection !== null && this.channel !== null;
  }
}
