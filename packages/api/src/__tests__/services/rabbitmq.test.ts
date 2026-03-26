import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RabbitMQService } from '../../services/rabbitmq';

vi.mock('amqplib', () => {
  const mockCh = {
    assertQueue: vi.fn().mockResolvedValue({}),
    sendToQueue: vi.fn().mockReturnValue(true),
    get: vi.fn(),
    ack: vi.fn(),
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
    // Re-wire after clearAllMocks
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
    it('sends persistent message to queue', async () => {
      await service.connect();
      const msg = { task_type: 'generic', payload: 'test' };
      const result = service.publish(msg);
      expect(result).toBe(true);
      expect(channel.sendToQueue).toHaveBeenCalledWith(
        'test-queue',
        expect.any(Buffer),
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

    it('returns task with generated ID when message available', async () => {
      await service.connect();
      const content = JSON.stringify({
        task_type: 'generic',
        payload: 'hello',
        submitted_at: '2026-03-26T00:00:00.000Z',
      });
      channel.get.mockResolvedValue({
        content: Buffer.from(content),
        fields: { deliveryTag: 42 },
      });
      const result = await service.getNext();
      expect(result).not.toBeNull();
      expect(result!.task_type).toBe('generic');
      expect(result!.payload).toBe('hello');
      expect(result!.task_id).toBeDefined();
    });
  });

  describe('ack', () => {
    it('acknowledges message by task ID', async () => {
      await service.connect();
      const content = JSON.stringify({
        task_type: 'generic',
        payload: 'hello',
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

    it('returns false for unknown task ID', async () => {
      await service.connect();
      const acked = service.ack('unknown-id');
      expect(acked).toBe(false);
    });
  });
});
