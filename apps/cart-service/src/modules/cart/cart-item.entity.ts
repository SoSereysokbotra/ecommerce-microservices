import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { CartEntity } from './cart.entity';

/**
 * One line of a signed-in cart.
 *
 * Note what is **not** here: no price, no product name. The cart holds only
 * what the shopper chose. Prices are read from catalog when the order is
 * placed, which is the existing deliberate decision recorded in handoff §7 —
 * a cart that remembers a price is a cart that can show a stale one.
 */
@Entity({ name: 'cart_items' })
@Unique('UQ_cart_items_cart_product', ['cartId', 'productId'])
export class CartItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'cart_id', type: 'uuid' })
  cartId: string;

  @ManyToOne(() => CartEntity, (cart) => cart.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cart_id' })
  cart: CartEntity;

  @Column({ name: 'product_id', type: 'uuid' })
  productId: string;

  @Column({ name: 'qty', type: 'integer' })
  qty: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
