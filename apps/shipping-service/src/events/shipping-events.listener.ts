import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, RabbitMQService } from '@libs/rabbitmq';
import { IdempotencyService } from '@libs/outbox';
import { EntityManager } from 'typeorm';
import { ShipmentsService } from '../modules/shipping/shipments.service';
import { ShipmentAddress } from '../modules/shipping/shipment.entity';

const CONSUMER = 'shipping-service';

interface OrderConfirmedPayload {
  orderId: string;
  customerId: string;
  currency?: string;
  totalMinor?: number;
  shippingMinor?: number;
  shippingRateCode?: string | null;
  shippingAddress?: ShipmentAddress | null;
}

/**
 * Turns a confirmed order into a parcel to send.
 *
 * ## Why `order.confirmed` and not `order.paid`
 *
 * `IMPLEMENTATION_PLAN.md` §3 says this service consumes `order.paid`. There is
 * no such event and never has been. `order.confirmed` is the same fact — the
 * saga reaching its terminal success state, emitted in the same transaction as
 * the status change — and it has existed since M9, which added it as a leaf
 * event for exactly this kind of consumer. M10 is what makes that sentence pay
 * off: a second service reacts to how an order ended, and the saga neither
 * knows nor cares that it did.
 *
 * ## Two guards, deliberately independent
 *
 * The bus delivers **at least once**, so `order.confirmed` will arrive twice
 * for some order. Two parcels is a real cost, not a tidy-up.
 *
 *   1. `handleOnce` writes a `processed_events` marker in the **same
 *      transaction** as the shipment, so a redelivered event id is a no-op.
 *   2. `shipments.order_id` is UNIQUE, so a genuine **republish** with a *new*
 *      event id — which the marker cannot catch — is refused by the database.
 *
 * M9 proved guard 1 alone is insufficient by testing precisely case 2, and this
 * is the same belt-and-braces the saga uses: the marker handles redelivery, the
 * uniqueness handles republication.
 *
 * ## What it does NOT consume
 *
 * `order.cancelled`. A cancelled order never reached `CONFIRMED`, so it has no
 * shipment to withdraw. Subscribing to it in order to do nothing would suggest
 * there was a compensation here, and there is not — see `ShipmentsService`.
 */
@Injectable()
export class ShippingEventsListener implements OnModuleInit {
  private readonly logger = new Logger(ShippingEventsListener.name);

  constructor(
    private readonly rabbitmq: RabbitMQService,
    private readonly idempotency: IdempotencyService,
    private readonly shipments: ShipmentsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = process.env.RABBITMQ_QUEUE ?? 'shipping-service';
    await this.rabbitmq.subscribe(queue, async (message) => {
      await this.handle(message as DomainEvent<OrderConfirmedPayload>);
    });
    this.logger.log(`Listening on ${queue}`);
  }

  private async handle(event: DomainEvent<OrderConfirmedPayload>): Promise<void> {
    if (event.eventType !== 'order.confirmed') {
      return;
    }

    const payload = event.payload;
    if (!payload?.orderId || !payload?.customerId) {
      // Nothing to key a shipment on. Dropping rather than nacking, because a
      // redelivery would be just as unusable and would loop forever.
      this.logger.warn(`order.confirmed (${event.eventId}) is missing ids; dropping`);
      return;
    }

    const ran = await this.idempotency.handleOnce(event.eventId, CONSUMER, async (manager) =>
      this.createShipment(manager, payload),
    );

    if (!ran) {
      this.logger.debug(`Duplicate order.confirmed (${event.eventId}) ignored`);
    }
  }

  private async createShipment(
    manager: EntityManager,
    payload: OrderConfirmedPayload,
  ): Promise<void> {
    const shipment = await this.shipments.createForOrder(manager, {
      orderId: payload.orderId,
      customerId: payload.customerId,
      rateCode: payload.shippingRateCode ?? null,
      costMinor: payload.shippingMinor ?? 0,
      // The order does not carry the basket's weight — it was pricing's input,
      // not something frozen onto the order — so a shipment records 0 rather
      // than a number nobody measured. Worth revisiting if a carrier
      // integration ever needs it; a guess would be worse than a zero.
      weightG: 0,
      address: payload.shippingAddress ?? null,
    });

    if (!shipment) {
      // The order_id index refused it: a republished event with a new id. Not
      // an error — it is the guard doing its job.
      this.logger.log(`Order ${payload.orderId} already has a shipment; nothing created`);
      return;
    }

    if (!shipment.address) {
      // Every order placed before M10, and any placed with only a destination.
      // Loud enough to notice, not loud enough to fail: the parcel exists and
      // someone can fill the address in.
      this.logger.warn(`Shipment ${shipment.id} created with no delivery address`);
    }

    this.logger.log(
      `Shipment ${shipment.id} created for order ${payload.orderId} ` +
        `(${shipment.rateCode ?? 'no rate'}, ${shipment.costMinor})`,
    );
  }
}
