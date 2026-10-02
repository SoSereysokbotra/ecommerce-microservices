import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * "This customer bought this product." The right to review, as a row.
 *
 * Written **only** by consuming `order.confirmed` — the saga's terminal
 * success, emitted in the same transaction as the status change (M9). Nothing
 * else creates one, and there is no API that does: an authorisation derived
 * from an event is the point of M13. See docs/M13_REVIEWS_PLAN.md §1.
 *
 * One row per (customer, product, order), so a customer who buys the same mug
 * twice has two rows — a fact, not a duplicate. The UNIQUE is what makes a
 * republished `order.confirmed` with a *new* event id harmless, the same
 * belt-and-braces shipping-service uses for shipments: the `processed_events`
 * marker catches redelivery, the constraint catches republication.
 */
@Entity({ name: 'purchases' })
@Unique('UQ_purchases_customer_product_order', ['customerId', 'productId', 'orderId'])
@Index('IDX_purchases_customer_product', ['customerId', 'productId'])
export class PurchaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  /**
   * Copied from the event. Not needed to answer "may this customer review",
   * but a support conversation about one is far easier with a SKU than a
   * pair of UUIDs — and it is already frozen on `order_items`.
   */
  @Column()
  sku: string;

  @Column({ type: 'integer' })
  qty: number;

  /** When the order was confirmed, as this service learned of it. */
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
