import { OrderSagaService } from '../src/modules/orders/order-saga.service';
import { OrderSagaEntity, SagaOutcome, SagaStep } from '../src/modules/orders/order-saga.entity';
import { OrderEntity, OrderStatus } from '../src/modules/orders/order.entity';

/**
 * The saga's guard rails, tested without a database.
 *
 * The behaviour that matters here is what the saga *refuses* to do: transition
 * from a step it is not on. That guard is what makes every handler safe to
 * call twice, which an at-least-once event bus guarantees will happen.
 */
describe('OrderSagaService', () => {
  function setup(step: SagaStep, status = OrderStatus.PENDING) {
    const saga = Object.assign(new OrderSagaEntity(), {
      orderId: 'order-1',
      currentStep: step,
      outcome: SagaOutcome.RUNNING,
      compensating: false,
      attempts: 0,
    });

    const order = Object.assign(new OrderEntity(), {
      id: 'order-1',
      customerId: 'cust-1',
      status,
      currency: 'USD',
      totalMinor: 5000,
    });

    const saved: unknown[] = [];
    const manager = {
      findOne: async (entity: unknown) => (entity === OrderSagaEntity ? saga : order),
      save: async (_e: unknown, row: unknown) => {
        saved.push(row);
        return row;
      },
      create: (_e: unknown, row: unknown) => row,
    };

    const dataSource = {
      transaction: async (work: (m: unknown) => Promise<unknown>) => work(manager),
      getRepository: () => ({ find: async () => [saga], findOne: async () => saga }),
    };

    const outbox = { append: jest.fn(async () => undefined) };
    const service = new OrderSagaService(dataSource as never, outbox as never);

    return { service, saga, order, outbox };
  }

  describe('forward path', () => {
    it('reserved -> awaiting_payment and asks for payment', async () => {
      const { service, saga, order, outbox } = setup(SagaStep.AWAITING_RESERVATION);

      await service.onStockReserved('order-1', 'corr-1');

      expect(saga.currentStep).toBe(SagaStep.AWAITING_PAYMENT);
      expect(order.status).toBe(OrderStatus.AWAITING_PAYMENT);
      expect(outbox.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'payment.requested' }),
      );
    });

    it('authorized -> asks inventory to commit', async () => {
      const { service, saga, outbox } = setup(SagaStep.AWAITING_PAYMENT);

      await service.onPaymentAuthorized('order-1');

      expect(saga.currentStep).toBe(SagaStep.AWAITING_COMMIT);
      expect(outbox.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'inventory.commit_requested' }),
      );
    });

    it('committed -> CONFIRMED and the saga completes', async () => {
      const { service, saga, order } = setup(SagaStep.AWAITING_COMMIT);

      await service.onInventoryCommitted('order-1');

      expect(order.status).toBe(OrderStatus.CONFIRMED);
      expect(saga.outcome).toBe(SagaOutcome.COMPLETED);
    });
  });

  describe('compensation', () => {
    it('declined -> asks inventory to release, and marks the saga compensating', async () => {
      // The transition M2 could not make. Without it, declined payments leak
      // stock forever — see docs/adr/0002-why-a-saga.md.
      const { service, saga, outbox } = setup(SagaStep.AWAITING_PAYMENT);

      await service.onPaymentDeclined('order-1', 'Your card was declined.');

      expect(saga.currentStep).toBe(SagaStep.AWAITING_RELEASE);
      expect(saga.compensating).toBe(true);
      expect(outbox.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'inventory.release_requested' }),
      );
    });

    it('released -> CANCELLED, carrying the original failure reason', async () => {
      const { service, saga, order } = setup(SagaStep.AWAITING_RELEASE);
      saga.lastError = 'Your card was declined.';

      await service.onInventoryReleased('order-1');

      expect(order.status).toBe(OrderStatus.CANCELLED);
      expect(order.failureReason).toBe('Your card was declined.');
      expect(saga.outcome).toBe(SagaOutcome.COMPENSATED);
    });

    it('refunded -> releases the stock next', async () => {
      const { service, saga, outbox } = setup(SagaStep.AWAITING_REFUND);

      await service.onPaymentRefunded('order-1');

      expect(saga.currentStep).toBe(SagaStep.AWAITING_RELEASE);
      expect(outbox.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'inventory.release_requested' }),
      );
    });

    it('a reservation failure cancels without compensating — nothing was committed', async () => {
      const { service, saga, order, outbox } = setup(SagaStep.AWAITING_RESERVATION);

      await service.onReservationFailed('order-1', 'Insufficient stock');

      expect(order.status).toBe(OrderStatus.CANCELLED);
      expect(saga.outcome).toBe(SagaOutcome.COMPENSATED);
      // No release: the stock was never held in the first place.
      expect(outbox.append).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('ignores a reply for a step the saga has already left', async () => {
      // A redelivered inventory.reserved arriving after payment was requested
      // must not request payment a second time.
      const { service, saga, outbox } = setup(SagaStep.AWAITING_PAYMENT);

      await service.onStockReserved('order-1');

      expect(saga.currentStep).toBe(SagaStep.AWAITING_PAYMENT);
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('ignores a commit reply once the saga is done', async () => {
      const { service, order } = setup(SagaStep.DONE, OrderStatus.CONFIRMED);

      await service.onInventoryCommitted('order-1');

      expect(order.status).toBe(OrderStatus.CONFIRMED);
    });

    it('does not re-request payment when resuming', async () => {
      // AWAITING_PAYMENT waits on a customer and a Stripe webhook. Re-sending
      // payment.requested would create a second PaymentIntent.
      const { service, outbox } = setup(SagaStep.AWAITING_PAYMENT);

      const resumed = await service.resumeAll();

      expect(resumed).toBe(0);
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('re-sends the pending command when resuming a stuck commit', async () => {
      const { service, saga, outbox } = setup(SagaStep.AWAITING_COMMIT);

      const resumed = await service.resumeAll();

      expect(resumed).toBe(1);
      expect(saga.attempts).toBe(1);
      expect(outbox.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'inventory.commit_requested' }),
      );
    });
  });
});
