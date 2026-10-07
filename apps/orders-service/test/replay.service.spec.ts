import { ReplayService } from '../src/modules/orders/replay.service';
import { ReplayController } from '../src/modules/orders/replay.controller';
import { OrderEntity, OrderStatus } from '../src/modules/orders/order.entity';
import { OrderItemEntity } from '../src/modules/orders/order-item.entity';

describe('ReplayService & ReplayController', () => {
  it('walks confirmed orders and appends order.co_purchase_replay to outbox', async () => {
    const item1 = Object.assign(new OrderItemEntity(), {
      productId: 'prod-1',
      qty: 2,
      sku: 'SKU-1',
    });
    const item2 = Object.assign(new OrderItemEntity(), {
      productId: 'prod-2',
      qty: 1,
      sku: 'SKU-2',
    });
    const confirmedOrder = Object.assign(new OrderEntity(), {
      id: 'ord-101',
      status: OrderStatus.CONFIRMED,
      items: [item1, item2],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const outboxAppended: Array<{ eventType: string; aggregateId: string; payload: unknown }> = [];
    const outbox = {
      append: jest.fn(
        async (
          _manager: unknown,
          input: { eventType: string; aggregateId: string; payload: unknown },
        ) => {
          outboxAppended.push(input);
        },
      ),
    };

    const manager = {
      find: jest.fn(async (_entity: unknown, options?: { where?: { status?: OrderStatus } }) => {
        if (options?.where?.status === OrderStatus.CONFIRMED) {
          return [confirmedOrder];
        }
        return [];
      }),
    };

    const dataSource = {
      transaction: async (work: (m: unknown) => Promise<unknown>) => work(manager),
    };

    const service = new ReplayService(dataSource as never, outbox as never);
    const count = await service.replayCoPurchases('corr-test');

    expect(count).toBe(1);
    expect(manager.find).toHaveBeenCalledWith(
      OrderEntity,
      expect.objectContaining({
        where: { status: OrderStatus.CONFIRMED },
        relations: ['items'],
      }),
    );
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(outboxAppended[0]).toEqual({
      eventType: 'order.co_purchase_replay',
      aggregateId: 'ord-101',
      correlationId: 'corr-test',
      payload: {
        orderId: 'ord-101',
        items: [{ productId: 'prod-1' }, { productId: 'prod-2' }],
      },
    });
  });

  it('controller wraps result with orders count and guidance on truncation trap', async () => {
    const mockReplayService = {
      replayCoPurchases: jest.fn(async () => 5),
    };
    const controller = new ReplayController(mockReplayService as never);

    const response = await controller.replayCoPurchases('corr-1');
    expect(response).toEqual({
      orders: 5,
      next: 'Truncate product_recommendations before replaying, or counts double.',
    });
    expect(mockReplayService.replayCoPurchases).toHaveBeenCalledWith('corr-1');
  });
});
