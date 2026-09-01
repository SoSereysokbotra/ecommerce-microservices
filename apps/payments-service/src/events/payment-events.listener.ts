import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { IdempotencyService } from '@libs/outbox';
import { PaymentsService } from '../modules/payments/payments.service';

const CONSUMER = 'payments-service';

interface PaymentRequestedPayload {
  orderId: string;
  amountMinor: number;
  currency: string;
}

interface RefundRequestedPayload {
  orderId: string;
  reason?: string;
}

@Injectable()
export class PaymentEventsListener implements OnModuleInit {
  private readonly logger = new Logger(PaymentEventsListener.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly idempotency: IdempotencyService,
    private readonly payments: PaymentsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = process.env.RABBITMQ_QUEUE ?? 'payments-service';
    await this.rabbitmq.subscribe(queue, async (message) => {
      await this.handle(message as DomainEvent<PaymentRequestedPayload>);
    });
    this.logger.log(`Listening on ${queue}`);
  }

  private async handle(event: DomainEvent<PaymentRequestedPayload>): Promise<void> {
    if (event.eventType === 'payment.refund_requested') {
      await this.onRefundRequested(event as unknown as DomainEvent<RefundRequestedPayload>);
      return;
    }

    if (event.eventType !== 'payment.requested') {
      return;
    }

    const { orderId, amountMinor, currency } = event.payload ?? ({} as PaymentRequestedPayload);
    if (!orderId || !amountMinor || !currency) {
      this.logger.warn(`payment.requested (${event.eventId}) is malformed; dropping`);
      return;
    }

    // Two layers of protection against double-charging, and both are needed.
    // This one stops the work re-running locally; the idempotency key sent to
    // Stripe stops a charge even if a *different* event id asks for the same
    // order — a republish with a fresh id, say.
    const ran = await this.idempotency.handleOnce(event.eventId, CONSUMER, async (manager) => {
      await this.payments.createIntentForOrder(manager, {
        orderId,
        amountMinor,
        currency,
        correlationId: event.correlationId,
      });
    });

    if (!ran) {
      this.logger.debug(`Duplicate payment.requested (${event.eventId}) ignored`);
    }
  }

  /**
   * Compensation for a failure that happened after the money was taken.
   *
   * The refund itself is idempotent — the Stripe idempotency key is derived
   * from the payment id — so a redelivered command returns the original refund
   * instead of issuing a second one.
   */
  private async onRefundRequested(event: DomainEvent<RefundRequestedPayload>): Promise<void> {
    const { orderId, reason } = event.payload ?? ({} as RefundRequestedPayload);
    if (!orderId) {
      this.logger.warn(`payment.refund_requested (${event.eventId}) has no orderId; dropping`);
      return;
    }

    const ran = await this.idempotency.handleOnce(event.eventId, CONSUMER, async () => {
      await this.payments.refund(orderId, reason);
    });

    if (!ran) {
      this.logger.debug(`Duplicate payment.refund_requested (${event.eventId}) ignored`);
    }
  }
}
