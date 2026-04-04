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
    channel.publish.mockReturnValue(true);
    service = new RabbitMQService('amqp://localhost', 'test-queue');
  });

  describe('connect', () => {
    it('connects and asserts durable task queue and jobs exchange', async () => {
      await service.connect();
      expect(channel.assertQueue).toHaveBeenCalledWith('test-queue', { durable: true });
      expect(channel.assertExchange).toHaveBeenCalledWith('jobs', 'direct', { durable: true });
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
        { persistent: true },
      );
    });
  });

  describe('session job queues', () => {
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
      expect(channel.publish).toHaveBeenCalledWith(
        'jobs',
        'session-1',
        Buffer.from(JSON.stringify(job)),
        { persistent: true },
      );
      expect(service.listActiveSessions()).toEqual([
        { session_id: 'session-1', queue_name: 'jobs.session.session-1', head_task_type: 'generic' },
      ]);
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

    it('tracks deliveries independently across session queues', async () => {
      await service.connect();
      await service.ensureSessionJobQueue('session-a');
      await service.ensureSessionJobQueue('session-b');

      channel.get
        .mockResolvedValueOnce({
          content: Buffer.from(JSON.stringify({
            job_id: 'job-a',
            task_id: 'task-a',
            task_type: 'generic',
            payload: 'a',
            executors: [{ executor: 'claude', executor_model: 'sonnet' }],
            submitted_at: '2026-03-31T00:00:00.000Z',
            session_id: 'session-a',
            enriched_at: '2026-03-31T00:00:01.000Z',
          })),
          fields: { deliveryTag: 1 },
        })
        .mockResolvedValueOnce({
          content: Buffer.from(JSON.stringify({
            job_id: 'job-b',
            task_id: 'task-b',
            task_type: 'generic',
            payload: 'b',
            executors: [{ executor: 'claude', executor_model: 'sonnet' }],
            submitted_at: '2026-03-31T00:00:00.000Z',
            session_id: 'session-b',
            enriched_at: '2026-03-31T00:00:01.000Z',
          })),
          fields: { deliveryTag: 2 },
        });

      await service.getNextJobFromSession('session-a');
      await service.getNextJobFromSession('session-b');

      expect(service.ackJobFromSession('session-a', 'job-a')).toBe(true);
      expect(service.ackJobFromSession('session-b', 'job-b')).toBe(true);
      expect(channel.ack).toHaveBeenCalledTimes(2);
    });

    it('lists active sessions in stable order', async () => {
      await service.connect();
      await service.publishJob({
        job_id: 'job-b',
        task_id: 'task-b',
        task_type: 'kill',
        payload: '',
        executors: [{ executor: 'builtin', executor_model: 'none' }],
        submitted_at: '2026-03-31T00:00:00.000Z',
        session_id: 'session-b',
        enriched_at: '2026-03-31T00:00:01.000Z',
      } as any);
      await service.publishJob({
        job_id: 'job-a',
        task_id: 'task-a',
        task_type: 'generic',
        payload: 'a',
        executors: [{ executor: 'claude', executor_model: 'sonnet' }],
        submitted_at: '2026-03-31T00:00:00.000Z',
        session_id: 'session-a',
        enriched_at: '2026-03-31T00:00:01.000Z',
      } as any);
      expect(service.listActiveSessions()).toEqual([
        { session_id: 'session-a', queue_name: 'jobs.session.session-a', head_task_type: 'generic' },
        { session_id: 'session-b', queue_name: 'jobs.session.session-b', head_task_type: 'kill' },
      ]);
    });

    it('restores the session head task type when a job is nacked for requeue', async () => {
      await service.connect();
      const job = {
        job_id: 'job-kill',
        task_id: 'task-kill',
        task_type: 'kill',
        payload: '',
        executors: [{ executor: 'builtin', executor_model: 'none' }],
        submitted_at: '2026-03-31T00:00:00.000Z',
        session_id: 'session-1',
        enriched_at: '2026-03-31T00:00:01.000Z',
      };

      await service.publishJob(job as any);
      channel.get.mockResolvedValueOnce({
        content: Buffer.from(JSON.stringify(job)),
        fields: { deliveryTag: 77 },
      });

      await service.getNextJobFromSession('session-1');
      expect(service.listActiveSessions()).toEqual([
        { session_id: 'session-1', queue_name: 'jobs.session.session-1', head_task_type: null },
      ]);

      expect(service.nackJobFromSession('session-1', 'job-kill')).toBe(true);
      expect(service.listActiveSessions()).toEqual([
        { session_id: 'session-1', queue_name: 'jobs.session.session-1', head_task_type: 'kill' },
      ]);
    });
  });

  describe('getNext', () => {
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
  });

  describe('getNextFromQueue', () => {
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
      expect(service.ackFromQueue('lark-messages', 'res-1')).toBe(true);
    });
  });
});
