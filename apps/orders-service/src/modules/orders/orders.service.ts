import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OutboxService } from '@libs/outbox';
import { DataSource, Repository } from 'typeorm';
import { OrderEntity, OrderStatus } from './order.entity';
import { OrderItemEntity } from './order-item.entity';
import { CreateOrderDto } from './dto/order.dto';
import { OrderSagaService } from './order-saga.service';
import { PricingClient } from './pricing.client';

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
  ) {}

  async create(
    customerId: string,
    input: CreateOrderDto,
    correlationId?: string,
  ): Promise<OrderEntity> {
    if (input.items.length === 0) {
      throw new BadRequestException('An order must contain at least one item');
    }

    // The whole quote — prices, promotions, tax, total — in one call.
    const quote = await this.pricing.quote(
      {
        items: input.items.map(({ productId, qty }) => ({ productId, qty })),
        destination: input.destination,
      },
      correlationId,
    );

    // The order row and its event commit together or not at all. That is the
    // point of the outbox: no window where an order exists with no event, or
    // an event exists for an order that rolled back.
    const orderId = await this.dataSource.transaction(async (manager) => {
      const order = await manager.save(
        manager.create(OrderEntity, {
          customerId,
          status: OrderStatus.PENDING,
          currency: quote.currency,
          // The quote is frozen onto the order here. Nothing ever re-reads
          // tax_rates to display it, so a rate change tomorrow cannot re-price
          // an order placed today.
          subtotalMinor: quote.subtotalMinor,
          discountMinor: quote.discountMinor,
          taxMinor: quote.taxMinor,
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

      // Deliberately unchanged by M8. This event's consumer is inventory, which
      // cares about product ids and quantities; adding money to it would be
      // payload for an imagined future.
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

      return order.id;
    });

    this.logger.log(
      `Order ${orderId} created: subtotal ${quote.subtotalMinor}, ` +
        `discount ${quote.discountMinor}, tax ${quote.taxMinor}, total ${quote.totalMinor} ` +
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
