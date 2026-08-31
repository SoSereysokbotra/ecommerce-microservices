import { Column, Entity, PrimaryColumn, UpdateDateColumn, VersionColumn } from 'typeorm';

/**
 * One row per product.
 *
 * `availableQty` is what can still be reserved; `reservedQty` is held by
 * in-flight orders and is not yet deducted. Their sum is the physical stock.
 * M5's saga moves quantities between the two and back again on compensation.
 */
@Entity({ name: 'stock' })
export class StockEntity {
  @PrimaryColumn({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ name: 'available_qty', type: 'integer', default: 0 })
  availableQty: number;

  @Column({ name: 'reserved_qty', type: 'integer', default: 0 })
  reservedQty: number;

  /**
   * Optimistic lock. Two concurrent reservations for the last unit must not
   * both succeed; the second save throws and is retried against fresh state.
   * Unused until M5, but the column has to exist before there is data in it.
   */
  @VersionColumn()
  version: number;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
