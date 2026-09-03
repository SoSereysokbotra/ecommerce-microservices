import { Injectable, Logger } from '@nestjs/common';
import { CartLine, MergeAdjustment, mergeCarts } from './cart-merge';
import { GuestCartStore } from './guest-cart.store';
import { InventoryClient } from './inventory.client';
import { UserCartStore } from './user-cart.store';

/**
 * Who is asking. Exactly one of these decides where the cart lives:
 * a signed-in shopper's cart is in Postgres, a guest's is in Redis.
 */
export interface CartIdentity {
  /** From `x-user-id`, set by the gateway from a JWT it already verified. */
  userId?: string;
  /** From `x-cart-token`, supplied by the client. */
  guestToken?: string;
  correlationId?: string;
}

export interface CartView {
  items: CartLine[];
  /** Present only on the response that performed a merge, so the UI can explain it. */
  merged?: { adjustments: MergeAdjustment[] };
  /** Set when a guest cart was created or consumed; the client stores or clears it. */
  cartToken?: string | null;
}

/**
 * The one place that knows there are two stores.
 *
 * Every entry point runs `resolve()` first, which is also where the merge
 * happens — see `mergeIfNeeded`. Doing it there rather than in a dedicated
 * endpoint means the storefront cannot forget to call it, and it works no
 * matter which page the shopper happened to log in on.
 */
@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(
    private readonly userCarts: UserCartStore,
    private readonly guestCarts: GuestCartStore,
    private readonly inventory: InventoryClient,
  ) {}

  async getCart(identity: CartIdentity): Promise<CartView> {
    const resolved = await this.resolve(identity);

    if (resolved.userId) {
      return { ...resolved.view, items: await this.userCarts.getItems(resolved.userId) };
    }

    if (!resolved.guestToken) {
      // Nothing to read and no reason to mint a token for a plain look.
      return { items: [] };
    }

    return { ...resolved.view, items: await this.guestCarts.getItems(resolved.guestToken) };
  }

  async addItem(identity: CartIdentity, productId: string, qty: number): Promise<CartView> {
    const resolved = await this.resolve(identity, { createGuestToken: true });

    if (resolved.userId) {
      return {
        ...resolved.view,
        items: await this.userCarts.addItem(resolved.userId, productId, qty),
      };
    }

    const token = resolved.guestToken as string;
    return { ...resolved.view, items: await this.guestCarts.addItem(token, productId, qty) };
  }

  async setItemQty(identity: CartIdentity, productId: string, qty: number): Promise<CartView> {
    const resolved = await this.resolve(identity, { createGuestToken: true });

    if (resolved.userId) {
      return {
        ...resolved.view,
        items: await this.userCarts.setItemQty(resolved.userId, productId, qty),
      };
    }

    const token = resolved.guestToken as string;
    return { ...resolved.view, items: await this.guestCarts.setItemQty(token, productId, qty) };
  }

  async removeItem(identity: CartIdentity, productId: string): Promise<CartView> {
    return this.setItemQty(identity, productId, 0);
  }

  async clear(identity: CartIdentity): Promise<CartView> {
    const resolved = await this.resolve(identity);

    if (resolved.userId) {
      await this.userCarts.clear(resolved.userId);
      return { ...resolved.view, items: [] };
    }

    if (resolved.guestToken) {
      await this.guestCarts.discard(resolved.guestToken);
      return { items: [], cartToken: null };
    }

    return { items: [] };
  }

  /**
   * Work out which cart to act on, merging a guest cart into the user's the
   * first time both appear on the same request.
   */
  private async resolve(
    identity: CartIdentity,
    options: { createGuestToken?: boolean } = {},
  ): Promise<{ userId?: string; guestToken?: string; view: Partial<CartView> }> {
    const guestToken = this.guestCarts.isValidToken(identity.guestToken)
      ? identity.guestToken
      : undefined;

    if (identity.userId) {
      const view = guestToken
        ? await this.mergeIfNeeded(identity.userId, guestToken, identity)
        : {};
      return { userId: identity.userId, view };
    }

    if (guestToken) {
      return { guestToken, view: {} };
    }

    if (options.createGuestToken) {
      const minted = this.guestCarts.newToken();
      return { guestToken: minted, view: { cartToken: minted } };
    }

    return { view: {} };
  }

  /**
   * The mug problem: a guest with 2 logs into an account that already has 3.
   * Quantities are summed and capped at stock, then the guest cart is discarded
   * and the client is told to drop its token.
   */
  private async mergeIfNeeded(
    userId: string,
    guestToken: string,
    identity: CartIdentity,
  ): Promise<Partial<CartView>> {
    const guestItems = await this.guestCarts.getItems(guestToken);

    if (guestItems.length === 0) {
      // Nothing to merge, but the token is spent either way: this shopper is
      // signed in now, and leaving it live would resurrect an empty guest cart.
      await this.guestCarts.discard(guestToken);
      return { cartToken: null };
    }

    const userItems = await this.userCarts.getItems(userId);
    const productIds = [...new Set([...guestItems, ...userItems].map((line) => line.productId))];
    const stock = await this.inventory.stockFor(productIds, identity.correlationId);

    const { items, adjustments } = mergeCarts(guestItems, userItems, stock);

    await this.userCarts.replaceItems(userId, items);
    await this.guestCarts.discard(guestToken);

    this.logger.log(
      `Merged guest cart into ${userId}: ${items.length} lines, ${adjustments.length} adjustments`,
    );

    return { merged: { adjustments }, cartToken: null };
  }
}
