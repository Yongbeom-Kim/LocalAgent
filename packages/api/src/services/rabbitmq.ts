import amqplib from 'amqplib';
import {
  Task,
  Job,
  TaskEvent,
  createLogger,
  deriveRabbitMqManagementConfig,
  DEFAULT_RESULTS_EXCHANGE_NAME,
  DEFAULT_LARK_QUEUE_NAME,
  DEFAULT_JOBS_EXCHANGE_NAME,
  DEFAULT_SESSION_JOBS_QUEUE_PREFIX,
  DEFAULT_SESSION_QUEUE_IDLE_TTL_MS,
  DEFAULT_TELEGRAM_QUEUE_NAME,
} from '@local-agent/shared';
import { BufferedAmqpEnqueuer } from './buffered-amqp-enqueuer';

interface GetMessage {
  content: Buffer;
  fields: { deliveryTag: number };
}

interface TrackedDelivery {
  message: GetMessage;
  generation: number;
}

export interface SessionJobDescriptor {
  session_id: string;
  queue_name: string;
}

export class RabbitMQUnavailableError extends Error {
  constructor(message = 'RabbitMQ temporarily unavailable') {
    super(message);
    this.name = 'RabbitMQUnavailableError';
  }
}

const logger = createLogger('api:rabbitmq');
const MANAGEMENT_REQUEST_TIMEOUT_MS = 3_000;

interface RabbitMqManagementQueue {
  name?: string;
}

export class RabbitMQService {
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private closing = false;
  private connectionGeneration = 0;
  private deliveryMap = new Map<string, TrackedDelivery>();
  private queueDeliveryMaps = new Map<string, Map<string, TrackedDelivery>>();
  private publishBuffer = new BufferedAmqpEnqueuer({
    resolveChannel: async () => {
      const connected = await this.ensureConnected();
      return connected ? this.channel : null;
    },
    clearConnectionState: () => this.clearConnectionState(),
    isRetryableError: (error) => this.isRetryableChannelError(error),
    logger,
  });

  constructor(
    private readonly url: string,
    private readonly queueName: string,
  ) {}

  static getSessionQueueName(sessionId: string): string {
    return `${DEFAULT_SESSION_JOBS_QUEUE_PREFIX}.${sessionId}`;
  }

  async connect(): Promise<void> {
    this.closing = false;
    const connected = await this.ensureConnected();
    if (!connected) {
      throw new RabbitMQUnavailableError('RabbitMQ connection unavailable during startup');
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.publishBuffer.close();

    try {
      await this.reconnectPromise;
    } catch {
      // Ignore reconnect failures while closing.
    }

    const connection = this.connection;
    this.clearConnectionState();

    await connection?.close();
  }

  async publish(message: Task): Promise<boolean> {
    const buffer = Buffer.from(JSON.stringify(message));
    return this.publishBuffer.enqueue({
      operationName: 'publish task',
      publish: (channel) => channel.sendToQueue(this.queueName, buffer, { persistent: true }),
    });
  }

  async ensureSessionJobQueue(sessionId: string): Promise<string> {
    const queueName = RabbitMQService.getSessionQueueName(sessionId);
    await this.withChannel('ensure session queue', async (channel) => {
      await this.assertSessionJobQueue(channel, sessionId);
    });
    return queueName;
  }

  async publishJob(message: Job): Promise<boolean> {
    const buffer = Buffer.from(JSON.stringify(message));
    return this.publishBuffer.enqueue({
      operationName: 'publish job',
      publish: async (channel) => {
        await this.assertSessionJobQueue(channel, message.session_id);
        return channel.publish(DEFAULT_JOBS_EXCHANGE_NAME, message.session_id, buffer, {
          persistent: true,
        });
      },
    });
  }

  async getNextJobFromSession(sessionId: string): Promise<Job | null> {
    return this.withChannel('get next job from session', async (channel) => {
      const queueName = RabbitMQService.getSessionQueueName(sessionId);
      const msg = await channel.get(queueName, { noAck: false });
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
        channel.ack(msg);
        return null;
      }

      deliveryMap.set(parsed.job_id, {
        message: msg as unknown as GetMessage,
        generation: this.connectionGeneration,
      });
      return parsed;
    });
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
    return this.finalizeTrackedDelivery(this.deliveryMap, taskId, 'ack');
  }

  async getNext(): Promise<Task | null> {
    return this.withChannel('get next task', async (channel) => {
      const msg = await channel.get(this.queueName, { noAck: false });
      if (msg === false) return null;

      const parsed = JSON.parse(msg.content.toString()) as Task;

      if (this.deliveryMap.has(parsed.task_id)) {
        logger.error(
          { task_id: parsed.task_id, deliveryTag: msg.fields.deliveryTag },
          'Duplicate task_id received while an earlier delivery is still outstanding; acknowledging duplicate message',
        );
        channel.ack(msg);
        return null;
      }

      this.deliveryMap.set(parsed.task_id, {
        message: msg as unknown as GetMessage,
        generation: this.connectionGeneration,
      });
      return parsed;
    });
  }

  async publishToExchange(exchange: string, message: TaskEvent): Promise<boolean> {
    const buffer = Buffer.from(JSON.stringify(message));
    return this.publishBuffer.enqueue({
      operationName: 'publish task event',
      publish: (channel) => channel.publish(exchange, '', buffer, { persistent: true }),
    });
  }

  async getNextFromQueue(queueName: string): Promise<TaskEvent | null> {
    return this.withChannel('get next task event', async (channel) => {
      const msg = await channel.get(queueName, { noAck: false });
      if (msg === false) return null;

      const parsed = JSON.parse(msg.content.toString()) as TaskEvent;
      const deliveryMap = this.getOrCreateDeliveryMap(queueName);

      const deliveryId = parsed.event_kind === 'phase'
        ? parsed.event_id
        : parsed.event_kind === 'mirror'
          ? parsed.mirror_id
          : parsed.result_id;

      if (deliveryMap.has(deliveryId)) {
        logger.error(
          { event_id: deliveryId, deliveryTag: msg.fields.deliveryTag, queueName, event_kind: parsed.event_kind },
          'Duplicate task-event id received while an earlier delivery is still outstanding; acknowledging duplicate message',
        );
        channel.ack(msg);
        return null;
      }

      deliveryMap.set(deliveryId, {
        message: msg as unknown as GetMessage,
        generation: this.connectionGeneration,
      });
      return parsed;
    });
  }

  ackFromQueue(queueName: string, eventId: string): boolean {
    const deliveryMap = this.queueDeliveryMaps.get(queueName);
    if (!deliveryMap) return false;
    return this.finalizeTrackedDelivery(deliveryMap, eventId, 'ack');
  }

  async ensureConnected(): Promise<boolean> {
    if (this.connection !== null && this.channel !== null) {
      return true;
    }

    if (this.closing) {
      return false;
    }

    if (!this.reconnectPromise) {
      this.reconnectPromise = this.establishConnection().finally(() => {
        this.reconnectPromise = null;
      });
    }

    try {
      await this.reconnectPromise;
      return this.connection !== null && this.channel !== null;
    } catch (err) {
      logger.warn({ err }, 'RabbitMQ reconnect attempt failed');
      return false;
    }
  }

  private async establishConnection(): Promise<void> {
    const conn = await amqplib.connect(this.url);

    try {
      const channel = await conn.createChannel();
      await this.assertBaseTopology(channel);
      this.attachConnectionListeners(conn);
      this.connection = conn;
      this.channel = channel;
      this.connectionGeneration += 1;

      // Deliveries tied to a dead channel cannot be ACKed safely after reconnect.
      // Clearing them forces later ACK calls to return false and rely on redelivery.
      this.clearDeliveryTracking();
      this.publishBuffer.requestFlush();
    } catch (err) {
      await conn.close().catch(() => undefined);
      throw err;
    }
  }

  private attachConnectionListeners(conn: amqplib.ChannelModel): void {
    conn.on('error', (err) => {
      logger.warn({ err }, 'RabbitMQ connection error');
      this.handleConnectionEvent(conn);
    });
    conn.on('close', () => {
      logger.warn('RabbitMQ connection closed');
      this.handleConnectionEvent(conn);
    });
  }

  private handleConnectionEvent(conn: amqplib.ChannelModel): void {
    if (this.connection !== conn) {
      return;
    }
    this.clearConnectionState();
  }

  private clearConnectionState(): void {
    this.connection = null;
    this.channel = null;
    this.clearDeliveryTracking();
  }

  private clearDeliveryTracking(): void {
    this.deliveryMap.clear();
    this.queueDeliveryMaps.clear();
  }

  private async assertBaseTopology(channel: amqplib.Channel): Promise<void> {
    await channel.assertQueue(this.queueName, { durable: true });
    await channel.assertExchange(DEFAULT_JOBS_EXCHANGE_NAME, 'direct', { durable: true });
    await channel.assertExchange(DEFAULT_RESULTS_EXCHANGE_NAME, 'fanout', { durable: true });
    await channel.assertQueue(DEFAULT_LARK_QUEUE_NAME, { durable: true });
    await channel.bindQueue(DEFAULT_LARK_QUEUE_NAME, DEFAULT_RESULTS_EXCHANGE_NAME, '');
    await channel.assertQueue(DEFAULT_TELEGRAM_QUEUE_NAME, { durable: true });
    await channel.bindQueue(DEFAULT_TELEGRAM_QUEUE_NAME, DEFAULT_RESULTS_EXCHANGE_NAME, '');
  }

  private async assertSessionJobQueue(channel: amqplib.Channel, sessionId: string): Promise<void> {
    const queueName = RabbitMQService.getSessionQueueName(sessionId);
    await channel.assertQueue(queueName, {
      durable: true,
      arguments: { 'x-expires': DEFAULT_SESSION_QUEUE_IDLE_TTL_MS },
    });
    await channel.bindQueue(queueName, DEFAULT_JOBS_EXCHANGE_NAME, sessionId);
  }

  private async withChannel<T>(
    operationName: string,
    operation: (channel: amqplib.Channel) => Promise<T> | T,
  ): Promise<T> {
    if (!(await this.ensureConnected())) {
      throw new RabbitMQUnavailableError();
    }

    const channel = this.channel;
    if (!channel) {
      throw new RabbitMQUnavailableError();
    }

    try {
      return await operation(channel);
    } catch (err) {
      if (!this.isRetryableChannelError(err)) {
        throw err;
      }

      logger.warn({ err, operationName }, 'RabbitMQ channel unavailable during operation; reconnecting');
      this.clearConnectionState();

      if (!(await this.ensureConnected())) {
        throw new RabbitMQUnavailableError();
      }

      const retryChannel = this.channel;
      if (!retryChannel) {
        throw new RabbitMQUnavailableError();
      }

      try {
        return await operation(retryChannel);
      } catch (retryErr) {
        if (!this.isRetryableChannelError(retryErr)) {
          throw retryErr;
        }

        logger.warn({ err: retryErr, operationName }, 'RabbitMQ channel unavailable after reconnect retry');
        this.clearConnectionState();
        throw new RabbitMQUnavailableError();
      }
    }
  }

  private finalizeJobDelivery(
    sessionId: string,
    jobId: string,
    mode: 'ack' | 'nack',
    requeue = true,
  ): boolean {
    const queueName = RabbitMQService.getSessionQueueName(sessionId);
    const deliveryMap = this.queueDeliveryMaps.get(queueName);
    if (!deliveryMap) return false;
    return this.finalizeTrackedDelivery(deliveryMap, jobId, mode, requeue);
  }

  private finalizeTrackedDelivery(
    deliveryMap: Map<string, TrackedDelivery>,
    deliveryId: string,
    mode: 'ack' | 'nack',
    requeue = true,
  ): boolean {
    if (!this.channel) return false;

    const delivery = deliveryMap.get(deliveryId);
    if (!delivery) return false;
    if (delivery.generation !== this.connectionGeneration) {
      deliveryMap.delete(deliveryId);
      return false;
    }

    try {
      if (mode === 'ack') {
        this.channel.ack(delivery.message as any);
      } else {
        this.channel.nack(delivery.message as any, false, requeue);
      }
    } catch (err) {
      if (this.isRetryableChannelError(err)) {
        // The original delivery belonged to a dead channel. We intentionally do
        // not reconnect and re-ACK because that would target the wrong delivery.
        this.clearConnectionState();
        deliveryMap.delete(deliveryId);
        return false;
      }
      throw err;
    }

    deliveryMap.delete(deliveryId);
    return true;
  }

  private getOrCreateDeliveryMap(queueName: string): Map<string, TrackedDelivery> {
    let deliveryMap = this.queueDeliveryMaps.get(queueName);
    if (!deliveryMap) {
      deliveryMap = new Map<string, TrackedDelivery>();
      this.queueDeliveryMaps.set(queueName, deliveryMap);
    }
    return deliveryMap;
  }

  private isRetryableChannelError(error: unknown): boolean {
    if (error instanceof RabbitMQUnavailableError) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();

    return (
      normalized.includes('channel closed') ||
      normalized.includes('channel ended') ||
      normalized.includes('connection closed') ||
      normalized.includes('connection ended') ||
      normalized.includes('not connected') ||
      normalized.includes('closing')
    );
  }
}
