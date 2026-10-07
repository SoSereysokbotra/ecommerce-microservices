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

  it('ignores events that are neither order.confirmed nor order.co_purchase_replay', async () => {
    const event = createDomainEvent('order.cancelled', 'evt-other', {
      orderId: 'ord-other',
      items: [{ productId: 'prod-a' }, { productId: 'prod-b' }],
    });

    await listener.handle(event);

    expect(idempotencyMock.handleOnce).not.toHaveBeenCalled();
    expect(recommendationsMock.recordCoPurchases).not.toHaveBeenCalled();
  });

  describe('order.co_purchase_replay handling', () => {
    it('processes order.co_purchase_replay through the same handleOnce and recordCoPurchases path', async () => {
      idempotencyMock.handleOnce.mockImplementation(async (_eventId, _consumer, fn) => {
        await fn(managerMock);
        return true;
      });

      const items = [{ productId: 'prod-x' }, { productId: 'prod-y' }];
      const event = createDomainEvent('order.co_purchase_replay', 'evt-replay-1', {
        orderId: 'ord-replay-1',
        items,
      });

      await listener.handle(event);

      expect(idempotencyMock.handleOnce).toHaveBeenCalledWith(
        'evt-replay-1',
        'recommendations-service',
        expect.any(Function),
      );
      expect(recommendationsMock.recordCoPurchases).toHaveBeenCalledWith(managerMock, items);
    });

    it('skips order.co_purchase_replay with fewer than 2 distinct products', async () => {
      const event = createDomainEvent('order.co_purchase_replay', 'evt-replay-single', {
        orderId: 'ord-replay-single',
        items: [{ productId: 'prod-solo' }],
      });

      await listener.handle(event);

      expect(idempotencyMock.handleOnce).not.toHaveBeenCalled();
      expect(recommendationsMock.recordCoPurchases).not.toHaveBeenCalled();
    });

    it('skips order.co_purchase_replay with no items', async () => {
      const event = createDomainEvent('order.co_purchase_replay', 'evt-replay-empty', {
        orderId: 'ord-replay-empty',
        items: [],
      });

      await listener.handle(event);

      expect(idempotencyMock.handleOnce).not.toHaveBeenCalled();
      expect(recommendationsMock.recordCoPurchases).not.toHaveBeenCalled();
    });

    it('ignores duplicate order.co_purchase_replay via idempotency marker', async () => {
      idempotencyMock.handleOnce.mockResolvedValue(false);

      const event = createDomainEvent('order.co_purchase_replay', 'evt-replay-dup', {
        orderId: 'ord-replay-dup',
        items: [{ productId: 'prod-1' }, { productId: 'prod-2' }],
      });

      await listener.handle(event);

      expect(idempotencyMock.handleOnce).toHaveBeenCalledWith(
        'evt-replay-dup',
        'recommendations-service',
        expect.any(Function),
      );
      expect(recommendationsMock.recordCoPurchases).not.toHaveBeenCalled();
    });
  });
});
