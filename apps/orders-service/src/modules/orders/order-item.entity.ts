import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { OrderEntity } from './order.entity';

@Entity({ name: 'order_items' })
export class OrderItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @ManyToOne(() => OrderEntity, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: OrderEntity;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  /**
   * Name, sku and price are copied from the catalog at purchase time rather
   * than looked up later. An order is a record of what was actually bought at
   * a price the customer agreed to; if the product is renamed or repriced
   * tomorrow, this order must not change.
   */
  @Column()
  sku: string;

  @Column()
  name: string;

  @Column({ type: 'integer' })
  qty: number;

  @Column({ name: 'unit_price_minor', type: 'integer' })
  unitPriceMinor: number;

  /** This line's share of every discount that applied to it. */
  @Column({ name: 'line_discount_minor', type: 'integer', default: 0 })
  lineDiscountMinor: number;

  /** Basis points, matching pricing-service: 725 is 7.25%. */
  @Column({ name: 'tax_rate_bp', type: 'integer', default: 0 })
  taxRateBp: number;

  /**
   * This line's share of its tax group's tax.
   *
   * Not an independently rounded figure: pricing rounds once per tax rate group
   * and then allocates that single number across the group's lines, so these
   * always sum back to the order's `tax_minor`. Recomputing one from
   * `unit_price_minor * tax_rate_bp` would not reproduce it, and would be wrong.
   */
  @Column({ name: 'tax_minor', type: 'integer', default: 0 })
  taxMinor: number;
}
