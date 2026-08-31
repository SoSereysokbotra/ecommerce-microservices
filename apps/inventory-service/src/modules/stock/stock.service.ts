import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { StockEntity } from './stock.entity';

@Injectable()
export class StockService {
  constructor(
    @InjectRepository(StockEntity)
    private readonly stock: Repository<StockEntity>,
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

  async set(productId: string, availableQty: number): Promise<StockEntity> {
    const existing = await this.stock.findOne({ where: { productId } });

    if (!existing) {
      return this.stock.save(this.stock.create({ productId, availableQty }));
    }

    existing.availableQty = availableQty;
    return this.stock.save(existing);
  }
}
