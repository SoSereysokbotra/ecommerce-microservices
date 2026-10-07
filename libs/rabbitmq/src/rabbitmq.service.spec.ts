import { RabbitMQService } from './rabbitmq.service';

describe('RabbitMQService - Resilience & DLQ', () => {
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
      checkQueue: jest.fn().mockResolvedValue({ messageCount: 5, consumerCount: 1 }),
      get: jest.fn(),
      purgeQueue: jest.fn().mockResolvedValue({ messageCount: 3 }),
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
      retryBackoffMs: 50,
    });

    (service as unknown as { connection: unknown }).connection = mockConnection;
    (service as unknown as { channel: unknown }).channel = mockChannel;
  });

  it('initializes default exchange and DLX parameters correctly', () => {
    expect(service.getExchange()).toBe('commerce.events');
    expect(service.getDlxExchange()).toBe('commerce.dlx');
    expect(service.getQueueName()).toBe('orders-service');
  });

  it('checks queue stats including dead letter queue depth', async () => {
    const stats = await service.getQueueStats('orders-service');
    expect(stats.queue).toBe('orders-service');
    expect(stats.dlqQueue).toBe('orders-service.dlq');
    expect(stats.messageCount).toBe(5);
    expect(mockChannel.checkQueue).toHaveBeenCalledWith('orders-service');
    expect(mockChannel.checkQueue).toHaveBeenCalledWith('orders-service.dlq');
  });

  it('replays dead-lettered messages back to main exchange with cleaned headers', async () => {
    const deadLetterMsg = {
      fields: { routingKey: 'order.failed' },
      properties: {
        headers: {
          'x-retry-count': 3,
          'x-quarantine-reason': 'MaxRetriesExceeded',
          'x-quarantine-error': 'Connection timeout',
          'x-original-routing-key': 'order.confirmed',
          'x-correlation-id': 'test-corr-1',
        },
      },
      content: Buffer.from(JSON.stringify({ orderId: 'ord-123' })),
    };

    mockChannel.get.mockResolvedValueOnce(deadLetterMsg).mockResolvedValueOnce(false);

    const result = await service.replayDeadLetters({ queue: 'orders-service', limit: 10 });
    expect(result.replayed).toBe(1);
    expect(result.errors).toBe(0);

    expect(mockChannel.publish).toHaveBeenCalledWith(
      'commerce.events',
      'order.confirmed',
      deadLetterMsg.content,
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-correlation-id': 'test-corr-1',
          'x-replayed-at': expect.any(String),
        }),
      }),
    );
    expect(mockChannel.ack).toHaveBeenCalledWith(deadLetterMsg);
  });

  it('purges dead letter queue', async () => {
    const result = await service.purgeDeadLetters('orders-service');
    expect(result.purged).toBe(3);
    expect(mockChannel.purgeQueue).toHaveBeenCalledWith('orders-service.dlq');
  });
});
