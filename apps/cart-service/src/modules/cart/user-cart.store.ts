import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { CartLine } from './cart-merge';
import { CartEntity } from './cart.entity';
import { CartItemEntity } from './cart-item.entity';

/**
 * The signed-in shopper's cart, in Postgres.
 *
 * Guest carts have their own store backed by Redis. Both are driven by the same
 * service layer, which is the whole point of keeping the interfaces this
 * similar: `CartLine[]` in, `CartLine[]` out, no storage detail leaking.
 *
 * Every mutation runs in one transaction so a cart is never observed
 * half-updated, and `replaceItems` exists because merging computes the whole
 * new cart at once rather than applying a diff.
 */
@Injectable()
export class UserCartStore {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async getItems(customerId: string): Promise<CartLine[]> {
    const items = await this.dataSource.getRepository(CartItemEntity).find({
      where: { cart: { customerId } },
      relations: { cart: true },
      order: { createdAt: 'ASC' },
    });

    return items.map((item) => ({ productId: item.productId, qty: item.qty }));
  }

  /** Add to an existing line rather than replacing it — "add to cart" twice means two. */
  async addItem(customerId: string, productId: string, qty: number): Promise<CartLine[]> {
    return this.dataSource.transaction(async (manager) => {
      const cart = await this.ensureCart(manager, customerId);
      const items = manager.getRepository(CartItemEntity);
      const existing = await items.findOne({ where: { cartId: cart.id, productId } });

      if (existing) {
        existing.qty += qty;
        await items.save(existing);
      } else {
        await items.save(items.create({ cartId: cart.id, productId, qty }));
      }

      await this.touch(manager, cart);
      return this.itemsOf(manager, cart.id);
    });
  }

  /** Set an absolute quantity. Zero removes the line, which is what the UI's stepper expects. */
  async setItemQty(customerId: string, productId: string, qty: number): Promise<CartLine[]> {
    return this.dataSource.transaction(async (manager) => {
      const cart = await this.ensureCart(manager, customerId);
      const items = manager.getRepository(CartItemEntity);

      if (qty <= 0) {
        await items.delete({ cartId: cart.id, productId });
      } else {
        const existing = await items.findOne({ where: { cartId: cart.id, productId } });
        if (existing) {
          existing.qty = qty;
          await items.save(existing);
        } else {
          await items.save(items.create({ cartId: cart.id, productId, qty }));
        }
      }

      await this.touch(manager, cart);
      return this.itemsOf(manager, cart.id);
    });
  }

  async removeItem(customerId: string, productId: string): Promise<CartLine[]> {
    return this.setItemQty(customerId, productId, 0);
  }

  /**
   * Replace the cart's contents wholesale. Used by the merge, which has already
   * decided the final quantities and must not re-apply "add" semantics.
   */
  async replaceItems(customerId: string, lines: readonly CartLine[]): Promise<CartLine[]> {
    return this.dataSource.transaction(async (manager) => {
      const cart = await this.ensureCart(manager, customerId);
      const items = manager.getRepository(CartItemEntity);

      await items.delete({ cartId: cart.id });
      for (const line of lines) {
        await items.save(
          items.create({ cartId: cart.id, productId: line.productId, qty: line.qty }),
        );
      }

      await this.touch(manager, cart);
      return this.itemsOf(manager, cart.id);
    });
  }

  /**
   * Empty the cart but keep the row. The order.created consumer calls this, and
   * keeping the row means `updated_at` still reflects real activity.
   */
  async clear(customerId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const cart = await manager.getRepository(CartEntity).findOne({ where: { customerId } });

      if (!cart) {
        return;
      }

      await manager.getRepository(CartItemEntity).delete({ cartId: cart.id });
      await this.touch(manager, cart);
    });
  }

  private async ensureCart(manager: EntityManager, customerId: string): Promise<CartEntity> {
    const carts = manager.getRepository(CartEntity);
    const existing = await carts.findOne({ where: { customerId } });

    if (existing) {
      return existing;
    }

    // customer_id is unique, so a concurrent first write loses the race and is
    // retried by reading the row the winner inserted.
    try {
      return await carts.save(carts.create({ customerId }));
    } catch {
      const raced = await carts.findOne({ where: { customerId } });
      if (!raced) {
        throw new Error(`could not create or find a cart for customer ${customerId}`);
      }
      return raced;
    }
  }

  /**
   * @UpdateDateColumn only fires on a real change, and the sweep depends on it.
   *
   * Clearing `abandonedAt` here is what makes the sweep repeatable: a shopper
   * who was flagged, came back, and drifted off again gets flagged a second
   * time instead of being permanently marked as already-notified.
   */
  private async touch(manager: EntityManager, cart: CartEntity): Promise<void> {
    await manager
      .getRepository(CartEntity)
      .update({ id: cart.id }, { updatedAt: new Date(), abandonedAt: null });
  }

  private async itemsOf(manager: EntityManager, cartId: string): Promise<CartLine[]> {
    const rows = await manager
      .getRepository(CartItemEntity)
      .find({ where: { cartId }, order: { createdAt: 'ASC' } });

    return rows.map((row) => ({ productId: row.productId, qty: row.qty }));
  }
}
