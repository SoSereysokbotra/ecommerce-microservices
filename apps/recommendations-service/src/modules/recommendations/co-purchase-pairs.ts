/**
 * A pair of co-purchased products to increment in the recommendation graph.
 *
 * Symmetric directed rows per M14 plan §6:
 * A basket with products A and B produces (A, B) and (B, A).
 */
export interface CoPurchasePair {
  productId: string;
  recommendedProductId: string;
}

/**
 * One line of `order.confirmed`'s `items[]`, as orders-service emits it since
 * M13 step 1. Only `productId` is read here — `sku` and `qty` travel on the
 * event for other consumers, and a basket of three mugs is still one mug for
 * the purpose of "what goes with what".
 */
export interface OrderItemInput {
  productId: string;
}

/**
 * Pure function deriving symmetric co-purchase pairs from an order's items.
 *
 * Requirements (M14 plan §6, §13):
 * 1. Deduplicates product IDs (two lines of the same product are one product).
 * 2. Returns [] for 0 or 1 distinct products (no co-purchases possible).
 * 3. Emits both directions for each unordered pair of distinct products.
 * 4. Ensures no pair has a === b (no self-pairs).
 * 5. Pure in-memory computation: no database, no I/O.
 *
 * The nested loop is O(n²), which is correct for the input: an order has a
 * handful of lines, and the number of pairs is inherently n(n−1). A basket
 * large enough for that to matter is a different problem than this one.
 */
export function extractCoPurchasePairs(items: OrderItemInput[]): CoPurchasePair[] {
  if (!items || items.length === 0) {
    return [];
  }

  // Deduplicate product IDs while preserving first-seen order
  const seen = new Set<string>();
  const productIds: string[] = [];

  for (const item of items) {
    const id = item?.productId;
    if (typeof id === 'string' && id.trim().length > 0 && !seen.has(id)) {
      seen.add(id);
      productIds.push(id);
    }
  }

  // Baskets with 0 or 1 distinct products cannot form co-purchase pairs
  if (productIds.length < 2) {
    return [];
  }

  const pairs: CoPurchasePair[] = [];
  for (let i = 0; i < productIds.length; i++) {
    for (let j = 0; j < productIds.length; j++) {
      if (i !== j) {
        pairs.push({
          productId: productIds[i],
          recommendedProductId: productIds[j],
        });
      }
    }
  }

  return pairs;
}
