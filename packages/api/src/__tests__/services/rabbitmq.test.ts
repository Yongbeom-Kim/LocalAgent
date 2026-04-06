import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RabbitMQService, RabbitMQUnavailableError } from '../../services/rabbitmq';

type MockChannel = ReturnType<typeof createMockChannel>;
type MockConnection = ReturnType<typeof createMockConnection>;

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createMockChannel() {
  return {
    assertQueue: vi.fn().mockResolvedValue({}),
    sendToQueue: vi.fn().mockReturnValue(true),
    get: vi.fn().mockResolvedValue(false),
    ack: vi.fn(),
    nack: vi.fn(),
    assertExchange: vi.fn().mockResolvedValue({}),
    bindQueue: vi.fn().mockResolvedValue({}),
    publish: vi.fn().mockReturnValue(true),
  };
}

function createMockConnection(channel: MockChannel) {
  const handlers: Record<string, ((...args: any[]) => void) | undefined> = {};
  return {
    createChannel: vi.fn().mockResolvedValue(channel),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers[event] = handler;
    }),
    handlers,
  };
}

vi.mock('amqplib', () => {
  const queuedConnections: MockConnection[] = [];
  const connect = vi.fn(async () => {
    const next = queuedConnections.shift();
    if (!next) {
      throw new Error('No mocked RabbitMQ connection queued');
    }
    return next;
  });

  return {
    default: { connect },
    __queueConnection: (connection: MockConnection) => {
      queuedConnections.push(connection);
    },
  };
});

describe('RabbitMQService', () => {
  let amqplibMock: any;
  let service: RabbitMQService;
  let channel: MockChannel;
  let connection: MockConnection;

  function queueConnection(nextChannel = createMockChannel()): { channel: MockChannel; connection: MockConnection } {
    const nextConnection = createMockConnection(nextChannel);
    amqplibMock.__queueConnection(nextConnection);
    return { channel: nextChannel, connection: nextConnection };
  }

  function emitConnectionEvent(conn: MockConnection, event: 'error' | 'close', ...args: any[]): void {
    conn.handlers[event]?.(...args);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    amqplibMock = await import('amqplib');
    channel = createMockChannel();
    connection = createMockConnection(channel);
    amqplibMock.__queueConnection(connection);
    service = new RabbitMQService('amqp://localhost', 'test-queue');
  });

  it('connects and asserts durable task queue and jobs exchange', async () => {
    await service.connect();
    expect(channel.assertQueue).toHaveBeenCalledWith('test-queue', { durable: true });
    expect(channel.assertExchange).toHaveBeenCalledWith('jobs', 'direct', { durable: true });
  });

  it('sends persistent full task payload to queue', async () => {
    await service.connect();
    const msg = {
      task_id: 'task-123',
      task_type: 'generic',
      payload: 'test',
      submitted_at: '2026-03-26T00:00:00.000Z',
    };
    const result = await service.publish(msg);
    expect(result).toBe(true);
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      'test-queue',
      Buffer.from(JSON.stringify(msg)),
      { persistent: true },
    );
  });

  it('reconnects on demand when a publish is attempted after connection loss', async () => {
    await service.connect();
    const second = queueConnection();
    emitConnectionEvent(connection, 'close');

    const result = await service.publish({
      task_id: 'task-123',
      task_type: 'generic',
      payload: 'test',
      submitted_at: '2026-03-26T00:00:00.000Z',
    });

    expect(result).toBe(true);
    await flushAsyncWork();
    expect(amqplibMock.default.connect).toHaveBeenCalledTimes(2);
    expect(second.channel.sendToQueue).toHaveBeenCalledTimes(1);
  });

  it('shares one reconnect attempt across concurrent callers', async () => {
    await service.connect();
    const second = queueConnection();
    second.channel.get.mockResolvedValue(false);
    emitConnectionEvent(connection, 'close');

    const [publishResult, nextResult] = await Promise.all([
      service.publish({
        task_id: 'task-1',
        task_type: 'generic',
        payload: 'a',
        submitted_at: '2026-03-26T00:00:00.000Z',
      }),
      service.getNext(),
    ]);

    expect(publishResult).toBe(true);
    expect(nextResult).toBeNull();
    expect(amqplibMock.default.connect).toHaveBeenCalledTimes(2);
    expect(second.channel.sendToQueue).toHaveBeenCalledTimes(1);
    expect(second.channel.get).toHaveBeenCalledTimes(1);
  });

  it('accepts publishes into the buffer when reconnect cannot establish a channel immediately', async () => {
    await service.connect();
    amqplibMock.default.connect.mockRejectedValueOnce(new Error('connect failed'));
    emitConnectionEvent(connection, 'close');

    await expect(
      service.publish({
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'test',
        submitted_at: '2026-03-26T00:00:00.000Z',
      }),
    ).resolves.toBe(true);
  });

  it('propagates non-retryable publish failures to the caller when the first flush can reach RabbitMQ', async () => {
    await service.connect();
    channel.sendToQueue.mockImplementationOnce(() => {
      throw new Error('queue missing');
    });

    await expect(
      service.publish({
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'test',
        submitted_at: '2026-03-26T00:00:00.000Z',
      }),
    ).rejects.toThrow('queue missing');
  });

  it('buffers task publishes while RabbitMQ is down and flushes them after reconnect', async () => {
    await service.connect();
    emitConnectionEvent(connection, 'close');
    amqplibMock.default.connect.mockRejectedValueOnce(new Error('connect failed'));

    const task = {
      task_id: 'task-buffered',
      task_type: 'generic',
      payload: 'buffer me',
      submitted_at: '2026-04-06T00:00:00.000Z',
    };

    const accepted = await service.publish(task);
    await flushAsyncWork();

    expect(accepted).toBe(true);
    expect(amqplibMock.default.connect).toHaveBeenCalledTimes(2);

    const second = queueConnection();
    await service.ensureConnected();
    await flushAsyncWork();

    expect(second.channel.sendToQueue).toHaveBeenCalledWith(
      'test-queue',
      Buffer.from(JSON.stringify(task)),
      { persistent: true },
    );
  });

  it('buffers exchange publishes while RabbitMQ is down and flushes them after reconnect', async () => {
    await service.connect();
    emitConnectionEvent(connection, 'close');
    amqplibMock.default.connect.mockRejectedValueOnce(new Error('connect failed'));

    const event = {
      event_kind: 'result' as const,
      result_id: 'res-buffered',
      job_id: 'job-1',
      task_id: 'task-1',
      task_type: 'generic',
      status: 'success' as const,
      exit_code: 0,
      stdout: 'ok',
      stderr: '',
      completed_at: '2026-04-06T00:00:00.000Z',
    };

    const accepted = await service.publishToExchange('results', event);
    await flushAsyncWork();

    expect(accepted).toBe(true);

    const second = queueConnection();
    await service.ensureConnected();
    await flushAsyncWork();

    expect(second.channel.publish).toHaveBeenCalledWith(
      'results',
      '',
      Buffer.from(JSON.stringify(event)),
      { persistent: true },
    );
  });

  it('asserts and binds per-session queues with idle ttl', async () => {
    await service.connect();
    const queueName = await service.ensureSessionJobQueue('session-1');
    expect(queueName).toBe('jobs.session.session-1');
    expect(channel.assertQueue).toHaveBeenCalledWith('jobs.session.session-1', {
      durable: true,
      arguments: { 'x-expires': 3600000 },
    });
    expect(channel.bindQueue).toHaveBeenCalledWith('jobs.session.session-1', 'jobs', 'session-1');
  });

  it('publishes jobs to the jobs exchange with session_id as routing key', async () => {
    await service.connect();
    const job = {
      job_id: 'job-1',
      task_id: 'task-1',
      task_type: 'generic',
      payload: 'hello',
      executors: [{ executor: 'claude', executor_model: 'sonnet' }],
      submitted_at: '2026-03-31T00:00:00.000Z',
      session_id: 'session-1',
      enriched_at: '2026-03-31T00:00:01.000Z',
    };
    const result = await service.publishJob(job as any);
    expect(result).toBe(true);
    await flushAsyncWork();
    expect(channel.publish).toHaveBeenCalledWith(
      'jobs',
      'session-1',
      Buffer.from(JSON.stringify(job)),
      { persistent: true },
    );
  });

  it('reads and acks jobs from a specific session queue', async () => {
    await service.connect();
    await service.ensureSessionJobQueue('session-1');
    const content = JSON.stringify({
      job_id: 'job-789',
      task_id: 'task-123',
      task_type: 'generic',
      payload: 'hello',
      executors: [{ executor: 'claude', executor_model: 'sonnet' }],
      submitted_at: '2026-03-31T00:00:00.000Z',
      session_id: 'session-1',
      enriched_at: '2026-03-31T00:00:01.000Z',
    });
    const msg = {
      content: Buffer.from(content),
      fields: { deliveryTag: 55 },
    };
    channel.get.mockResolvedValue(msg);

    const job = await service.getNextJobFromSession('session-1');
    expect(job).not.toBeNull();
    expect(channel.get).toHaveBeenCalledWith('jobs.session.session-1', { noAck: false });

    const acked = service.ackJobFromSession('session-1', 'job-789');
    expect(acked).toBe(true);
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('clears stale delivery maps when reconnecting after channel loss', async () => {
    await service.connect();
    await service.ensureSessionJobQueue('session-1');
    channel.get.mockResolvedValue({
      content: Buffer.from(JSON.stringify({
        job_id: 'job-789',
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'hello',
        executors: [{ executor: 'claude', executor_model: 'sonnet' }],
        submitted_at: '2026-03-31T00:00:00.000Z',
        session_id: 'session-1',
        enriched_at: '2026-03-31T00:00:01.000Z',
      })),
      fields: { deliveryTag: 55 },
    });
    await service.getNextJobFromSession('session-1');

    queueConnection();
    emitConnectionEvent(connection, 'close');
    await service.ensureConnected();

    expect(service.ackJobFromSession('session-1', 'job-789')).toBe(false);
  });

  it('returns null when queue is empty', async () => {
    await service.connect();
    channel.get.mockResolvedValue(false);
    const result = await service.getNext();
    expect(result).toBeNull();
  });

  it('acknowledges duplicate task IDs instead of overwriting the earlier ACK state', async () => {
    await service.connect();
    const firstMessage = {
      content: Buffer.from(JSON.stringify({
        task_id: 'duplicate-id',
        task_type: 'generic',
        payload: 'first',
        submitted_at: '2026-03-26T00:00:00.000Z',
      })),
      fields: { deliveryTag: 1 },
    };
    const secondMessage = {
      content: Buffer.from(JSON.stringify({
        task_id: 'duplicate-id',
        task_type: 'generic',
        payload: 'second',
        submitted_at: '2026-03-26T00:00:01.000Z',
      })),
      fields: { deliveryTag: 2 },
    };
    channel.get.mockResolvedValueOnce(firstMessage).mockResolvedValueOnce(secondMessage);

    const firstTask = await service.getNext();
    const duplicateTask = await service.getNext();

    expect(firstTask?.task_id).toBe('duplicate-id');
    expect(duplicateTask).toBeNull();
    expect(channel.ack).toHaveBeenCalledWith(secondMessage);
    expect(service.ack('duplicate-id')).toBe(true);
  });

  it('publishes persistent message to named exchange', async () => {
    await service.connect();
    const msg = {
      event_kind: 'result' as const,
      result_id: 'res-1',
      job_id: 'job-456',
      task_id: 'task-123',
      task_type: 'generic',
      status: 'success' as const,
      exit_code: 0,
      stdout: 'output',
      stderr: '',
      completed_at: '2026-03-27T00:00:00.000Z',
    };
    const result = await service.publishToExchange('results', msg);
    expect(result).toBe(true);
    expect(channel.publish).toHaveBeenCalledWith(
      'results',
      '',
      Buffer.from(JSON.stringify(msg)),
      { persistent: true },
    );
  });

  it('returns result when message available', async () => {
    await service.connect();
    const content = JSON.stringify({
      event_kind: 'result',
      result_id: 'res-1',
      job_id: 'job-456',
      task_id: 'task-123',
      task_type: 'generic',
      status: 'success',
      exit_code: 0,
      stdout: 'output',
      stderr: '',
      completed_at: '2026-03-27T00:00:00.000Z',
    });
    channel.get.mockResolvedValue({
      content: Buffer.from(content),
      fields: { deliveryTag: 99 },
    });
    const result = await service.getNextFromQueue('lark-messages');
    expect(result).toEqual(JSON.parse(content));
    expect(service.ackFromQueue('lark-messages', 'res-1')).toBe(true);
  });

  it('tracks phase event deliveries by event_id', async () => {
    await service.connect();
    const content = JSON.stringify({
      event_kind: 'phase',
      event_id: 'evt-1',
      task_id: 'task-123',
      task_type: 'generic',
      phase: 'executing',
      emitted_at: '2026-04-05T00:00:00.000Z',
      metadata: { emitted_by: 'task-daemon' },
    });
    channel.get.mockResolvedValue({
      content: Buffer.from(content),
      fields: { deliveryTag: 100 },
    });

    const event = await service.getNextFromQueue('lark-messages');

    expect(event).toEqual(JSON.parse(content));
    expect(service.ackFromQueue('lark-messages', 'evt-1')).toBe(true);
  });
});
