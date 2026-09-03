import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CartItemEntity } from './cart-item.entity';

/**
 * A signed-in shopper's cart. One row per customer, forever — it is emptied
 * rather than deleted when an order is placed, so `updatedAt` remains a useful
 * "last touched" signal for the abandonment sweep.
 *
 * Guest carts are deliberately **not** here. They live in Redis with a TTL,
 * because most are abandoned and would otherwise accumulate rows nobody reads.
 * See docs/M7_CART_PLAN.md §1.
 */
@Entity({ name: 'carts' })
export class CartEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Unique: a customer has exactly one cart. */
  @Column({ name: 'customer_id', type: 'uuid', unique: true })
  customerId: string;

  @OneToMany(() => CartItemEntity, (item) => item.cart, { cascade: true })
  items: CartItemEntity[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  /** Drives the abandonment sweep, so every mutation must touch it. */
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /**
   * When `cart.abandoned` was emitted for this cart, or null if it has not
   * been. Cleared on every mutation, so a shopper who returns and later drifts
   * off is flagged again rather than never again.
   */
  @Column({ name: 'abandoned_at', type: 'timestamptz', nullable: true })
  abandonedAt: Date | null;
}
