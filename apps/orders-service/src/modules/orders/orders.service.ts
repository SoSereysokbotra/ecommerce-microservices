import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { CORRELATION_ID_HEADER } from '@libs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import { OrderEntity, OrderStatus } from './order.entity';
import { OrderItemEntity } from './order-item.entity';
import { CreateOrderDto } from './dto/order.dto';

interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  priceMinor: number;
  currency: string;
  active: boolean;
}

/**
 * M2: checkout as a straight line of synchronous HTTP calls.
 *
 *   price from catalog  ->  reserve stock  ->  charge card  ->  confirm
 *
 * This is deliberately the wrong design, kept only long enough to demonstrate
 * why. Each call commits work in another service that this one cannot undo, so
 * any failure after the reservation leaves stock held for an order that will
 * never complete, and nothing in the system will ever release it.
 *
 * See docs/adr/0002-why-a-saga.md. M3 replaces these calls with events and an
 * outbox; M5 adds the saga and its compensations.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(OrderEntity)
    private readonly orders: Repository<OrderEntity>,
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async create(
    customerId: string,
    input: CreateOrderDto,
    correlationId?: string,
  ): Promise<OrderEntity> {
    // 1. Price the basket from the catalog.
    const priced = await this.priceItems(input, correlationId);
    const totalMinor = priced.reduce((sum, i) => sum + i.unitPriceMinor * i.qty, 0);
    const currency = priced[0].currency;

    // 2. Persist the order as PENDING so there is a record if a later step dies.
    const order = await this.orders.save(
      this.orders.create({
        customerId,
        status: OrderStatus.PENDING,
        currency,
        totalMinor,
        items: priced.map((i) =>
          Object.assign(new OrderItemEntity(), {
            productId: i.productId,
            sku: i.sku,
            name: i.name,
            qty: i.qty,
            unitPriceMinor: i.unitPriceMinor,
          }),
        ),
      }),
    );

    // 3. Reserve stock. Succeeds or throws; nothing here can undo it later.
    await this.reserveStock(order, priced, correlationId);

    // 4. Charge. THIS is the dangerous step: stock is already committed in
    //    another service's database, and if this throws, nothing releases it.
    try {
      const result = await this.charge(order, correlationId);

      if (result.status !== 'AUTHORIZED') {
        return this.markFailed(order, `Payment ${result.status.toLowerCase()}`);
      }
    } catch (error) {
      // The order is marked failed, but the reservation from step 3 stays.
      // There is no compensating call, and no background job to expire it.
      this.logger.error(
        `Payment failed for order ${order.id}; stock reserved in step 3 is now ` +
          `orphaned and will never be released [${correlationId}]`,
      );
      return this.markFailed(order, this.describe(error));
    }

    order.status = OrderStatus.CONFIRMED;
    return this.orders.save(order);
  }

  findOne(id: string, customerId: string): Promise<OrderEntity | null> {
    return this.orders.findOne({ where: { id, customerId } });
  }

  list(customerId: string): Promise<OrderEntity[]> {
    return this.orders.find({ where: { customerId }, order: { createdAt: 'DESC' }, take: 50 });
  }

  private async priceItems(
    input: CreateOrderDto,
    correlationId?: string,
  ): Promise<
    {
      productId: string;
      sku: string;
      name: string;
      qty: number;
      unitPriceMinor: number;
      currency: string;
    }[]
  > {
    const base = this.config.get<string>('catalogServiceUrl');
    const priced = [];

    for (const item of input.items) {
      const product = await this.get<CatalogProduct>(
        `${base}/api/v1/catalog/products/${item.productId}`,
        correlationId,
        `Product '${item.productId}' not found`,
      );

      if (!product.active) {
        throw new BadRequestException(`Product '${product.sku}' is not available`);
      }

      priced.push({
        productId: product.id,
        sku: product.sku,
        name: product.name,
        qty: item.qty,
        unitPriceMinor: product.priceMinor,
        currency: product.currency,
      });
    }

    const currencies = new Set(priced.map((i) => i.currency));
    if (currencies.size > 1) {
      throw new BadRequestException(
        `An order cannot mix currencies (got ${[...currencies].join(', ')})`,
      );
    }

    return priced;
  }

  private async reserveStock(
    order: OrderEntity,
    items: { productId: string; qty: number }[],
    correlationId?: string,
  ): Promise<void> {
    const base = this.config.get<string>('inventoryServiceUrl');

    try {
      await firstValueFrom(
        this.http.post(
          `${base}/api/v1/inventory/reserve`,
          { orderId: order.id, items: items.map(({ productId, qty }) => ({ productId, qty })) },
          { headers: this.headers(correlationId), timeout: 5000 },
        ),
      );
    } catch (error) {
      await this.markFailed(order, this.describe(error));
      throw new BadRequestException(this.describe(error));
    }
  }

  private async charge(
    order: OrderEntity,
    correlationId?: string,
  ): Promise<{ status: string; reference: string }> {
    const base = this.config.get<string>('paymentsServiceUrl');

    const response = await firstValueFrom(
      this.http.post<{ status: string; reference: string }>(
        `${base}/api/v1/payments/charge`,
        { orderId: order.id, amountMinor: order.totalMinor, currency: order.currency },
        { headers: this.headers(correlationId), timeout: 5000 },
      ),
    );

    return response.data;
  }

  private async get<T>(
    url: string,
    correlationId: string | undefined,
    notFound: string,
  ): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.get<T>(url, { headers: this.headers(correlationId), timeout: 5000 }),
      );
      return response.data;
    } catch (error) {
      if ((error as AxiosError).response?.status === 404) {
        throw new NotFoundException(notFound);
      }
      throw new BadRequestException(this.describe(error));
    }
  }

  private async markFailed(order: OrderEntity, reason: string): Promise<OrderEntity> {
    order.status = OrderStatus.FAILED;
    order.failureReason = reason;
    return this.orders.save(order);
  }

  private headers(correlationId?: string): Record<string, string> {
    return correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {};
  }

  private describe(error: unknown): string {
    const axiosError = error as AxiosError<{ message?: string | string[] }>;
    const body = axiosError.response?.data?.message;

    if (body) {
      return Array.isArray(body) ? body.join(', ') : body;
    }
    if (axiosError.code) {
      return `${axiosError.code}: ${axiosError.message}`;
    }
    return error instanceof Error ? error.message : String(error);
  }
}
