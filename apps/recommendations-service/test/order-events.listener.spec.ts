import { EntityManager } from 'typeorm';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { IdempotencyService } from '@libs/outbox';
import { OrderEventsListener } from '../src/events/order-events.listener';
import { RecommendationsService } from '../src/modules/recommendations/recommendations.service';

function createDomainEvent<T>(
  eventType: string,
  eventId: string,
  payload: T,
  aggregateId = 'ord-default',
): DomainEvent<T> {
  return {
    eventId,
    eventType,
    aggregateId,
    correlationId: 'corr-test',
    version: 1,
    occurredAt: new Date().toISOString(),
    payload,
  };
}

describe('OrderEventsListener', () => {
  let listener: OrderEventsListener;
  let rabbitmqMock: jest.Mocked<RabbitMQService>;
  let idempotencyMock: jest.Mocked<IdempotencyService>;
  let recommendationsMock: jest.Mocked<RecommendationsService>;
  let managerMock: jest.Mocked<EntityManager>;

  beforeEach(() => {
    rabbitmqMock = {
      subscribe: jest.fn(),
      publish: jest.fn(),
    } as unknown as jest.Mocked<RabbitMQService>;

    idempotencyMock = {
      handleOnce: jest.fn(),
    } as unknown as jest.Mocked<IdempotencyService>;

    recommendationsMock = {
      recordCoPurchases: jest.fn().mockResolvedValue(2),
    } as unknown as jest.Mocked<RecommendationsService>;

    managerMock = {
      // manager.query returns snake_case column names, never entity properties.
      query: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<EntityManager>;

    listener = new OrderEventsListener(rabbitmqMock, idempotencyMock, recommendationsMock);
  });

  it('skips an order with no items', async () => {
    const event = createDomainEvent('order.confirmed', 'evt-100', {
      orderId: 'ord-100',
      items: [],
    });

    await listener.handle(event);

    expect(idempotencyMock.handleOnce).not.toHaveBeenCalled();
    expect(recommendationsMock.recordCoPurchases).not.toHaveBeenCalled();
  });

  it('skips an order with missing items payload', async () => {
    const event = createDomainEvent('order.confirmed', 'evt-101', {
      orderId: 'ord-101',
    });

    await listener.handle(event);

    expect(idempotencyMock.handleOnce).not.toHaveBeenCalled();
    expect(recommendationsMock.recordCoPurchases).not.toHaveBeenCalled();
  });

  it('skips an order with fewer than 2 distinct products', async () => {
    const event = createDomainEvent('order.confirmed', 'evt-102', {
      orderId: 'ord-102',
      items: [{ productId: 'prod-single' }, { productId: 'prod-single' }],
    });

    await listener.handle(event);

    expect(idempotencyMock.handleOnce).not.toHaveBeenCalled();
    expect(recommendationsMock.recordCoPurchases).not.toHaveBeenCalled();
  });

  it('ensures a duplicate event does not reach the service', async () => {
    // When an event was already processed, handleOnce returns false and does not invoke the callback.
    idempotencyMock.handleOnce.mockResolvedValue(false);

    const event = createDomainEvent('order.confirmed', 'evt-dup', {
      orderId: 'ord-dup',
      items: [{ productId: 'prod-a' }, { productId: 'prod-b' }],
    });

    await listener.handle(event);

    expect(idempotencyMock.handleOnce).toHaveBeenCalledWith(
      'evt-dup',
      'recommendations-service',
      expect.any(Function),
    );
    expect(recommendationsMock.recordCoPurchases).not.toHaveBeenCalled();
  });

  it('processes a new multi-item order and calls recordCoPurchases inside the transaction', async () => {
    idempotencyMock.handleOnce.mockImplementation(async (_eventId, _consumer, fn) => {
      await fn(managerMock);
      return true;
    });

    const items = [{ productId: 'prod-a' }, { productId: 'prod-b' }];
    const event = createDomainEvent('order.confirmed', 'evt-new', {
      orderId: 'ord-new',
      items,
    });

    await listener.handle(event);

    expect(idempotencyMock.handleOnce).toHaveBeenCalledWith(
      'evt-new',
      'recommendations-service',
      expect.any(Function),
    );
    expect(recommendationsMock.recordCoPurchases).toHaveBeenCalledWith(managerMock, items);
  });

  it('ignores events that are not order.confirmed', async () => {
    const event = createDomainEvent('order.cancelled', 'evt-other', {
      orderId: 'ord-other',
      items: [{ productId: 'prod-a' }, { productId: 'prod-b' }],
    });

    await listener.handle(event);

    expect(idempotencyMock.handleOnce).not.toHaveBeenCalled();
    expect(recommendationsMock.recordCoPurchases).not.toHaveBeenCalled();
  });
});
