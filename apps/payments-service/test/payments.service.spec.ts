import { PaymentsService } from '../src/modules/payments/payments.service';
import { PaymentEntity, PaymentStatus } from '../src/modules/payments/payment.entity';

/**
 * The two guarantees this service exists to provide:
 *
 *   1. a repeated webhook changes nothing
 *   2. a repeated payment request produces one charge, not two
 *
 * Both are enforced by database constraints rather than by application logic,
 * so these tests drive the constraint's behaviour through a fake.
 */
describe('PaymentsService', () => {
  const UNIQUE_VIOLATION = { code: '23505' };

  function makeService(overrides: {
    transaction?: (work: (m: unknown) => Promise<unknown>) => Promise<unknown>;
    payment?: PaymentEntity | null;
    createIntent?: jest.Mock;
  }) {
    const payment =
      overrides.payment ??
      (Object.assign(new PaymentEntity(), {
        id: 'pay-1',
        orderId: 'order-1',
        amountMinor: 5000,
        currency: 'USD',
        status: PaymentStatus.REQUIRES_PAYMENT,
      }) as PaymentEntity);

    const repo = {
      findOne: jest.fn(async () => payment),
      save: jest.fn(async (p: PaymentEntity) => p),
      create: jest.fn((p: Partial<PaymentEntity>) => Object.assign(new PaymentEntity(), p)),
    };

    const manager = {
      insert: jest.fn(async () => undefined),
      getRepository: () => repo,
    };

    const dataSource = {
      transaction:
        overrides.transaction ?? (async (work: (m: unknown) => Promise<unknown>) => work(manager)),
    };

    const stripe = {
      createPaymentIntent:
        overrides.createIntent ??
        jest.fn(async () => ({ id: 'pi_1', client_secret: 'pi_1_secret' })),
      refund: jest.fn(),
      constructEvent: jest.fn(),
    };

    const outbox = { append: jest.fn(async () => undefined) };

    const service = new PaymentsService(
      repo as never,
      dataSource as never,
      stripe as never,
      outbox as never,
    );

    return { service, repo, manager, stripe, outbox, payment };
  }

  describe('applyWebhook', () => {
    it('reports a duplicate rather than throwing when the event id repeats', async () => {
      // The unique violation on webhook_events.provider_event_id IS the
      // deduplication. A check-then-insert would race between two concurrent
      // deliveries of the same event.
      const { service } = makeService({
        transaction: async () => {
          throw UNIQUE_VIOLATION;
        },
      });

      const applied = await service.applyWebhook({
        id: 'evt_1',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_1', metadata: { orderId: 'order-1' } } },
      } as never);

      expect(applied).toBe(false);
    });

    it('rethrows errors that are not duplicate-key violations', async () => {
      // A connection failure must not be mistaken for "already handled", or the
      // webhook would be silently dropped and Stripe told everything was fine.
      const { service } = makeService({
        transaction: async () => {
          throw new Error('connection terminated');
        },
      });

      await expect(
        service.applyWebhook({
          id: 'evt_2',
          type: 'payment_intent.succeeded',
          data: { object: { id: 'pi_1', metadata: { orderId: 'order-1' } } },
        } as never),
      ).rejects.toThrow('connection terminated');
    });

    it('emits payment.authorized and marks the payment authorized on success', async () => {
      const { service, outbox, payment } = makeService({});

      const applied = await service.applyWebhook({
        id: 'evt_3',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_1', metadata: { orderId: 'order-1' } } },
      } as never);

      expect(applied).toBe(true);
      expect(payment.status).toBe(PaymentStatus.AUTHORIZED);
      expect(outbox.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'payment.authorized' }),
      );
    });

    it('emits payment.declined with the provider reason on failure', async () => {
      const { service, outbox, payment } = makeService({});

      await service.applyWebhook({
        id: 'evt_4',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_1',
            metadata: { orderId: 'order-1' },
            last_payment_error: { message: 'Your card was declined.' },
          },
        },
      } as never);

      expect(payment.status).toBe(PaymentStatus.DECLINED);
      expect(payment.failureReason).toBe('Your card was declined.');
      expect(outbox.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'payment.declined' }),
      );
    });

    it('records an unmodelled event type without side effects', async () => {
      const { service, outbox } = makeService({});

      const applied = await service.applyWebhook({
        id: 'evt_5',
        type: 'charge.updated',
        data: { object: { id: 'pi_1', metadata: { orderId: 'order-1' } } },
      } as never);

      expect(applied).toBe(true);
      expect(outbox.append).not.toHaveBeenCalled();
    });
  });

  describe('createIntentForOrder', () => {
    it('does not call Stripe again when a payment already exists for the order', async () => {
      const createIntent = jest.fn();
      const { service, manager } = makeService({ createIntent });

      const result = await service.createIntentForOrder(manager as never, {
        orderId: 'order-1',
        amountMinor: 5000,
        currency: 'USD',
      });

      expect(createIntent).not.toHaveBeenCalled();
      expect(result.orderId).toBe('order-1');
    });

    it('derives the Stripe idempotency key from the order id', async () => {
      // Deriving it from the order rather than the event means even a
      // republished event with a fresh event id cannot create a second charge.
      const createIntent = jest.fn(async () => ({ id: 'pi_9', client_secret: 's' }));
      const { service, manager, repo } = makeService({ createIntent });
      repo.findOne.mockResolvedValueOnce(null as never);

      await service.createIntentForOrder(manager as never, {
        orderId: 'order-42',
        amountMinor: 1200,
        currency: 'usd',
      });

      expect(createIntent).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'order_order-42' }),
      );
    });
  });
});
