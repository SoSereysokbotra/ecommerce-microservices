import { RabbitMQService } from '@libs/rabbitmq';

describe('RabbitMQ Dead Letter Queue & Resilience', () => {
  let service: RabbitMQService;
  let mockChannel: Record<string, jest.Mock>;
  let mockConnection: Record<string, jest.Mock>;

  beforeEach(() => {
    mockChannel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue({ messageCount: 0, consumerCount: 0 }),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockReturnValue(true),
      consume: jest.fn().mockResolvedValue({ consumerTag: 'tag-1' }),
      ack: jest.fn(),
      nack: jest.fn(),
      checkQueue: jest.fn().mockResolvedValue({ messageCount: 12, consumerCount: 1 }),
      get: jest.fn(),
      purgeQueue: jest.fn().mockResolvedValue({ messageCount: 5 }),
      close: jest.fn().mockResolvedValue(undefined),
    };

    mockConnection = {
      createChannel: jest.fn().mockResolvedValue(mockChannel),
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };

    service = new RabbitMQService({
      url: 'amqp://localhost:5672',
      exchange: 'commerce.events',
      queue: 'orders-service',
      dlxExchange: 'commerce.dlx',
      maxRetries: 3,
      retryBackoffMs: 100,
    });

    (service as unknown as { connection: unknown }).connection = mockConnection;
    (service as unknown as { channel: unknown }).channel = mockChannel;
  });

  it('correctly reports queue and DLQ message depths', async () => {
    const stats = await service.getQueueStats('orders-service');
    expect(stats.queue).toBe('orders-service');
    expect(stats.dlqQueue).toBe('orders-service.dlq');
    expect(stats.messageCount).toBe(12);
    expect(mockChannel.checkQueue).toHaveBeenCalledWith('orders-service');
    expect(mockChannel.checkQueue).toHaveBeenCalledWith('orders-service.dlq');
  });

  it('replays quarantined messages with cleaned headers', async () => {
    const deadLetterMsg = {
      fields: { routingKey: 'order.dispatched' },
      properties: {
        headers: {
          'x-retry-count': 3,
          'x-quarantine-reason': 'MaxRetriesExceeded',
          'x-quarantine-error': 'ServiceUnavailable',
          'x-original-routing-key': 'order.confirmed',
          'x-correlation-id': 'corr-abc-123',
        },
      },
      content: Buffer.from(JSON.stringify({ orderId: 'ord-test-456' })),
    };

    mockChannel.get.mockResolvedValueOnce(deadLetterMsg).mockResolvedValueOnce(false);

    const result = await service.replayDeadLetters({ queue: 'orders-service', limit: 5 });
    expect(result.replayed).toBe(1);
    expect(result.errors).toBe(0);

    expect(mockChannel.publish).toHaveBeenCalledWith(
      'commerce.events',
      'order.confirmed',
      deadLetterMsg.content,
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-correlation-id': 'corr-abc-123',
          'x-replayed-at': expect.any(String),
        }),
      }),
    );
    expect(mockChannel.ack).toHaveBeenCalledWith(deadLetterMsg);
  });

  it('purges quarantined messages from DLQ', async () => {
    const res = await service.purgeDeadLetters('orders-service');
    expect(res.purged).toBe(5);
    expect(mockChannel.purgeQueue).toHaveBeenCalledWith('orders-service.dlq');
  });
});
