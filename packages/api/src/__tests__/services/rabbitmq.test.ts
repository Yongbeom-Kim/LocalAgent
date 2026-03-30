import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RabbitMQService } from '../../services/rabbitmq';

vi.mock('amqplib', () => {
  const mockCh = {
    assertQueue: vi.fn().mockResolvedValue({}),
    sendToQueue: vi.fn().mockReturnValue(true),
    get: vi.fn(),
    ack: vi.fn(),
    nack: vi.fn(),
    assertExchange: vi.fn().mockResolvedValue({}),
    bindQueue: vi.fn().mockResolvedValue({}),
    publish: vi.fn().mockReturnValue(true),
  };
  const mockConn = {
    createChannel: vi.fn().mockResolvedValue(mockCh),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };
  return {
    default: {
      connect: vi.fn().mockResolvedValue(mockConn),
    },
    __mockChannel: mockCh,
    __mockConnection: mockConn,
  };
});

describe('RabbitMQService', () => {
  let amqplibMock: any;
  let service: RabbitMQService;
  let channel: any;
  let connection: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    amqplibMock = await import('amqplib');
    channel = (amqplibMock as any).__mockChannel;
    connection = (amqplibMock as any).__mockConnection;
    connection.createChannel.mockResolvedValue(channel);
    (amqplibMock.default.connect as any).mockResolvedValue(connection);
    channel.assertQueue.mockResolvedValue({});
    channel.sendToQueue.mockReturnValue(true);
    service = new RabbitMQService('amqp://localhost', 'test-queue');
  });

  describe('connect', () => {
    it('connects and asserts durable queue', async () => {
      await service.connect();
      expect(channel.assertQueue).toHaveBeenCalledWith('test-queue', { durable: true });
    });
  });

  describe('publish', () => {
    it('sends persistent full task payload to queue', async () => {
      await service.connect();
      const msg = {
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'test',
        submitted_at: '2026-03-26T00:00:00.000Z',
      };
      const result = service.publish(msg);
      expect(result).toBe(true);
      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'test-queue',
        Buffer.from(JSON.stringify(msg)),
        { persistent: true }
      );
    });
  });

  describe('getNext', () => {
    it('returns null when queue is empty', async () => {
      await service.connect();
      channel.get.mockResolvedValue(false);
      const result = await service.getNext();
      expect(result).toBeNull();
    });

    it('returns task with preserved task ID and executor when message available', async () => {
      await service.connect();
      const content = JSON.stringify({
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'hello',
        executors: [{ executor: 'ttadk', executor_model: 'gpt-5.4' }],
        submitted_at: '2026-03-26T00:00:00.000Z',
      });
      channel.get.mockResolvedValue({
        content: Buffer.from(content),
        fields: { deliveryTag: 42 },
      });
      const result = await service.getNext();
      expect(result).not.toBeNull();
      expect(result).toEqual({
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'hello',
        executors: [{ executor: 'ttadk', executor_model: 'gpt-5.4' }],
        submitted_at: '2026-03-26T00:00:00.000Z',
      });
    });
  });

  describe('ack', () => {
    it('acknowledges message by task ID', async () => {
      await service.connect();
      const content = JSON.stringify({
        task_id: 'task-123',
        task_type: 'generic',
        payload: 'hello',
        executors: [{ executor: 'claude_code', executor_model: 'opus' }],
        submitted_at: '2026-03-26T00:00:00.000Z',
      });
      channel.get.mockResolvedValue({
        content: Buffer.from(content),
        fields: { deliveryTag: 42 },
      });
      const task = await service.getNext();
      const acked = service.ack(task!.task_id);
      expect(acked).toBe(true);
      expect(channel.ack).toHaveBeenCalledWith({ content: expect.any(Buffer), fields: { deliveryTag: 42 } });
    });

    it('acknowledges duplicate task IDs instead of overwriting the earlier ACK state', async () => {
      await service.connect();
      const firstMessage = {
        content: Buffer.from(JSON.stringify({
          task_id: 'duplicate-id',
          task_type: 'generic',
          payload: 'first',
          executors: [{ executor: 'claude_code', executor_model: 'opus' }],
          submitted_at: '2026-03-26T00:00:00.000Z',
        })),
        fields: { deliveryTag: 1 },
      };
      const secondMessage = {
        content: Buffer.from(JSON.stringify({
          task_id: 'duplicate-id',
          task_type: 'generic',
          payload: 'second',
          executors: [{ executor: 'ttadk', executor_model: 'gpt-5.4' }],
          submitted_at: '2026-03-26T00:00:01.000Z',
        })),
        fields: { deliveryTag: 2 },
      };
      channel.get
        .mockResolvedValueOnce(firstMessage)
        .mockResolvedValueOnce(secondMessage);

      const firstTask = await service.getNext();
      const duplicateTask = await service.getNext();

      expect(firstTask).toEqual({
        task_id: 'duplicate-id',
        task_type: 'generic',
        payload: 'first',
        executors: [{ executor: 'claude_code', executor_model: 'opus' }],
        submitted_at: '2026-03-26T00:00:00.000Z',
      });
      expect(duplicateTask).toBeNull();
      expect(channel.ack).toHaveBeenCalledWith(secondMessage);
      expect(channel.nack).not.toHaveBeenCalled();
      expect(service.ack('duplicate-id')).toBe(true);
      expect(channel.ack).toHaveBeenCalledTimes(2);
      expect(channel.ack).toHaveBeenCalledWith(firstMessage);
      expect(service.ack('duplicate-id')).toBe(false);
    });

    it('returns false for unknown task ID', async () => {
      await service.connect();
      const acked = service.ack('unknown-id');
      expect(acked).toBe(false);
    });
  });

  describe('connect — exchange topology', () => {
    it('asserts results fanout exchange and lark-messages queue with binding', async () => {
      await service.connect();
      expect(channel.assertExchange).toHaveBeenCalledWith('results', 'fanout', { durable: true });
      expect(channel.assertQueue).toHaveBeenCalledWith('lark-messages', { durable: true });
      expect(channel.bindQueue).toHaveBeenCalledWith('lark-messages', 'results', '');
    });
  });

  describe('publishToExchange', () => {
    it('publishes persistent message to named exchange', async () => {
      await service.connect();
      const msg = {
        result_id: 'res-1',
        job_id: 'job-456',
        task_id: 'task-123',
        status: 'success' as const,
        exit_code: 0,
        stdout: 'output',
        stderr: '',
        completed_at: '2026-03-27T00:00:00.000Z',
      };
      const result = service.publishToExchange('results', msg);
      expect(result).toBe(true);
      expect(channel.publish).toHaveBeenCalledWith(
        'results',
        '',
        Buffer.from(JSON.stringify(msg)),
        { persistent: true },
      );
    });

    it('throws when not connected', () => {
      expect(() => service.publishToExchange('results', {} as any)).toThrow('Not connected');
    });
  });

  describe('getNextFromQueue', () => {
    it('returns null when queue is empty', async () => {
      await service.connect();
      channel.get.mockResolvedValue(false);
      const result = await service.getNextFromQueue('lark-messages');
      expect(result).toBeNull();
      expect(channel.get).toHaveBeenCalledWith('lark-messages', { noAck: false });
    });

    it('returns result when message available', async () => {
      await service.connect();
      const content = JSON.stringify({
        result_id: 'res-1',
        job_id: 'job-456',
        task_id: 'task-123',
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
    });
  });

  describe('ackFromQueue', () => {
    it('acknowledges result by result_id and queue name', async () => {
      await service.connect();
      const msg = {
        content: Buffer.from(JSON.stringify({
          result_id: 'res-1',
          job_id: 'job-456',
          task_id: 'task-123',
          status: 'success',
          exit_code: 0,
          stdout: 'output',
          stderr: '',
          completed_at: '2026-03-27T00:00:00.000Z',
        })),
        fields: { deliveryTag: 99 },
      };
      channel.get.mockResolvedValue(msg);
      await service.getNextFromQueue('lark-messages');
      const acked = service.ackFromQueue('lark-messages', 'res-1');
      expect(acked).toBe(true);
      expect(channel.ack).toHaveBeenCalledWith(msg);
    });

    it('returns false for unknown result_id', async () => {
      await service.connect();
      const acked = service.ackFromQueue('lark-messages', 'unknown');
      expect(acked).toBe(false);
    });
  });
});
