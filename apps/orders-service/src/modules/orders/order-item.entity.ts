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
}
