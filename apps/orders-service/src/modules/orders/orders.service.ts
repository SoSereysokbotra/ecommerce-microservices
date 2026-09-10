import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { OutboxService } from '@libs/outbox';
import { DataSource, Repository } from 'typeorm';
import { OrderEntity, OrderStatus, type FrozenAddress } from './order.entity';
import { OrderItemEntity } from './order-item.entity';
import { CreateOrderDto } from './dto/order.dto';
import { OrderSagaService } from './order-saga.service';
import { PricingClient } from './pricing.client';
import { UsersClient, type CustomerAddress } from './users.client';

/**
 * Order creation and reads.
 *
 * All saga transitions live in OrderSagaService; this class only creates the
 * order and starts the saga. Keeping them apart means the state machine can be
 * read in one file without the pricing and HTTP details around it.
 *
 * **M8 moved the pricing out entirely.** This used to loop over the basket
 * asking catalog for each product's price and summing them, which meant the
 * storefront's cart page and this method were two separate implementations of
 * "what does this basket cost" — and a customer finds out they disagreed by
 * seeing one number and being charged another. Now there is one: a single call
 * to pricing-service, which reads catalog itself and returns the priced lines,
 * the discounts, the tax and the total.
 *
 * That call stays synchronous for the same reason the catalog lookup did: it is
 * a *read* before anything is committed, so a failure rejects the request with
 * nothing left half-done. The calls that had to become events were the ones
 * changing another service's state.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orders: Repository<OrderEntity>,
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
    private readonly saga: OrderSagaService,
    private readonly pricing: PricingClient,
    private readonly users: UsersClient,
  ) {}

  async create(
    customerId: string,
    input: CreateOrderDto,
    correlationId?: string,
  ): Promise<OrderEntity> {
    if (input.items.length === 0) {
      throw new BadRequestException('An order must contain at least one item');
    }

    /**
     * Where it is going.
     *
     * A saved address **wins over** the `destination` on the request. Since M8
     * the client has asserted the tax jurisdiction because nothing knew a
     * customer's address; when one is named here, the country and region come
     * from a row this customer owns, read server-side. See `UsersClient`.
     *
     * The lookup happens before the quote because the quote depends on it, and
     * before anything is written because a failure must leave nothing behind.
     */
    const address = input.shippingAddressId
      ? await this.users.address(customerId, input.shippingAddressId, correlationId)
      : null;

    const destination = address
      ? { country: address.country, region: address.region ?? undefined }
      : input.destination;

    // The whole quote — prices, promotions, tax, delivery, total — in one call.
    const quote = await this.pricing.quote(
      {
        items: input.items.map(({ productId, qty }) => ({ productId, qty })),
        destination,
        couponCode: input.couponCode,
        customerId,
        shippingRateCode: input.shippingRateCode,
      },
      correlationId,
    );

    /**
     * Claim the coupon before writing anything.
     *
     * The id is generated here rather than by the database so the hold and the
     * order can agree on it: pricing needs an order id to claim against, and the
     * order does not exist yet. It also makes the hold idempotent — a retry
     * presents the same id and is refused rather than taking a second use.
     *
     * Quoting deliberately did **not** claim anything, so between the quote
     * above and this line the last use may have gone to someone else. That is
     * why `hold` re-checks atomically instead of trusting the quote, and why a
     * refusal here is a normal outcome rather than an error.
     */
    const orderId = randomUUID();
    let couponApplied = false;

    if (input.couponCode && quote.coupon?.applied) {
      const held = await this.pricing.holdCoupon(
        {
          code: input.couponCode,
          orderId,
          customerId,
          amountMinor: quote.coupon.amountMinor,
        },
        correlationId,
      );

      if (!held.ok) {
        // Somebody took the last use while this shopper was checking out. Tell
        // them plainly rather than silently charging the undiscounted total.
        throw new ConflictException(
          `Coupon '${input.couponCode.toUpperCase()}' could not be applied: ${held.reason}`,
        );
      }
      couponApplied = true;
    }

    // The order row and its event commit together or not at all. That is the
    // point of the outbox: no window where an order exists with no event, or
    // an event exists for an order that rolled back.
    try {
      await this.dataSource.transaction(async (manager) => {
        const order = await manager.save(
          manager.create(OrderEntity, {
            id: orderId,
            customerId,
            status: OrderStatus.PENDING,
            currency: quote.currency,
            // The quote is frozen onto the order here. Nothing ever re-reads
            // tax_rates to display it, so a rate change tomorrow cannot
            // re-price an order placed today.
            subtotalMinor: quote.subtotalMinor,
            discountMinor: quote.discountMinor,
            taxMinor: quote.taxMinor,
            // Frozen alongside tax, and for the same reason: an order is a
            // record of an amount the customer agreed to. A rate change
            // tomorrow must not re-price an order placed today.
            shippingMinor: quote.shippingMinor ?? 0,
            shippingRateCode: quote.shipping?.selectedCode ?? null,
            shippingAddress: freeze(address),
            totalMinor: quote.totalMinor,
            taxCountry: quote.destination.country,
            taxRegion: quote.destination.region,
            items: quote.lines.map((line) =>
              Object.assign(new OrderItemEntity(), {
                productId: line.productId,
                sku: line.sku,
                name: line.name,
                qty: line.qty,
                unitPriceMinor: line.unitPriceMinor,
                lineDiscountMinor: line.lineDiscountMinor,
                taxRateBp: line.taxRateBp,
                taxMinor: line.taxMinor,
              }),
            ),
          }),
        );

        // Order, saga state and first event all commit together.
        await this.saga.start(manager, order.id, correlationId);

        // Deliberately unchanged by M8. This event's consumer is inventory,
        // which cares about product ids and quantities; adding money to it
        // would be payload for an imagined future.
        await this.outbox.append(manager, {
          eventType: 'order.created',
          aggregateId: order.id,
          correlationId,
          payload: {
            orderId: order.id,
            customerId,
            currency: quote.currency,
            totalMinor: quote.totalMinor,
            items: quote.lines.map(({ productId, qty }) => ({ productId, qty })),
          },
        });
      });
    } catch (error) {
      /**
       * The order did not get written, but the coupon use was already claimed.
       *
       * Nothing else will give it back: the release path is driven by
       * `order.cancelled`, and there is no order to cancel. Without this, a
       * failed insert would quietly burn a use from a limited coupon — the
       * exact leak this milestone is about, arriving from the one direction the
       * concurrency work does not cover.
       */
      if (couponApplied) {
        await this.pricing
          .releaseCoupon(orderId, correlationId)
          .catch((releaseError) =>
            this.logger.error(
              `Order ${orderId} failed AND its coupon hold could not be released: ` +
                `${releaseError instanceof Error ? releaseError.message : releaseError}`,
            ),
          );
      }
      throw error;
    }

    this.logger.log(
      `Order ${orderId} created: subtotal ${quote.subtotalMinor}, ` +
        `discount ${quote.discountMinor}, shipping ${quote.shippingMinor ?? 0}` +
        `${quote.shipping?.selectedCode ? ` (${quote.shipping.selectedCode})` : ''}, ` +
        `tax ${quote.taxMinor}, total ${quote.totalMinor} ` +
        `(${quote.destination.country}${quote.destination.region ? `-${quote.destination.region}` : ''}), ` +
        `awaiting reservation [${correlationId}]`,
    );

    // Returns PENDING. The caller polls GET /orders/:id — checkout is no
    // longer resolved inside the request.
    return this.orders.findOneOrFail({ where: { id: orderId } });
  }

  findOne(id: string, customerId: string): Promise<OrderEntity | null> {
    return this.orders.findOne({ where: { id, customerId } });
  }

  list(customerId: string): Promise<OrderEntity[]> {
    return this.orders.find({ where: { customerId }, order: { createdAt: 'DESC' }, take: 50 });
  }
}

/**
 * Copy only the parts of an address that describe a delivery.
 *
 * Not a spread of the whole object: `id`, `isDefault` and the timestamps belong
 * to the live row in users-service, and carrying them onto the order would
 * invite someone to follow the id back to a record that has since been edited
 * or deleted. A snapshot that still points at its source is not a snapshot.
 */
function freeze(address: CustomerAddress | null): FrozenAddress | null {
  if (!address) return null;

  return {
    recipient: address.recipient,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postcode: address.postcode,
    country: address.country,
    phone: address.phone,
  };
}
