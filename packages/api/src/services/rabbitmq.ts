import amqplib from 'amqplib';
import {
  Task,
  Job,
  TaskResult,
  createLogger,
  deriveRabbitMqManagementConfig,
  DEFAULT_RESULTS_EXCHANGE_NAME,
  DEFAULT_LARK_QUEUE_NAME,
  DEFAULT_JOBS_EXCHANGE_NAME,
  DEFAULT_SESSION_JOBS_QUEUE_PREFIX,
  DEFAULT_SESSION_QUEUE_IDLE_TTL_MS,
  DEFAULT_TELEGRAM_QUEUE_NAME,
} from '@local-agent/shared';

interface GetMessage {
  content: Buffer;
  fields: { deliveryTag: number };
}

export interface SessionJobDescriptor {
  session_id: string;
  queue_name: string;
}

const logger = createLogger('api:rabbitmq');
const MANAGEMENT_REQUEST_TIMEOUT_MS = 3_000;

interface RabbitMqManagementQueue {
  name?: string;
}

export class RabbitMQService {
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private deliveryMap = new Map<string, GetMessage>();
  private queueDeliveryMaps = new Map<string, Map<string, GetMessage>>();

  constructor(
    private readonly url: string,
    private readonly queueName: string,
  ) {}

  static getSessionQueueName(sessionId: string): string {
    return `${DEFAULT_SESSION_JOBS_QUEUE_PREFIX}.${sessionId}`;
  }

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
    await ch.assertExchange(DEFAULT_JOBS_EXCHANGE_NAME, 'direct', { durable: true });
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

  async ensureSessionJobQueue(sessionId: string): Promise<string> {
    if (!this.channel) throw new Error('Not connected');
    const queueName = RabbitMQService.getSessionQueueName(sessionId);
    await this.channel.assertQueue(queueName, {
      durable: true,
      arguments: { 'x-expires': DEFAULT_SESSION_QUEUE_IDLE_TTL_MS },
    });
    await this.channel.bindQueue(queueName, DEFAULT_JOBS_EXCHANGE_NAME, sessionId);
    return queueName;
  }

  async publishJob(message: Job): Promise<boolean> {
    if (!this.channel) throw new Error('Not connected');
    await this.ensureSessionJobQueue(message.session_id);
    const buffer = Buffer.from(JSON.stringify(message));
    return this.channel.publish(DEFAULT_JOBS_EXCHANGE_NAME, message.session_id, buffer, {
      persistent: true,
    });
  }

  async getNextJobFromSession(sessionId: string): Promise<Job | null> {
    if (!this.channel) throw new Error('Not connected');
    const queueName = RabbitMQService.getSessionQueueName(sessionId);
    const msg = await this.channel.get(queueName, { noAck: false });
    if (msg === false) {
      return null;
    }

    const parsed = JSON.parse(msg.content.toString()) as Job;
    const deliveryMap = this.getOrCreateDeliveryMap(queueName);

    if (deliveryMap.has(parsed.job_id)) {
      logger.error(
        { job_id: parsed.job_id, deliveryTag: msg.fields.deliveryTag, queueName },
        'Duplicate job_id received while an earlier delivery is still outstanding; acknowledging duplicate message',
      );
      this.channel.ack(msg);
      return null;
    }

    deliveryMap.set(parsed.job_id, msg as unknown as GetMessage);
    return parsed;
  }

  ackJobFromSession(sessionId: string, jobId: string): boolean {
    return this.finalizeJobDelivery(sessionId, jobId, 'ack');
  }

  nackJobFromSession(sessionId: string, jobId: string, requeue = true): boolean {
    return this.finalizeJobDelivery(sessionId, jobId, 'nack', requeue);
  }

  async listSessionQueues(): Promise<SessionJobDescriptor[]> {
    const management = deriveRabbitMqManagementConfig(this.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MANAGEMENT_REQUEST_TIMEOUT_MS);

    try {
      const auth = Buffer.from(`${management.username}:${management.password}`).toString('base64');
      const response = await fetch(`${management.baseUrl}/api/queues/${management.encodedVhost}`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'RabbitMQ management queue discovery failed');
        throw new Error(`RabbitMQ management returned status ${response.status}`);
      }

      const queues = (await response.json()) as RabbitMqManagementQueue[];

      return queues
        .filter((queue): queue is Required<Pick<RabbitMqManagementQueue, 'name'>> =>
          typeof queue.name === 'string' && queue.name.startsWith(`${DEFAULT_SESSION_JOBS_QUEUE_PREFIX}.`),
        )
        .map((queue) => ({
          queue_name: queue.name,
          session_id: queue.name.slice(`${DEFAULT_SESSION_JOBS_QUEUE_PREFIX}.`.length),
        }))
        .sort((a, b) => a.queue_name.localeCompare(b.queue_name));
    } catch (err) {
      logger.warn({ err }, 'RabbitMQ management session discovery failed');
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  isConnected(): boolean {
    return this.connection !== null && this.channel !== null;
  }

  ack(taskId: string): boolean {
    if (!this.channel) return false;
    const delivery = this.deliveryMap.get(taskId);
    if (!delivery) return false;
    this.channel.ack(delivery as any);
    this.deliveryMap.delete(taskId);
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
    const deliveryMap = this.getOrCreateDeliveryMap(queueName);

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

  private finalizeJobDelivery(
    sessionId: string,
    jobId: string,
    mode: 'ack' | 'nack',
    requeue = true,
  ): boolean {
    if (!this.channel) return false;
    const queueName = RabbitMQService.getSessionQueueName(sessionId);
    const deliveryMap = this.queueDeliveryMaps.get(queueName);
    if (!deliveryMap) return false;
    const delivery = deliveryMap.get(jobId);
    if (!delivery) return false;

    if (mode === 'ack') {
      this.channel.ack(delivery as any);
    } else {
      this.channel.nack(delivery as any, false, requeue);
    }

    deliveryMap.delete(jobId);
    return true;
  }

  private getOrCreateDeliveryMap(queueName: string): Map<string, GetMessage> {
    let deliveryMap = this.queueDeliveryMaps.get(queueName);
    if (!deliveryMap) {
      deliveryMap = new Map<string, GetMessage>();
      this.queueDeliveryMaps.set(queueName, deliveryMap);
    }
    return deliveryMap;
  }
}
