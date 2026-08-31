import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { StockEntity } from './stock.entity';

@Injectable()
export class StockService {
  constructor(
    @InjectRepository(StockEntity)
    private readonly stock: Repository<StockEntity>,
    private readonly dataSource: DataSource,
  ) {}

  list(productIds?: string[]): Promise<StockEntity[]> {
    if (productIds && productIds.length > 0) {
      return this.stock.find({ where: { productId: In(productIds) } });
    }
    return this.stock.find({ order: { updatedAt: 'DESC' }, take: 200 });
  }

  async findOne(productId: string): Promise<StockEntity> {
    const row = await this.stock.findOne({ where: { productId } });
    if (!row) {
      throw new NotFoundException(`No stock record for product '${productId}'`);
    }
    return row;
  }

  /**
   * Applies a signed change to available quantity.
   *
   * Creates the row when absent so seeding and first receipt are the same
   * operation. Refuses to drive stock negative — the database has a check
   * constraint too, but a 400 explains the problem better than a 500.
   */
  async adjust(productId: string, delta: number): Promise<StockEntity> {
    const existing = await this.stock.findOne({ where: { productId } });

    if (!existing) {
      if (delta < 0) {
        throw new NotFoundException(`No stock record for product '${productId}'`);
      }
      return this.stock.save(this.stock.create({ productId, availableQty: delta }));
    }

    const next = existing.availableQty + delta;
    if (next < 0) {
      throw new BadRequestException(
        `Cannot remove ${Math.abs(delta)} units: only ${existing.availableQty} available`,
      );
    }

    existing.availableQty = next;
    return this.stock.save(existing);
  }

  /**
   * Moves quantity from available to reserved for every item in an order.
   *
   * All-or-nothing within this service: one transaction, so a shortfall on the
   * third item does not leave the first two reserved.
   *
   * NOTE (M2): the reservation is recorded only as a quantity on the stock row.
   * There is no reservation record, no order linkage, and no expiry — so if the
   * order never completes, this stock is held forever with nothing to release
   * it. That is deliberate: it is the failure ADR-0002 documents. M5 replaces
   * this with a reservations table carrying an order id and an expiry.
   */
  async reserve(items: { productId: string; qty: number }[]): Promise<StockEntity[]> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(StockEntity);
      const updated: StockEntity[] = [];

      for (const item of items) {
        const row = await repo.findOne({ where: { productId: item.productId } });

        if (!row) {
          throw new NotFoundException(`No stock record for product '${item.productId}'`);
        }

        if (row.availableQty < item.qty) {
          throw new ConflictException(
            `Insufficient stock for product '${item.productId}': ` +
              `requested ${item.qty}, available ${row.availableQty}`,
          );
        }

        row.availableQty -= item.qty;
        row.reservedQty += item.qty;
        updated.push(await repo.save(row));
      }

      return updated;
    });
  }

  async set(productId: string, availableQty: number): Promise<StockEntity> {
    const existing = await this.stock.findOne({ where: { productId } });

    if (!existing) {
      return this.stock.save(this.stock.create({ productId, availableQty }));
    }

    existing.availableQty = availableQty;
    return this.stock.save(existing);
  }
}
