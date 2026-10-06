import { extractCoPurchasePairs } from '../src/modules/recommendations/co-purchase-pairs';

describe('extractCoPurchasePairs', () => {
  it('returns [] for 0 items', () => {
    expect(extractCoPurchasePairs([])).toEqual([]);
  });

  it('returns [] for 1 item', () => {
    expect(extractCoPurchasePairs([{ productId: 'prod-a' }])).toEqual([]);
  });

  it('deduplicates lines of the same product and returns [] if distinct count < 2', () => {
    const duplicateItems = [
      { productId: 'prod-a' },
      { productId: 'prod-a' },
      { productId: 'prod-a' },
    ];
    expect(extractCoPurchasePairs(duplicateItems)).toEqual([]);
  });

  it('deduplicates lines in a multi-product basket before generating pairs', () => {
    const itemsWithDuplicates = [
      { productId: 'prod-a' },
      { productId: 'prod-b' },
      { productId: 'prod-a' },
    ];
    const pairs = extractCoPurchasePairs(itemsWithDuplicates);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual([
      { productId: 'prod-a', recommendedProductId: 'prod-b' },
      { productId: 'prod-b', recommendedProductId: 'prod-a' },
    ]);
  });

  it('generates 2 symmetric rows for 2 distinct items', () => {
    const items = [{ productId: 'prod-a' }, { productId: 'prod-b' }];
    const pairs = extractCoPurchasePairs(items);

    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual([
      { productId: 'prod-a', recommendedProductId: 'prod-b' },
      { productId: 'prod-b', recommendedProductId: 'prod-a' },
    ]);
  });

  it('generates 6 symmetric rows for 3 distinct items', () => {
    const items = [{ productId: 'prod-a' }, { productId: 'prod-b' }, { productId: 'prod-c' }];
    const pairs = extractCoPurchasePairs(items);

    expect(pairs).toHaveLength(6);
    expect(pairs).toEqual([
      { productId: 'prod-a', recommendedProductId: 'prod-b' },
      { productId: 'prod-a', recommendedProductId: 'prod-c' },
      { productId: 'prod-b', recommendedProductId: 'prod-a' },
      { productId: 'prod-b', recommendedProductId: 'prod-c' },
      { productId: 'prod-c', recommendedProductId: 'prod-a' },
      { productId: 'prod-c', recommendedProductId: 'prod-b' },
    ]);
  });

  it('ensures no pair has a === b', () => {
    const items = [
      { productId: 'prod-1' },
      { productId: 'prod-2' },
      { productId: 'prod-3' },
      { productId: 'prod-4' },
    ];
    const pairs = extractCoPurchasePairs(items);

    expect(pairs).toHaveLength(12);
    for (const pair of pairs) {
      expect(pair.productId).not.toBe(pair.recommendedProductId);
    }
  });
});
