import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { CORRELATION_ID_HEADER } from '@libs/common';
import { OutboxService } from '@libs/outbox';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { DataSource, Repository } from 'typeorm';
import { OrderEntity, OrderStatus } from './order.entity';
import { OrderItemEntity } from './order-item.entity';
import { CreateOrderDto } from './dto/order.dto';
import { OrderSagaService } from './order-saga.service';

interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  priceMinor: number;
  currency: string;
  active: boolean;
}

interface PricedLine {
  productId: string;
  sku: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
  currency: string;
}

/**
 * Order creation and reads.
 *
 * All saga transitions live in OrderSagaService; this class only creates the
 * order and starts the saga. Keeping them apart means the state machine can be
 * read in one file without the pricing and HTTP details around it.
 *
 * The catalog price lookup stays synchronous on purpose: it is a *read* before
 * anything is committed, so a failure rejects the request with nothing left
 * half-done. The calls that had to go were the ones changing another service's
 * state.
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
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async create(
    customerId: string,
    input: CreateOrderDto,
    correlationId?: string,
  ): Promise<OrderEntity> {
    const priced = await this.priceItems(input, correlationId);
    const totalMinor = priced.reduce((sum, i) => sum + i.unitPriceMinor * i.qty, 0);
    const currency = priced[0].currency;

    // The order row and its event commit together or not at all. That is the
    // point of the outbox: no window where an order exists with no event, or
    // an event exists for an order that rolled back.
    const orderId = await this.dataSource.transaction(async (manager) => {
      const order = await manager.save(
        manager.create(OrderEntity, {
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

      // Order, saga state and first event all commit together.
      await this.saga.start(manager, order.id, correlationId);

      await this.outbox.append(manager, {
        eventType: 'order.created',
        aggregateId: order.id,
        correlationId,
        payload: {
          orderId: order.id,
          customerId,
          currency,
          totalMinor,
          items: priced.map(({ productId, qty }) => ({ productId, qty })),
        },
      });

      return order.id;
    });

    this.logger.log(`Order ${orderId} created, awaiting reservation [${correlationId}]`);

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

  private async priceItems(input: CreateOrderDto, correlationId?: string): Promise<PricedLine[]> {
    const base = this.config.get<string>('catalogServiceUrl');
    const priced: PricedLine[] = [];

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

  private async get<T>(
    url: string,
    correlationId: string | undefined,
    notFound: string,
  ): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.get<T>(url, {
          headers: correlationId ? { [CORRELATION_ID_HEADER]: correlationId } : {},
          timeout: 5000,
        }),
      );
      return response.data;
    } catch (error) {
      if ((error as AxiosError).response?.status === 404) {
        throw new NotFoundException(notFound);
      }
      throw new BadRequestException(describe(error));
    }
  }
}

function describe(error: unknown): string {
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
