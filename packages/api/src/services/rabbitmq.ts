import amqplib from 'amqplib';
import { Task, Job, TaskResult, createLogger, DEFAULT_RESULTS_EXCHANGE_NAME, DEFAULT_LARK_QUEUE_NAME, DEFAULT_JOBS_QUEUE_NAME, DEFAULT_TELEGRAM_QUEUE_NAME } from '@local-agent/shared';

interface GetMessage {
  content: Buffer;
  fields: { deliveryTag: number };
}

const logger = createLogger('api:rabbitmq');

export class RabbitMQService {
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private deliveryMap = new Map<string, GetMessage>();
  private jobsDeliveryMap = new Map<string, GetMessage>();
  private queueDeliveryMaps = new Map<string, Map<string, GetMessage>>();

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
    await ch.assertQueue(DEFAULT_JOBS_QUEUE_NAME, { durable: true });
    await ch.assertExchange(DEFAULT_RESULTS_EXCHANGE_NAME, 'fanout', { durable: true });
    await ch.assertQueue(DEFAULT_LARK_QUEUE_NAME, { durable: true });
    await ch.bindQueue(DEFAULT_LARK_QUEUE_NAME, DEFAULT_RESULTS_EXCHANGE_NAME, '');
    await ch.assertQueue(DEFAULT_TELEGRAM_QUEUE_NAME, { durable: true });
    await ch.bindQueue(DEFAULT_TELEGRAM_QUEUE_NAME, DEFAULT_RESULTS_EXCHANGE_NAME, '');
    this.channel = ch;
  }

  async close(): Promise<void> {
    await this.connection?.close();
    this.connection = null;
    this.channel = null;
  }

  publish(message: Task): boolean {
    if (!this.channel) throw new Error('Not connected');
    const buffer = Buffer.from(JSON.stringify(message));
    return this.channel.sendToQueue(this.queueName, buffer, { persistent: true });
  }

  publishJob(message: Job): boolean {
    if (!this.channel) throw new Error('Not connected');
    const buffer = Buffer.from(JSON.stringify(message));
    return this.channel.sendToQueue(DEFAULT_JOBS_QUEUE_NAME, buffer, { persistent: true });
  }

  async getNextJob(): Promise<Job | null> {
    if (!this.channel) throw new Error('Not connected');
    const msg = await this.channel.get(DEFAULT_JOBS_QUEUE_NAME, { noAck: false });
    if (msg === false) return null;

    const parsed = JSON.parse(msg.content.toString()) as Job;

    if (this.jobsDeliveryMap.has(parsed.job_id)) {
      logger.error(
        { job_id: parsed.job_id, deliveryTag: msg.fields.deliveryTag },
        'Duplicate job_id received while an earlier delivery is still outstanding; acknowledging duplicate message',
      );
      this.channel.ack(msg);
      return null;
    }

    this.jobsDeliveryMap.set(parsed.job_id, msg as unknown as GetMessage);

    return parsed;
  }

  ackJob(jobId: string): boolean {
    if (!this.channel) return false;
    const delivery = this.jobsDeliveryMap.get(jobId);
    if (!delivery) return false;
    this.channel.ack(delivery as any);
    this.jobsDeliveryMap.delete(jobId);
    return true;
  }

  async getNext(): Promise<Task | null> {
    if (!this.channel) throw new Error('Not connected');
    const msg = await this.channel.get(this.queueName, { noAck: false });
    if (msg === false) return null;

    const parsed = JSON.parse(msg.content.toString()) as Task;

    if (this.deliveryMap.has(parsed.task_id)) {
      logger.error(
        { task_id: parsed.task_id, deliveryTag: msg.fields.deliveryTag },
        'Duplicate task_id received while an earlier delivery is still outstanding; acknowledging duplicate message',
      );
      this.channel.ack(msg);
      return null;
    }

    this.deliveryMap.set(parsed.task_id, msg as unknown as GetMessage);

    return parsed;
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

  publishToExchange(exchange: string, message: TaskResult): boolean {
    if (!this.channel) throw new Error('Not connected');
    const buffer = Buffer.from(JSON.stringify(message));
    return this.channel.publish(exchange, '', buffer, { persistent: true });
  }

  async getNextFromQueue(queueName: string): Promise<TaskResult | null> {
    if (!this.channel) throw new Error('Not connected');
    const msg = await this.channel.get(queueName, { noAck: false });
    if (msg === false) return null;

    const parsed = JSON.parse(msg.content.toString()) as TaskResult;

    let deliveryMap = this.queueDeliveryMaps.get(queueName);
    if (!deliveryMap) {
      deliveryMap = new Map<string, GetMessage>();
      this.queueDeliveryMaps.set(queueName, deliveryMap);
    }

    if (deliveryMap.has(parsed.result_id)) {
      logger.error(
        { result_id: parsed.result_id, deliveryTag: msg.fields.deliveryTag, queueName },
        'Duplicate result_id received while an earlier delivery is still outstanding; acknowledging duplicate message',
      );
      this.channel.ack(msg);
      return null;
    }

    deliveryMap.set(parsed.result_id, msg as unknown as GetMessage);

    return parsed;
  }

  ackFromQueue(queueName: string, resultId: string): boolean {
    if (!this.channel) return false;
    const deliveryMap = this.queueDeliveryMaps.get(queueName);
    if (!deliveryMap) return false;
    const delivery = deliveryMap.get(resultId);
    if (!delivery) return false;
    this.channel.ack(delivery as any);
    deliveryMap.delete(resultId);
    return true;
  }
}
