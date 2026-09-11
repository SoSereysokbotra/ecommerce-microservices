import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OutboxService } from '@libs/outbox';
import Stripe from 'stripe';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { PaymentEntity, PaymentStatus } from './payment.entity';
import { isThreeDecimal, stripeExponentFor } from './stripe-currencies';
import { RefundEntity } from './refund.entity';
import { WebhookEventEntity } from './webhook-event.entity';
import { StripeService } from './stripe.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(PaymentEntity)
    private readonly payments: Repository<PaymentEntity>,
    private readonly dataSource: DataSource,
    private readonly stripe: StripeService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Create the payment intent for an order, driven by `payment.requested`.
   *
   * Safe to call more than once for the same order. Two guards make that true:
   * the local row is looked up first, and the key sent to Stripe is derived
   * from the order id, so even a simultaneous second call gets back the same
   * intent rather than creating another.
   */
  /**
   * Refuse to charge in a currency whose minor unit we cannot vouch for.
   *
   * Stripe is handed `amountMinor` directly, so a charge is correct only if our
   * minor-unit convention matches Stripe's. `stripe-currencies.ts` holds
   * Stripe's own list; pricing's `currencies` table holds ours; this is where
   * the two are compared, and it is the last point before real money moves.
   *
   * Three refusals, each for a failure that would otherwise be silent:
   *
   * - **A disagreement.** If pricing thinks JPY has two decimals and Stripe
   *     knows it has none, the customer is charged 100× what they agreed to.
   *     Nothing downstream would flag that — the amount is a valid integer and
   *     Stripe accepts it.
   * - **A currency Stripe has no convention for.** Passing the amount through
   *     and hoping is the guess this whole milestone exists to remove.
   * - **A three-decimal currency.** Stripe accepts those but requires the
   *     amount rounded to the nearest hundred, and this project does not do
   *     that rounding. Better to refuse than to submit an amount that is
   *     quietly truncated.
   *
   * An order placed before M11 carries no exponent. That is read as the old
   * assumption of two rather than refused, because it *was* two — every order
   * in the table before this milestone was in dollars.
   */
  private assertCurrencyIsChargeable(currency: string, exponent?: number | null): void {
    const stripeExponent = stripeExponentFor(currency);

    if (stripeExponent === null) {
      throw new BadRequestException(
        `Cannot charge in '${currency}': no known minor-unit convention for it`,
      );
    }

    if (isThreeDecimal(currency)) {
      throw new BadRequestException(
        `Cannot charge in '${currency}': Stripe requires three-decimal amounts rounded ` +
          `to the nearest hundred, which this service does not do`,
      );
    }

    const ours = exponent ?? 2;

    if (ours !== stripeExponent) {
      throw new BadRequestException(
        `Refusing to charge ${currency}: priced with exponent ${ours}, ` +
          `Stripe expects ${stripeExponent}. That is a factor of ` +
          `${10 ** Math.abs(ours - stripeExponent)} on a real charge.`,
      );
    }
  }

  async createIntentForOrder(
    manager: EntityManager,
    input: {
      orderId: string;
      amountMinor: number;
      currency: string;
      /** What pricing used. Null for an order placed before M11. */
      exponent?: number | null;
      correlationId?: string;
    },
  ): Promise<PaymentEntity> {
    this.assertCurrencyIsChargeable(input.currency, input.exponent);

    const repo = manager.getRepository(PaymentEntity);
    const existing = await repo.findOne({ where: { orderId: input.orderId } });

    if (existing) {
      this.logger.log(`Payment already exists for order ${input.orderId}; reusing`);
      return existing;
    }

    const idempotencyKey = `order_${input.orderId}`;

    const intent = await this.stripe.createPaymentIntent({
      amountMinor: input.amountMinor,
      currency: input.currency,
      orderId: input.orderId,
      idempotencyKey,
    });

    const payment = await repo.save(
      repo.create({
        orderId: input.orderId,
        idempotencyKey,
        provider: 'stripe',
        providerRef: intent.id,
        clientSecret: intent.client_secret,
        amountMinor: input.amountMinor,
        currency: input.currency.toUpperCase(),
        status: PaymentStatus.REQUIRES_PAYMENT,
      }),
    );

    this.logger.log(
      `Created ${intent.id} for order ${input.orderId} (${input.amountMinor} ${input.currency}) ` +
        `[${input.correlationId}]`,
    );

    return payment;
  }

  findByOrder(orderId: string): Promise<PaymentEntity | null> {
    return this.payments.findOne({ where: { orderId } });
  }

  async findByOrderOrFail(orderId: string): Promise<PaymentEntity> {
    const payment = await this.findByOrder(orderId);
    if (!payment) {
      throw new NotFoundException(`No payment for order '${orderId}'`);
    }
    return payment;
  }

  /**
   * Apply a verified Stripe webhook.
   *
   * Returns false when this event has already been applied. Deduplication is
   * the insert into `webhook_events`: the provider's own event id is the
   * primary key, so a repeat aborts the transaction with a unique violation
   * before any effect runs. Checking-then-inserting would leave a race between
   * two concurrent deliveries.
   */
  async applyWebhook(event: Stripe.Event): Promise<boolean> {
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.insert(WebhookEventEntity, {
          providerEventId: event.id,
          type: event.type,
          // Stored verbatim so a webhook can be re-examined later without
          // asking Stripe for it again.
          payload: JSON.parse(JSON.stringify(event)) as Record<string, never>,
          receivedAt: new Date(),
        });

        await this.applyEffect(manager, event);
      });

      return true;
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.log(`Webhook ${event.id} already processed; ignoring duplicate`);
        return false;
      }
      throw error;
    }
  }

  private async applyEffect(manager: EntityManager, event: Stripe.Event): Promise<void> {
    const intent = event.data.object as Stripe.PaymentIntent;
    const orderId = intent.metadata?.orderId;

    if (!orderId) {
      this.logger.warn(`${event.type} (${event.id}) carries no orderId metadata; recorded only`);
      return;
    }

    const repo = manager.getRepository(PaymentEntity);
    const payment = await repo.findOne({ where: { orderId } });

    if (!payment) {
      this.logger.warn(`${event.type} for unknown order ${orderId}; recorded only`);
      return;
    }

    switch (event.type) {
      case 'payment_intent.succeeded': {
        payment.status = PaymentStatus.AUTHORIZED;
        payment.providerRef = intent.id;
        await repo.save(payment);

        await this.outbox.append(manager, {
          eventType: 'payment.authorized',
          aggregateId: orderId,
          payload: {
            orderId,
            paymentId: payment.id,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            providerRef: intent.id,
          },
        });

        this.logger.log(`Payment authorized for order ${orderId}`);
        break;
      }

      case 'payment_intent.payment_failed': {
        payment.status = PaymentStatus.DECLINED;
        payment.failureReason = intent.last_payment_error?.message ?? 'Payment failed';
        await repo.save(payment);

        await this.outbox.append(manager, {
          eventType: 'payment.declined',
          aggregateId: orderId,
          payload: { orderId, paymentId: payment.id, reason: payment.failureReason },
        });

        this.logger.log(`Payment declined for order ${orderId}: ${payment.failureReason}`);
        break;
      }

      default:
        // Recorded in webhook_events but with no effect. Stripe sends many
        // event types; silently ignoring the ones we do not model is correct,
        // and the row remains for debugging.
        this.logger.debug(`No handler for ${event.type}; recorded only`);
    }
  }

  /**
   * Refund a payment. Used by M5's compensation when fulfilment fails after the
   * money has already been taken.
   */
  async refund(orderId: string, reason?: string): Promise<RefundEntity> {
    const payment = await this.findByOrderOrFail(orderId);

    if (payment.status !== PaymentStatus.AUTHORIZED) {
      throw new NotFoundException(
        `Payment for order '${orderId}' is ${payment.status}, not authorized`,
      );
    }

    const idempotencyKey = `refund_${payment.id}`;

    return this.dataSource.transaction(async (manager) => {
      const refunds = manager.getRepository(RefundEntity);
      const existing = await refunds.findOne({ where: { idempotencyKey } });

      if (existing) {
        this.logger.log(`Refund already issued for order ${orderId}; reusing`);
        return existing;
      }

      const stripeRefund = await this.stripe.refund({
        paymentIntentId: payment.providerRef as string,
        amountMinor: payment.amountMinor,
        idempotencyKey,
        reason,
      });

      const refund = await refunds.save(
        refunds.create({
          paymentId: payment.id,
          idempotencyKey,
          amountMinor: payment.amountMinor,
          reason: reason ?? null,
          providerRef: stripeRefund.id,
          status: stripeRefund.status ?? 'pending',
        }),
      );

      payment.status = PaymentStatus.REFUNDED;
      await manager.getRepository(PaymentEntity).save(payment);

      await this.outbox.append(manager, {
        eventType: 'payment.refunded',
        aggregateId: orderId,
        payload: { orderId, paymentId: payment.id, amountMinor: payment.amountMinor },
      });

      this.logger.log(`Refunded ${payment.amountMinor} for order ${orderId}`);
      return refund;
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}
