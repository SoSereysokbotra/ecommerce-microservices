import { CartLine, StockLevels, mergeCarts } from '../src/modules/cart/cart-merge';

/**
 * The merge table from docs/M7_CART_PLAN.md §6, plus the cases that only exist
 * because a guest cart is untrusted JSON out of Redis.
 *
 * The rule under test: sum both carts, then cap at available stock.
 */
describe('mergeCarts', () => {
  const stockOf = (levels: Record<string, number>): StockLevels => new Map(Object.entries(levels));

  const line = (productId: string, qty: number): CartLine => ({ productId, qty });

  describe('the eight cases from the plan', () => {
    it('carries over a product that is only in the guest cart', () => {
      const result = mergeCarts([line('mug', 2)], [], stockOf({ mug: 10 }));

      expect(result.items).toEqual([line('mug', 2)]);
      expect(result.adjustments).toEqual([]);
    });

    it('leaves a product that is only in the user cart alone', () => {
      const result = mergeCarts([], [line('mug', 3)], stockOf({ mug: 10 }));

      expect(result.items).toEqual([line('mug', 3)]);
      expect(result.adjustments).toEqual([]);
    });

    it('sums a product present in both carts: 2 + 3 = 5', () => {
      const result = mergeCarts([line('mug', 2)], [line('mug', 3)], stockOf({ mug: 10 }));

      expect(result.items).toEqual([line('mug', 5)]);
      expect(result.adjustments).toEqual([]);
    });

    it('caps the sum at available stock: 4 + 4 with 6 in stock becomes 6', () => {
      const result = mergeCarts([line('mug', 4)], [line('mug', 4)], stockOf({ mug: 6 }));

      expect(result.items).toEqual([line('mug', 6)]);
      expect(result.adjustments).toEqual([
        { productId: 'mug', requestedQty: 8, finalQty: 6, reason: 'capped_to_stock' },
      ]);
    });

    it('drops a product that is out of stock, and says so', () => {
      const result = mergeCarts([line('mug', 2)], [], stockOf({ mug: 0 }));

      expect(result.items).toEqual([]);
      expect(result.adjustments).toEqual([
        { productId: 'mug', requestedQty: 2, finalQty: 0, reason: 'out_of_stock' },
      ]);
    });

    it('leaves the user cart unchanged when the guest cart is empty', () => {
      const result = mergeCarts(
        [],
        [line('mug', 3), line('cable', 1)],
        stockOf({ mug: 10, cable: 5 }),
      );

      expect(result.items).toEqual([line('mug', 3), line('cable', 1)]);
      expect(result.adjustments).toEqual([]);
    });

    it('adopts the guest cart wholesale when the user cart is empty', () => {
      const result = mergeCarts(
        [line('mug', 2), line('cable', 1)],
        [],
        stockOf({ mug: 10, cable: 5 }),
      );

      expect(result.items).toEqual([line('mug', 2), line('cable', 1)]);
      expect(result.adjustments).toEqual([]);
    });

    it('drops a product that no longer exists in the catalog, with a distinct reason', () => {
      // No stock row at all, as opposed to a row reading zero.
      const result = mergeCarts([line('discontinued', 2)], [], stockOf({ mug: 10 }));

      expect(result.items).toEqual([]);
      expect(result.adjustments).toEqual([
        { productId: 'discontinued', requestedQty: 2, finalQty: 0, reason: 'unavailable' },
      ]);
    });
  });

  describe('ordering', () => {
    it('keeps the user cart order and appends guest-only products', () => {
      const result = mergeCarts(
        [line('sticker', 1), line('mug', 1)],
        [line('mug', 1), line('cable', 1)],
        stockOf({ mug: 10, cable: 10, sticker: 10 }),
      );

      // mug and cable were already on screen in that order; sticker is new.
      expect(result.items.map((i) => i.productId)).toEqual(['mug', 'cable', 'sticker']);
      expect(result.items).toContainEqual(line('mug', 2));
    });
  });

  describe('when inventory cannot be reached', () => {
    it('merges without capping rather than failing the login', () => {
      const result = mergeCarts([line('mug', 40)], [line('mug', 40)], null);

      expect(result.items).toEqual([line('mug', 80)]);
      expect(result.adjustments).toEqual([]);
    });

    it('keeps products it could not have validated', () => {
      const result = mergeCarts([line('discontinued', 1)], [], null);

      expect(result.items).toEqual([line('discontinued', 1)]);
    });
  });

  describe('untrusted guest-cart JSON', () => {
    it('ignores non-positive quantities', () => {
      const result = mergeCarts(
        [line('mug', 0), line('cable', -3)],
        [line('mug', 2)],
        stockOf({ mug: 10, cable: 10 }),
      );

      expect(result.items).toEqual([line('mug', 2)]);
    });

    it('ignores fractional quantities', () => {
      const result = mergeCarts([line('mug', 1.5)], [line('mug', 2)], stockOf({ mug: 10 }));

      expect(result.items).toEqual([line('mug', 2)]);
    });

    it('collapses duplicate lines for the same product within one cart', () => {
      const result = mergeCarts(
        [line('mug', 1), line('mug', 2)],
        [line('mug', 3)],
        stockOf({ mug: 10 }),
      );

      expect(result.items).toEqual([line('mug', 6)]);
    });

    it('returns an empty cart when both sides are empty', () => {
      const result = mergeCarts([], [], stockOf({}));

      expect(result.items).toEqual([]);
      expect(result.adjustments).toEqual([]);
    });
  });

  describe('purity', () => {
    it('does not mutate its inputs', () => {
      const guest = [line('mug', 2)];
      const user = [line('mug', 3)];

      mergeCarts(guest, user, stockOf({ mug: 4 }));

      expect(guest).toEqual([line('mug', 2)]);
      expect(user).toEqual([line('mug', 3)]);
    });
  });
});
