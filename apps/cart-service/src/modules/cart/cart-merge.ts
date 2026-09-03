/**
 * Merging a guest cart into a signed-in cart.
 *
 * This is the one piece of M7 with real decisions in it, so it is a pure
 * function: no Redis, no Postgres, no HTTP. Everything it needs is an argument,
 * which is what makes the table of cases in docs/M7_CART_PLAN.md §6 testable
 * without standing anything up.
 *
 * The rule is **sum the quantities**, then cap at available stock. Summing means
 * nothing the shopper picked ever silently disappears, which is the behaviour
 * that is easiest to explain to someone who is confused about their own cart.
 */

export interface CartLine {
  productId: string;
  qty: number;
}

/**
 * Available quantity per product id, as reported by inventory-service.
 *
 * A product **missing from this map has no stock row at all** — it was removed
 * from the catalog since it was added to the cart — and is dropped. That is a
 * different situation from a product present with `0`, which is merely sold out
 * for now, so the two are reported with different reasons.
 */
export type StockLevels = ReadonlyMap<string, number>;

export type MergeReason = 'capped_to_stock' | 'out_of_stock' | 'unavailable';

export interface MergeAdjustment {
  productId: string;
  /** What summing the two carts asked for, before stock was considered. */
  requestedQty: number;
  /** What survived. Zero means the line was dropped. */
  finalQty: number;
  reason: MergeReason;
}

export interface MergeResult {
  items: CartLine[];
  /**
   * Everything that did not survive as requested. The caller shows this to the
   * shopper: a cart that quietly loses items is worse than one that explains
   * itself.
   */
  adjustments: MergeAdjustment[];
}

/**
 * Merge a guest cart into a user's cart.
 *
 * @param stock Available quantities, or `null` when inventory could not be
 *   reached. On `null` the merge proceeds **without capping** — failing a login
 *   because a stock lookup timed out would be a worse outcome than a cart that
 *   is briefly too optimistic, and the order path re-checks stock anyway.
 *
 * The cap is advisory in every case. Stock is only genuinely held during the
 * saga's reservation step, so two shoppers can both merge to the last six units;
 * whoever checks out second gets the existing "insufficient stock" rejection.
 * Do not mistake this for a reservation.
 */
export function mergeCarts(
  guestItems: readonly CartLine[],
  userItems: readonly CartLine[],
  stock: StockLevels | null,
): MergeResult {
  // User lines first so the merged cart keeps the order the shopper already saw,
  // with anything new from the guest session appended.
  const summed = new Map<string, number>();
  for (const line of [...userItems, ...guestItems]) {
    // Non-positive quantities cannot come through the DTOs, but a guest cart is
    // JSON in Redis that an older build may have written, so treat it as input
    // rather than trusting it.
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      continue;
    }
    summed.set(line.productId, (summed.get(line.productId) ?? 0) + line.qty);
  }

  const items: CartLine[] = [];
  const adjustments: MergeAdjustment[] = [];

  for (const [productId, requestedQty] of summed) {
    if (stock === null) {
      items.push({ productId, qty: requestedQty });
      continue;
    }

    const available = stock.get(productId);

    if (available === undefined) {
      adjustments.push({ productId, requestedQty, finalQty: 0, reason: 'unavailable' });
      continue;
    }

    if (available <= 0) {
      adjustments.push({ productId, requestedQty, finalQty: 0, reason: 'out_of_stock' });
      continue;
    }

    if (requestedQty > available) {
      items.push({ productId, qty: available });
      adjustments.push({
        productId,
        requestedQty,
        finalQty: available,
        reason: 'capped_to_stock',
      });
      continue;
    }

    items.push({ productId, qty: requestedQty });
  }

  return { items, adjustments };
}
